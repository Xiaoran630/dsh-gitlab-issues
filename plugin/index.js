/**
 * dsh-gitlab-issues —— Host 半。
 *
 * 职责：
 *  1. 从会话 cwd 探测工作区仓库（只读 .git/config，不跑 git 命令），命中公司 GitLab 才工作；
 *  2. 拉取该项目议题并缓存（系统提示注入要同步读缓存，不能在里面 await）；
 *  3. 只对命中公司仓库的会话在 agent.ctx 上注册 4 个工具（列表/详情/建议题/写操作）；
 *  4. 给 Web 界面提供同源只读接口，以及评论/关闭这类机械写操作；
 *  5. 注入一小段工作区上下文与规范要点。
 *
 * 明确边界：插件内没有任何模型调用。"新建议题"由 DSH agent 调 gitlab_issue_create 完成；
 * 本体不引用 F:\DSH_Work\gitlab-issue-bot 的任何代码（只按行为对齐重写了少数纯逻辑）。
 */

import {
  createGitLabApi,
  toIssueSummary,
  GitLabApiError,
  GitLabTokenMissingError,
} from './lib/gitlab.js'
import { detectCompanyRepo, findRepo, listRepoRemotes } from './lib/git-detect.js'
import {
  DEFAULT_COMPANY_HOSTS,
  RULES_SUMMARY,
  normalizeHost,
  nextFriday,
  validateCreateIssue,
} from './lib/company-rules.js'
import { LabelCatalog } from './lib/labels.js'
import { buildWorkPrompt, buildCreateIssuePrompt, buildCreateIssueIntro } from './lib/prompt.js'
import { readSettings, writeSettings, publicSettings, TOKEN_REF } from './lib/settings.js'

export const name = 'dsh-gitlab-issues'
export const inject = ['tools']

const LOG_PREFIX = '[dsh-gitlab-issues]'
const ROUTE = '/dsh-gitlab-issues'
const CONTEXT_ORDER = 76
const SECTION_ORDER = 41

const TTL = {
  repo: 60_000,
  project: 5 * 60_000,
  issues: 60_000,
  known: 5 * 60_000,
}

const MAX_ISSUES_PAGES = 2
const DEFAULT_LIST_LIMIT = 30

export function apply(ctx, config = {}) {
  const log = (message, detail) => {
    if (detail === undefined) console.log(LOG_PREFIX, message)
    else console.log(LOG_PREFIX, message, detail instanceof Error ? detail.message : detail)
  }
  const warn = (message, detail) => {
    console.warn(LOG_PREFIX, message, detail instanceof Error ? detail.message : detail ?? '')
  }

  const repoCache = new Map()
  const projectCache = new Map()
  const issuesCache = new Map()
  let knownProjects = { value: null, at: 0 }
  const agentStates = new Map()

  const api = createGitLabApi({ readToken, log })

  // ------------------------------------------------------------------ 设置 / 令牌

  function currentSettings() {
    const settings = readSettings()
    if (Array.isArray(config?.hosts) && config.hosts.length > 0) {
      return { ...settings, hosts: Array.from(new Set([...settings.hosts, ...config.hosts.map(String)])) }
    }
    return settings
  }

  async function readToken() {
    const settings = currentSettings()
    const ref = String(settings.tokenRef || TOKEN_REF).trim() || TOKEN_REF

    const credentials = ctx.get('credentials')
    if (credentials && typeof credentials.resolve === 'function') {
      try {
        const resolved = await credentials.resolve(ref)
        const value = typeof resolved === 'string' ? resolved : resolved?.value
        if (value && String(value).trim()) return String(value).trim()
      } catch (error) {
        warn('凭据服务读取失败，回退到本地设置', error)
      }
    }

    const envValue = process.env[ref] || process.env.GITLAB_TOKEN
    if (envValue && String(envValue).trim()) return String(envValue).trim()

    return String(settings.token || '').trim()
  }

  async function tokenConfigured() {
    try {
      return !!(await readToken())
    } catch {
      return false
    }
  }

  // ------------------------------------------------------------------ 探测与缓存

  const repoKey = (repo) => `${repo.hostPort}|${repo.projectPath}`

  function detectRepoCached(cwd) {
    if (!cwd) return null
    const cached = repoCache.get(cwd)
    if (cached && Date.now() - cached.at < TTL.repo) return cached.value
    let value = null
    try {
      value = detectCompanyRepo(cwd, currentSettings().hosts)
    } catch (error) {
      warn(`仓库探测失败：${cwd}`, error)
      value = null
    }
    repoCache.set(cwd, { value, at: Date.now() })
    return value
  }

  async function getProjectCached(repo, force = false) {
    const key = repoKey(repo)
    const cached = projectCache.get(key)
    if (!force && cached && Date.now() - cached.at < TTL.project) return cached.value

    const [project, labels, me] = await Promise.all([
      api.getProject(repo.baseUrl, repo.projectPath).catch((error) => {
        if (error instanceof GitLabApiError && error.status === 404) throw error
        warn(`读取项目失败：${repo.projectPath}`, error)
        return null
      }),
      api.getLabels(repo.baseUrl, repo.projectPath).catch(() => []),
      api.getCurrentUser(repo.baseUrl).catch(() => null),
    ])

    const value = {
      project,
      catalog: LabelCatalog.from(labels),
      labels,
      me: me ? { id: Number(me.id), name: String(me.name ?? ''), username: String(me.username ?? '') } : null,
    }
    projectCache.set(key, { value, at: Date.now() })
    return value
  }

  function issuesCacheEntry(repo) {
    return issuesCache.get(repoKey(repo))
  }

  async function fetchIssues(repo, { state = 'opened' } = {}) {
    const perPage = 100
    let page = 1
    const items = []
    let total = 0
    while (page <= MAX_ISSUES_PAGES) {
      const result = await api.listIssues(repo.baseUrl, repo.projectPath, { state, page, perPage })
      total = result.total
      items.push(...result.items)
      if (page >= result.totalPages || result.items.length === 0) break
      page += 1
    }
    return { items: items.map(toIssueSummary).filter(Boolean), total, fetchedAt: Date.now() }
  }

  async function refreshIssues(repo, { force = false, state = 'opened' } = {}) {
    const key = repoKey(repo)
    const cached = issuesCache.get(key)
    if (!force && cached && cached.value && Date.now() - cached.at < TTL.issues) return cached.value

    try {
      const value = await fetchIssues(repo, { state })
      issuesCache.set(key, { value, at: Date.now(), error: null })
      return value
    } catch (error) {
      const message = describeError(error)
      if (cached?.value) {
        issuesCache.set(key, { value: cached.value, at: cached.at, error: message })
        warn(`议题刷新失败（保留上次结果）：${repo.projectPath}`, message)
        return cached.value
      }
      issuesCache.set(key, { value: null, at: Date.now(), error: message })
      warn(`议题读取失败：${repo.projectPath}`, message)
      return null
    }
  }

  async function scanKnownProjects({ force = false } = {}) {
    if (!force && knownProjects.value && Date.now() - knownProjects.at < TTL.known) return knownProjects.value

    const roots = new Set()
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) {
          if (workspace?.path) roots.add(workspace.path)
        }
      } catch (error) {
        warn('读取工作区注册表失败', error)
      }
    }

    const projects = []
    const hasToken = await tokenConfigured()
    for (const root of roots) {
      const repo = detectRepoCached(root)
      if (!repo) continue
      let title = repo.projectPath
      let projectId = null
      if (hasToken) {
        try {
          const info = await getProjectCached(repo)
          if (info?.project) {
            title = String(info.project.name ?? repo.projectPath)
            projectId = info.project.id ?? null
          }
        } catch (error) {
          warn(`项目信息读取失败：${repo.projectPath}`, error)
        }
      }
      projects.push({
        workspacePath: root,
        projectPath: repo.projectPath,
        baseUrl: repo.baseUrl,
        webUrl: repo.webUrl,
        remoteName: repo.remoteName,
        projectId,
        title,
      })
    }

    projects.sort((a, b) => a.projectPath.localeCompare(b.projectPath))
    knownProjects = { value: projects, at: Date.now() }
    return projects
  }

  function sessionCwd(sessionId) {
    if (!sessionId) return undefined
    const sessions = ctx.get('sessions')
    if (sessions && typeof sessions.get === 'function') {
      try {
        const session = sessions.get(sessionId)
        const cwd = session?.header?.cwd
        if (cwd) return cwd
      } catch (error) {
        warn('读取会话 cwd 失败', error)
      }
    }
    const registry = ctx.get('workspaceRegistry')
    if (registry && typeof registry.list === 'function') {
      try {
        for (const workspace of registry.list()) {
          if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) return workspace.path
        }
      } catch { /* ignore */ }
    }
    return undefined
  }

  function describeError(error) {
    if (error instanceof GitLabTokenMissingError) {
      return '未配置 GitLab 令牌：请在「设置 → GitLab 议题」粘贴个人访问令牌（PAT），或设置环境变量 GITLAB_TOKEN。'
    }
    if (error instanceof GitLabApiError) {
      if (error.status === 401) return 'GitLab 令牌无效或已过期，请在「设置 → GitLab 议题」重新粘贴。'
      if (error.status === 403) return '当前账号没有该操作的权限。'
      if (error.status === 404) return '项目或议题不存在，或当前账号无权访问。'
      if (error.status === 429) return 'GitLab 限流（429），稍后重试。'
      return error.message
    }
    return error instanceof Error ? error.message : String(error)
  }

  function resolveAgentState(agentId) {
    const existing = agentStates.get(agentId)
    if (existing) return existing
    const cwd = sessionCwd(agentId)
    if (!cwd) return null
    const repo = detectRepoCached(cwd)
    if (!repo) return null
    const state = { id: agentId, cwd, repo, disposers: [] }
    agentStates.set(agentId, state)
    return state
  }

  // ------------------------------------------------------------------ 提示注入

  function workspaceContextText(agentId) {
    const settings = currentSettings()
    if (!settings.enabled || !settings.injectPrompt) return ''
    const state = agentStates.get(agentId)
    if (!state) return ''

    const entry = issuesCacheEntry(state.repo)
    if (!entry || !entry.value) return ''

    const opened = entry.value.items.filter((issue) => issue.state === 'opened')
    const header = `本工作区 = 公司 GitLab 项目 ${state.repo.projectPath}（${state.repo.baseUrl}）。`
    if (opened.length === 0) return `${header}当前没有打开中的议题。`

    const lines = opened.slice(0, 12).map((issue) => {
      const labels = issue.labels.length > 0 ? `（${issue.labels.join('、')}）` : ''
      const due = issue.due_date ? `,截止 ${issue.due_date}` : ''
      const who = issue.assignees.length > 0 ? `,指派 ${issue.assignees.map((a) => a.name || a.username).join('/')}` : ''
      return `#${issue.iid} ${issue.title}${labels}${who}${due}`
    })
    const more = opened.length > lines.length ? `\n其余 ${opened.length - lines.length} 条用 gitlab_issues 查询。` : ''
    return `${header}当前打开议题 ${opened.length} 条：\n${lines.join('\n')}${more}`
  }

  function registerAgentWorkspace(agent) {
    if (!agent) return true
    if (agentStates.has(agent.id)) return true
    const cwd = sessionCwd(agent.id)
    if (!cwd) return false
    const repo = detectRepoCached(cwd)
    if (!repo) return true

    const state = { id: agent.id, cwd, repo, disposers: [] }
    agentStates.set(agent.id, state)

    // 后台预热缓存（不阻塞会话创建）
    void refreshIssues(repo, { force: false }).catch(() => {})

    const settings = currentSettings()
    const scopedCtx = agent.ctx ?? ctx
    const prompt = typeof scopedCtx.get === 'function' ? scopedCtx.get('systemPrompt') : ctx.get('systemPrompt')
    const tools = typeof scopedCtx.get === 'function' ? scopedCtx.get('tools') : ctx.get('tools')

    const disposers = []

    try {
      if (prompt && typeof prompt.context === 'function') {
        disposers.push(prompt.context({
          name: 'gitlab-issues:workspace',
          order: CONTEXT_ORDER,
          text: () => workspaceContextText(agent.id),
        }))
        disposers.push(prompt.section({
          name: 'gitlab-issues:rules',
          order: SECTION_ORDER,
          text: RULES_SUMMARY,
        }))
      }
    } catch (error) {
      warn('提示注入注册失败', error)
    }

    if (settings.enabled && tools && typeof tools.register === 'function') {
      for (const definition of buildAgentTools(agent, state)) {
        try {
          disposers.push(tools.register(definition))
        } catch (error) {
          warn(`工具注册失败：${definition.name}`, error)
        }
      }
    }

    state.disposers = disposers
    log(`会话工作区命中公司 GitLab：${repo.projectPath}（${cwd}），已注册 ${disposers.length} 项`)
    return true
  }

  function releaseAgent(agentId) {
    const state = agentStates.get(agentId)
    if (!state) return
    for (const dispose of state.disposers) {
      try { dispose() } catch { /* ignore */ }
    }
    agentStates.delete(agentId)
  }

  ctx.on('agent/created', (payload) => {
    const agent = payload?.agent
    try {
      if (!agent) return
      if (registerAgentWorkspace(agent) !== true) {
        // 会话头还没落定时重试一次（幂等：已注册的会直接返回）
        ctx.effect(() => {
          const timer = setTimeout(() => {
            try { registerAgentWorkspace(agent) } catch { /* ignore */ }
          }, 1500)
          return () => clearTimeout(timer)
        }, 'dsh-gitlab-issues: late workspace detect')
      }
    } catch (error) {
      warn('agent/created 处理失败', error)
    }
  })

  ctx.on('agent/disposed', (payload) => {
    try {
      releaseAgent(payload?.agent?.id)
    } catch { /* ignore */ }
  })

  ctx.effect(() => () => {
    for (const id of Array.from(agentStates.keys())) releaseAgent(id)
  }, 'dsh-gitlab-issues: agent cleanup')

  // ------------------------------------------------------------------ agent 工具

  function outputFor(text) {
    return {
      schema: { type: 'object' },
      render: (_args, value) => {
        const message = value && typeof value === 'object' && typeof value.message === 'string'
          ? value.message
          : (typeof text === 'string' ? text : JSON.stringify(value ?? ''))
        return [{ type: 'text', text: message }]
      },
    }
  }

  function listLine(issue) {
    const labels = issue.labels.length > 0 ? ` [${issue.labels.join(',')}]` : ''
    const due = issue.due_date ? ` 截止 ${issue.due_date}` : ''
    const who = issue.assignees.length > 0 ? ` @${issue.assignees.map((a) => a.username || a.name).join(',')}` : ''
    return `#${issue.iid} ${issue.title}（${issue.state}）${labels}${who}${due}`
  }

  async function requireApproval(agent, toolName, reason, exec) {
    const approval = ctx.get('approval')
    if (!approval || typeof approval.request !== 'function') {
      return { ok: false, message: '当前环境没有审批通道，出于安全写操作被拒绝。' }
    }
    try {
      const outcome = await approval.request({
        agent,
        toolName,
        callId: exec?.callId,
        reason,
        signal: exec?.signal,
      })
      if (outcome !== 'allowed-once') {
        return { ok: false, message: `写操作未获批准（${outcome}），没有对 GitLab 做任何修改。` }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, message: `审批未完成：${describeError(error)}` }
    }
  }

  function buildAgentTools(agent, state) {
    const repo = state.repo

    const issuesTool = {
      name: 'gitlab_issues',
      description:
        `列出当前工作区所属公司 GitLab 项目（${repo.projectPath}）的议题。` +
        '开工前先用它挑议题；返回编号、标题、状态、标签、指派与截止日期。',
      parameters: {
        type: 'object',
        properties: {
          state: { type: 'string', enum: ['opened', 'closed', 'all'], description: '议题状态，默认 opened' },
          labels: { type: 'string', description: '标签筛选，多个用英文逗号分隔' },
          search: { type: 'string', description: '在标题与描述里搜关键词' },
          mine: { type: 'boolean', description: '只看指派给我的议题' },
          limit: { type: 'integer', description: `返回条数，默认 ${DEFAULT_LIST_LIMIT}，最大 100` },
        },
        additionalProperties: false,
      },
      output: outputFor(),
      async execute(args = {}) {
        try {
          const info = await getProjectCached(repo)
          const limit = Math.min(Math.max(Number.parseInt(String(args.limit ?? DEFAULT_LIST_LIMIT), 10) || DEFAULT_LIST_LIMIT, 1), 100)
          const result = await api.listIssues(repo.baseUrl, repo.projectPath, {
            state: args.state || 'opened',
            labels: args.labels || '',
            search: args.search || '',
            mine: args.mine === true,
            mineId: info?.me?.id,
            perPage: limit,
          })
          const items = (result.items ?? []).map(toIssueSummary).filter(Boolean)
          if (items.length === 0) {
            return { ok: true, message: `没有匹配的议题（共 ${result.total} 条）。`, issues: [] }
          }
          const lines = items.map(listLine)
          return {
            ok: true,
            message: `项目 ${repo.projectPath} 共 ${result.total} 条议题，返回 ${items.length} 条：\n${lines.join('\n')}`,
            issues: items,
          }
        } catch (error) {
          return { ok: false, message: describeError(error) }
        }
      },
    }

    const issueTool = {
      name: 'gitlab_issue',
      description: `读取当前公司 GitLab 项目（${repo.projectPath}）某条议题的完整描述与验收标准，必要时带最近评论。开工前应先调用它。`,
      parameters: {
        type: 'object',
        properties: {
          iid: { type: 'integer', description: '议题编号（标题旁的 #数字）' },
          withNotes: { type: 'boolean', description: '是否附带最近 20 条评论' },
        },
        required: ['iid'],
        additionalProperties: false,
      },
      output: outputFor(),
      async execute(args = {}) {
        const iid = Number.parseInt(String(args.iid ?? ''), 10)
        if (!Number.isInteger(iid) || iid <= 0) return { ok: false, message: 'iid 必须是正整数（议题编号）' }
        try {
          const raw = await api.getIssue(repo.baseUrl, repo.projectPath, iid)
          const issue = toIssueSummary(raw)
          if (!issue) return { ok: false, message: `议题 #${iid} 不存在` }
          const description = issue.description.length > 8000
            ? `${issue.description.slice(0, 8000)}\n…（描述过长已截断）`
            : issue.description
          const parts = [
            `#${issue.iid} ${issue.title}（${issue.state}）`,
            `标签：${issue.labels.join('、') || '无'}`,
            `指派：${issue.assignees.map((a) => a.name || a.username).join('、') || '无'}`,
            `截止：${issue.due_date || '无'}`,
            `链接：${issue.web_url}`,
            '',
            '描述：',
            description || '（空）',
          ]
          let notes = []
          if (args.withNotes === true) {
            const rawNotes = await api.getNotes(repo.baseUrl, repo.projectPath, iid, 20).catch(() => [])
            notes = (Array.isArray(rawNotes) ? rawNotes : [])
              .filter((n) => !n?.system)
              .map((n) => ({ author: String(n?.author?.name ?? ''), body: String(n?.body ?? ''), created_at: n?.created_at ?? null }))
            if (notes.length > 0) {
              parts.push('', '最近评论：')
              for (const note of notes) parts.push(`- ${note.author}：${note.body.slice(0, 500)}`)
            }
          }
          return { ok: true, message: parts.join('\n'), issue, notes }
        } catch (error) {
          return { ok: false, message: describeError(error) }
        }
      },
    }

    const createTool = {
      name: 'gitlab_issue_create',
      description:
        `在公司 GitLab 项目（${repo.projectPath}）新建一条议题。调用前按 skill gitlab-issue-workflow 补齐五必填：` +
        '标题一句话且可验收（不要「优化/完善/重构」这类状态词）；描述含「## 任务目标」「## 验收标准」；' +
        '指派默认是当前用户；复杂度（S/M/L）与类型（功能/修复/重构/文档）各一个标签；截止日期默认本周五；不要填 milestone。' +
        '该工具会先向用户请求确认，只有批准后才真正创建。',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '议题标题（可验收）' },
          description: { type: 'string', description: '描述，含「## 任务目标」「## 验收标准」' },
          complexity: { type: 'string', description: '复杂度 S / M / L（默认 M）' },
          type: { type: 'string', description: '类型 功能 / 修复 / 重构 / 文档（默认 功能）' },
          assigneeIds: { type: 'array', items: { type: 'integer' }, description: '指派人用户 id 列表，默认当前用户' },
          dueDate: { type: 'string', description: '截止日期 YYYY-MM-DD，默认本周五' },
        },
        required: ['title', 'description'],
        additionalProperties: false,
      },
      output: outputFor(),
      async execute(args = {}, exec = {}) {
        try {
          const info = await getProjectCached(repo)
          const validation = validateCreateIssue(args, { catalog: info?.catalog })
          if (!validation.ok) {
            return { ok: false, message: `议题内容不合规，未创建：\n- ${validation.errors.join('\n- ')}` }
          }

          const value = validation.value
          if (value.assigneeIds.length === 0 && info?.me?.id) value.assigneeIds = [info.me.id]

          const payload = {
            title: value.title,
            description: value.description,
            labels: value.labels,
            due_date: value.dueDate,
          }
          if (value.assigneeIds.length > 0) payload.assignee_ids = value.assigneeIds

          const reason = `将在 ${repo.projectPath} 创建议题「${value.title}」\n标签：${value.labels}\n截止：${value.dueDate}\n指派 id：${payload.assignee_ids?.join(',') ?? '无'}`
          const approval = await requireApproval(agent, 'gitlab_issue_create', reason, exec)
          if (!approval.ok) return { ok: false, message: approval.message }

          const created = await api.createIssue(repo.baseUrl, repo.projectPath, payload)
          issuesCache.delete(repoKey(repo))
          const issue = toIssueSummary(created)
          const warnings = validation.warnings.length > 0 ? `\n（${validation.warnings.join('；')}）` : ''
          return {
            ok: true,
            message: `已创建 #${issue.iid}「${issue.title}」\n${issue.web_url}\n标签：${issue.labels.join('、')}\n截止：${issue.due_date || '无'}${warnings}`,
            issue,
          }
        } catch (error) {
          return { ok: false, message: describeError(error) }
        }
      },
    }

    const writeTool = {
      name: 'gitlab_issue_write',
      description:
        `修改公司 GitLab 项目（${repo.projectPath}）的某条议题：加评论、关闭、重开、改指派或改标签。` +
        '该工具会先向用户请求确认，只有批准后才真正执行；一次只做一个动作。',
      parameters: {
        type: 'object',
        properties: {
          iid: { type: 'integer', description: '议题编号' },
          action: { type: 'string', enum: ['comment', 'close', 'reopen', 'assign', 'label'], description: '要执行的动作' },
          body: { type: 'string', description: 'action=comment 时的评论内容' },
          assigneeIds: { type: 'array', items: { type: 'integer' }, description: 'action=assign 时的指派人 id 列表' },
          labels: { type: 'string', description: 'action=label 时的完整标签串（英文逗号分隔，覆盖原标签）' },
        },
        required: ['iid', 'action'],
        additionalProperties: false,
      },
      output: outputFor(),
      async execute(args = {}, exec = {}) {
        const iid = Number.parseInt(String(args.iid ?? ''), 10)
        const action = String(args.action ?? '').trim()
        if (!Number.isInteger(iid) || iid <= 0) return { ok: false, message: 'iid 必须是正整数（议题编号）' }
        if (!['comment', 'close', 'reopen', 'assign', 'label'].includes(action)) {
          return { ok: false, message: `不支持的动作：${action || '(空)'}` }
        }

        let payload = null
        let describe = ''
        if (action === 'comment') {
          const body = String(args.body ?? '').trim()
          if (!body) return { ok: false, message: 'action=comment 需要提供 body' }
          describe = `在 #${iid} 下评论：${body.slice(0, 200)}`
        } else if (action === 'close') {
          payload = { state_event: 'close' }
          describe = `关闭议题 #${iid}`
        } else if (action === 'reopen') {
          payload = { state_event: 'reopen' }
          describe = `重新打开议题 #${iid}`
        } else if (action === 'assign') {
          const ids = Array.isArray(args.assigneeIds)
            ? args.assigneeIds.map((n) => Number.parseInt(String(n), 10)).filter((n) => Number.isInteger(n) && n > 0)
            : []
          if (ids.length === 0) return { ok: false, message: 'action=assign 需要提供 assigneeIds' }
          payload = { assignee_ids: ids }
          describe = `把 #${iid} 指派给 id ${ids.join(',')}`
        } else {
          const labels = String(args.labels ?? '').trim()
          if (!labels) return { ok: false, message: 'action=label 需要提供 labels' }
          payload = { labels }
          describe = `把 #${iid} 的标签改成 ${labels}`
        }

        const approval = await requireApproval(agent, 'gitlab_issue_write', `${describe}（项目 ${repo.projectPath}）`, exec)
        if (!approval.ok) return { ok: false, message: approval.message }

        try {
          if (action === 'comment') {
            await api.addNote(repo.baseUrl, repo.projectPath, iid, String(args.body).trim())
          } else {
            await api.updateIssue(repo.baseUrl, repo.projectPath, iid, payload)
          }
          issuesCache.delete(repoKey(repo))
          return { ok: true, message: `已完成：${describe}` }
        } catch (error) {
          return { ok: false, message: describeError(error) }
        }
      },
    }

    return [issuesTool, issueTool, createTool, writeTool]
  }

  // ------------------------------------------------------------------ HTTP 路由

  function json(res, data, status = 200) {
    const text = JSON.stringify(data)
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(text)
  }

  function readBody(req, limit = 65536) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > limit) {
          reject(new Error('请求体超过 64KB'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function sameOrigin(req) {
    const origin = req.headers?.origin
    if (!origin) return true
    try {
      return new URL(origin).host === req.headers.host
    } catch {
      return false
    }
  }

  function resolveRepoByProject(projectPath, hostPort, sessionId) {
    const wanted = String(projectPath ?? '').trim()
    if (!wanted) return null

    if (sessionId) {
      const state = agentStates.get(sessionId)
      if (state && state.repo.projectPath === wanted) return state.repo
    }
    for (const entry of repoCache.values()) {
      const repo = entry.value
      if (!repo) continue
      if (repo.projectPath !== wanted) continue
      if (hostPort && normalizeHost(repo.hostPort) !== normalizeHost(hostPort)) continue
      return repo
    }
    const host = normalizeHost(hostPort || currentSettings().hosts[0] || DEFAULT_COMPANY_HOSTS[0])
    if (!host) return null
    const scheme = 'http'
    return {
      repoRoot: '',
      remoteName: 'origin',
      remoteUrl: `${scheme}://${host}/${wanted}.git`,
      scheme,
      hostPort: host,
      projectPath: wanted,
      baseUrl: `${scheme}://${host}`,
      webUrl: `${scheme}://${host}/${wanted}`,
    }
  }

  async function stateForSession(sessionId, { refresh = false } = {}) {
    const settings = currentSettings()
    const result = {
      ok: true,
      sessionId: sessionId ?? null,
      cwd: null,
      enabled: settings.enabled,
      tokenConfigured: await tokenConfigured(),
      repo: null,
      project: null,
      issues: [],
      total: 0,
      counts: { opened: 0, closed: 0 },
      fetchedAt: null,
      error: null,
    }
    if (!settings.enabled) {
      result.error = '插件已停用'
      return result
    }

    const cwd = sessionCwd(sessionId)
    result.cwd = cwd ?? null
    const repo = detectRepoCached(cwd)
    if (!repo) {
      result.error = cwd ? '当前工作区不是公司 GitLab 仓库' : '当前会话没有工作区目录'
      return result
    }
    result.repo = {
      projectPath: repo.projectPath,
      baseUrl: repo.baseUrl,
      webUrl: repo.webUrl,
      remoteName: repo.remoteName,
      remoteUrl: repo.remoteUrl,
      repoRoot: repo.repoRoot,
    }

    try {
      const info = await getProjectCached(repo)
      if (info?.project) {
        result.project = {
          id: info.project.id ?? null,
          name: info.project.name ?? repo.projectPath,
          webUrl: info.project.web_url ?? repo.webUrl,
        }
      }
    } catch (error) {
      result.error = describeError(error)
    }

    if (result.tokenConfigured) {
      const value = refresh
        ? await refreshIssues(repo, { force: true })
        : await refreshIssues(repo, { force: false })
      const entry = issuesCacheEntry(repo)
      if (value) {
        result.issues = value.items
        result.total = value.total
        result.counts = {
          opened: value.items.filter((i) => i.state === 'opened').length,
          closed: value.items.filter((i) => i.state === 'closed').length,
        }
        result.fetchedAt = value.fetchedAt
      }
      if (entry?.error) result.error = entry.error
    }

    return result
  }

  async function handleRoute(req, res) {
    const url = new URL(req.url || '/', 'http://localhost')
    const action = url.pathname.startsWith(ROUTE) ? url.pathname.slice(ROUTE.length) : url.pathname
    const method = (req.method || 'GET').toUpperCase()

    try {
      // ---- 只读 ----
      if (method === 'GET' && (action === '/api/state' || action === '' || action === '/')) {
        const sessionId = url.searchParams.get('sessionId') || undefined
        json(res, await stateForSession(sessionId, { refresh: url.searchParams.get('refresh') === '1' }))
        return
      }

      if (method === 'GET' && action === '/api/projects') {
        const settings = currentSettings()
        const projects = await scanKnownProjects({ force: url.searchParams.get('refresh') === '1' })
        json(res, { ok: true, projects, hosts: settings.hosts, tokenConfigured: await tokenConfigured() })
        return
      }

      if (method === 'GET' && action === '/api/issues') {
        const repo = resolveRepoByProject(
          url.searchParams.get('project'),
          url.searchParams.get('host'),
          url.searchParams.get('sessionId') || undefined,
        )
        if (!repo) {
          json(res, { ok: false, error: '缺少 project 参数' }, 400)
          return
        }
        const limit = Math.min(Math.max(Number.parseInt(url.searchParams.get('limit') || '100', 10) || 100, 1), 100)
        const info = await getProjectCached(repo).catch(() => null)
        const result = await api.listIssues(repo.baseUrl, repo.projectPath, {
          state: url.searchParams.get('state') || 'opened',
          labels: url.searchParams.get('labels') || '',
          search: url.searchParams.get('search') || '',
          mine: url.searchParams.get('mine') === '1',
          mineId: info?.me?.id,
          perPage: limit,
        })
        json(res, {
          ok: true,
          projectPath: repo.projectPath,
          items: (result.items ?? []).map(toIssueSummary).filter(Boolean),
          total: result.total,
        })
        return
      }

      if (method === 'GET' && action === '/api/issue') {
        const repo = resolveRepoByProject(
          url.searchParams.get('project'),
          url.searchParams.get('host'),
          url.searchParams.get('sessionId') || undefined,
        )
        const iid = Number.parseInt(url.searchParams.get('iid') || '', 10)
        if (!repo || !Number.isInteger(iid)) {
          json(res, { ok: false, error: '缺少 project / iid 参数' }, 400)
          return
        }
        const raw = await api.getIssue(repo.baseUrl, repo.projectPath, iid)
        const issue = toIssueSummary(raw)
        let notes = []
        if (url.searchParams.get('notes') === '1') {
          const rawNotes = await api.getNotes(repo.baseUrl, repo.projectPath, iid, 30).catch(() => [])
          notes = (Array.isArray(rawNotes) ? rawNotes : [])
            .filter((n) => !n?.system)
            .map((n) => ({
              id: n?.id ?? null,
              author: String(n?.author?.name ?? ''),
              body: String(n?.body ?? ''),
              created_at: n?.created_at ?? null,
            }))
        }
        json(res, { ok: true, issue, notes })
        return
      }

      if (method === 'GET' && action === '/api/members') {
        const repo = resolveRepoByProject(
          url.searchParams.get('project'),
          url.searchParams.get('host'),
          url.searchParams.get('sessionId') || undefined,
        )
        if (!repo) {
          json(res, { ok: false, error: '缺少 project 参数' }, 400)
          return
        }
        try {
          const members = await api.getAssignees(repo.baseUrl, repo.projectPath)
          json(res, { ok: true, members })
        } catch (error) {
          json(res, { ok: false, error: describeError(error) })
        }
        return
      }

      if (method === 'GET' && action === '/api/labels') {
        const repo = resolveRepoByProject(
          url.searchParams.get('project'),
          url.searchParams.get('host'),
          url.searchParams.get('sessionId') || undefined,
        )
        if (!repo) {
          json(res, { ok: false, error: '缺少 project 参数' }, 400)
          return
        }
        try {
          const info = await getProjectCached(repo)
          const catalog = info && info.catalog ? info.catalog : null
          const complexity = catalog ? catalog.labelsOf(catalog.complexityPrefix) : []
          const type = catalog ? catalog.labelsOf(catalog.typePrefix) : []
          const usedLabel = new Set([...complexity, ...type])
          const groups = catalog ? catalog.groupList() : []
          const others = groups
            .filter((g) => !usedLabel.has(g.labels[0]))
            .map((g) => ({ prefix: g.prefix, labels: g.labels }))
          json(res, {
            ok: true,
            all: catalog ? catalog.all : [],
            complexity,
            type,
            others,
            complexityPrefix: catalog ? catalog.complexityPrefix : null,
            typePrefix: catalog ? catalog.typePrefix : null,
          })
        } catch (error) {
          json(res, { ok: false, error: describeError(error) })
        }
        return
      }

      if (method === 'GET' && action === '/api/settings') {
        const settings = currentSettings()
        json(res, { ok: true, settings: publicSettings(settings, await tokenConfigured()) })
        return
      }

      if (method === 'GET' && action === '/api/prepare') {
        // 界面拿"开工/建议题"提示词，避免前后端各维护一份模板
        const sessionId = url.searchParams.get('sessionId') || undefined
        const projectParam = url.searchParams.get('project')
        const hostParam = url.searchParams.get('host')
        const iid = Number.parseInt(url.searchParams.get('iid') || '', 10)
        const requirement = url.searchParams.get('requirement') || ''
        const titleHint = url.searchParams.get('title') || ''
        const intent = url.searchParams.get('intent') || ''

        let repo = null
        let cachedIssues = []
        if (sessionId) {
          const state = await stateForSession(sessionId)
          repo = state.repo
          cachedIssues = state.issues ?? []
        }
        if (!repo && projectParam) repo = resolveRepoByProject(projectParam, hostParam, sessionId)
        if (!repo) {
          json(res, { ok: false, error: '当前工作区不是公司 GitLab 仓库' }, 409)
          return
        }

        // 新建议题：只给一段"引导语"，用户在 DSH 自带输入框里补需求（插件不再有独立输入框）
        if (intent === 'create') {
          json(res, { ok: true, prompt: buildCreateIssueIntro({ repo }) })
          return
        }
        if (requirement.trim()) {
          json(res, { ok: true, prompt: buildCreateIssuePrompt({ repo, requirement, dueDate: nextFriday() }) })
          return
        }
        if (Number.isInteger(iid) && iid > 0) {
          const issue = cachedIssues.find((i) => i.iid === iid) ?? {
            iid,
            title: titleHint || `#${iid}`,
            labels: [],
            assignees: [],
            due_date: null,
            web_url: `${repo.webUrl}/-/issues/${iid}`,
          }
          json(res, { ok: true, prompt: buildWorkPrompt({ repo, issue }) })
          return
        }
        json(res, { ok: false, error: '需要 iid 或 requirement' }, 400)
        return
      }

      // ---- 写操作（同源 + JSON）----
      if (method === 'POST') {
        if (!sameOrigin(req)) {
          json(res, { ok: false, error: '拒绝跨站请求' }, 403)
          return
        }
        const raw = await readBody(req)
        let body = {}
        if (raw.trim()) {
          try {
            body = JSON.parse(raw)
          } catch {
            json(res, { ok: false, error: '请求体不是合法 JSON' }, 400)
            return
          }
        }

        if (action === '/api/settings') {
          const patch = {}
          if (typeof body.token === 'string' && body.token.trim()) patch.token = body.token.trim()
          if (body.clearToken === true) patch.token = ''
          if (body.enabled !== undefined) patch.enabled = body.enabled !== false
          if (body.injectPrompt !== undefined) patch.injectPrompt = body.injectPrompt !== false
          if (body.pollSeconds !== undefined) patch.pollSeconds = body.pollSeconds
          if (Array.isArray(body.hosts)) patch.hosts = body.hosts
          if (typeof body.tokenRef === 'string' && body.tokenRef.trim()) patch.tokenRef = body.tokenRef.trim()

          let tokenSavedTo = null
          if (typeof body.token === 'string' && body.token.trim()) {
            const credentials = ctx.get('credentials')
            const ref = String(patch.tokenRef || currentSettings().tokenRef || TOKEN_REF)
            if (credentials && typeof credentials.set === 'function') {
              try {
                await credentials.set(ref, body.token.trim())
                tokenSavedTo = 'credentials'
                patch.token = ''
              } catch (error) {
                warn('凭据服务写入失败，改存本地设置文件', error)
              }
            }
          }

          const saved = writeSettings(patch)
          projectCache.clear()
          issuesCache.clear()
          knownProjects = { value: null, at: 0 }
          json(res, { ok: true, settings: publicSettings(saved, await tokenConfigured()), tokenSavedTo })
          return
        }

        if (action === '/api/test') {
          const settings = currentSettings()
          const host = normalizeHost(body.host || settings.hosts[0] || DEFAULT_COMPANY_HOSTS[0])
          const baseUrl = `http://${host}`
          // 允许用"还没保存"的令牌直接测：界面上粘贴后立刻测试才有意义
          const inlineToken = typeof body.token === 'string' ? body.token.trim() : ''
          try {
            const client = inlineToken
              ? createGitLabApi({ readToken: async () => inlineToken, log })
              : api
            const me = await client.getCurrentUser(baseUrl)
            json(res, {
              ok: true,
              message: `${inlineToken ? '新令牌' : '已保存令牌'}可用：${me?.name ?? ''}（@${me?.username ?? ''}）@ ${host}`,
              user: me ? { id: me.id, name: me.name, username: me.username } : null,
              usedInlineToken: !!inlineToken,
            })
          } catch (error) {
            json(res, {
              ok: false,
              error: `${inlineToken ? '新令牌' : '已保存令牌'}不可用：${describeError(error)}`,
              usedInlineToken: !!inlineToken,
            })
          }
          return
        }

        if (action === '/api/refresh') {
          const repo = resolveRepoByProject(body.project, body.host, body.sessionId)
          if (!repo) {
            json(res, { ok: false, error: '缺少 project 参数' }, 400)
            return
          }
          repoCache.clear()
          projectCache.delete(repoKey(repo))
          await refreshIssues(repo, { force: true })
          knownProjects = { value: null, at: 0 }
          json(res, { ok: true })
          return
        }

        if (action === '/api/create') {
          const repo = resolveRepoByProject(body.project, body.host, body.sessionId)
          if (!repo) {
            json(res, { ok: false, error: '缺少 project 参数' }, 400)
            return
          }
          try {
            const info = await getProjectCached(repo)
            const validation = validateCreateIssue({
              title: body.title,
              description: body.description,
              complexity: body.complexity,
              type: body.type,
              dueDate: body.dueDate,
              assigneeIds: body.assigneeIds,
              extraLabels: Array.isArray(body.labels) ? body.labels : undefined,
            }, { catalog: info && info.catalog ? info.catalog : null })
            if (!validation.ok) {
              json(res, { ok: false, error: `内容不合规：${validation.errors.join('；')}` }, 400)
              return
            }
            const value = validation.value
            if (value.assigneeIds.length === 0 && info && info.me && info.me.id) {
              value.assigneeIds = [info.me.id]
            }
            const payload = {
              title: value.title,
              description: value.description,
              labels: value.labels,
              due_date: value.dueDate,
            }
            // 界面在"标签字典读不到"时会让人手填完整标签串，这里以它为准
            const override = typeof body.labelsOverride === 'string' ? body.labelsOverride.trim() : ''
            if (override) payload.labels = override
            if (value.assigneeIds.length > 0) payload.assignee_ids = value.assigneeIds
            const created = await api.createIssue(repo.baseUrl, repo.projectPath, payload)
            issuesCache.delete(repoKey(repo))
            log(`界面新建议题：${repo.projectPath} → #${created && created.iid}`)
            json(res, { ok: true, issue: toIssueSummary(created), warnings: validation.warnings })
          } catch (error) {
            json(res, { ok: false, error: describeError(error) })
          }
          return
        }

        if (action === '/api/update') {
          const repo = resolveRepoByProject(body.project, body.host, body.sessionId)
          const iid = Number.parseInt(String(body.iid ?? ''), 10)
          if (!repo || !Number.isInteger(iid) || iid <= 0) {
            json(res, { ok: false, error: '参数不完整：需要 project 与 iid' }, 400)
            return
          }
          const payload = {}
          if (typeof body.title === 'string' && body.title.trim()) payload.title = body.title.trim()
          if (typeof body.description === 'string') payload.description = body.description
          if (typeof body.labels === 'string') payload.labels = body.labels.trim()
          if (typeof body.dueDate === 'string' && body.dueDate.trim()) payload.due_date = body.dueDate.trim()
          if (Array.isArray(body.assigneeIds)) {
            payload.assignee_ids = body.assigneeIds
              .map((n) => Number.parseInt(String(n), 10))
              .filter((n) => Number.isInteger(n) && n > 0)
          }
          if (body.stateEvent === 'close' || body.stateEvent === 'reopen') payload.state_event = body.stateEvent
          if (Object.keys(payload).length === 0) {
            json(res, { ok: false, error: '没有要修改的字段' }, 400)
            return
          }
          try {
            const updated = await api.updateIssue(repo.baseUrl, repo.projectPath, iid, payload)
            issuesCache.delete(repoKey(repo))
            log(`界面编辑议题：${repo.projectPath}#${iid} → ${Object.keys(payload).join(',')}`)
            json(res, { ok: true, issue: toIssueSummary(updated) })
          } catch (error) {
            json(res, { ok: false, error: describeError(error) })
          }
          return
        }

        if (action === '/api/delete') {
          const repo = resolveRepoByProject(body.project, body.host, body.sessionId)
          const iid = Number.parseInt(String(body.iid ?? ''), 10)
          if (!repo || !Number.isInteger(iid) || iid <= 0) {
            json(res, { ok: false, error: '参数不完整：需要 project 与 iid' }, 400)
            return
          }
          try {
            await api.deleteIssue(repo.baseUrl, repo.projectPath, iid)
            issuesCache.delete(repoKey(repo))
            log(`界面删除议题：${repo.projectPath}#${iid}`)
            json(res, { ok: true })
          } catch (error) {
            json(res, { ok: false, error: describeError(error) })
          }
          return
        }

        if (action === '/api/comment' || action === '/api/close' || action === '/api/reopen') {
          const repo = resolveRepoByProject(body.project, body.host, body.sessionId)
          const iid = Number.parseInt(String(body.iid ?? ''), 10)
          if (!repo || !Number.isInteger(iid) || iid <= 0) {
            json(res, { ok: false, error: '参数不完整：需要 project 与 iid' }, 400)
            return
          }
          try {
            if (action === '/api/comment') {
              const text = String(body.body ?? '').trim()
              if (!text) {
                json(res, { ok: false, error: '评论内容不能为空' }, 400)
                return
              }
              await api.addNote(repo.baseUrl, repo.projectPath, iid, text)
            } else {
              await api.updateIssue(repo.baseUrl, repo.projectPath, iid, {
                state_event: action === '/api/close' ? 'close' : 'reopen',
              })
            }
            issuesCache.delete(repoKey(repo))
            log(`界面写操作完成：${action} ${repo.projectPath}#${iid}`)
            json(res, { ok: true })
          } catch (error) {
            json(res, { ok: false, error: describeError(error) })
          }
          return
        }

        if (action === '/api/diagnostics') {
          const cwd = sessionCwd(body.sessionId)
          const repo = detectRepoCached(cwd)
          const remotes = cwd ? listRepoRemotes(cwd) : { repoRoot: null, remotes: [] }
          json(res, {
            ok: true,
            cwd: cwd ?? null,
            repoRoot: remotes.repoRoot,
            isRepo: cwd ? !!findRepo(cwd) : false,
            companyRepo: repo ? { projectPath: repo.projectPath, hostPort: repo.hostPort } : null,
            remotes: remotes.remotes.map((r) => ({ name: r.name, url: r.url, host: r.parsed?.hostPort ?? null })),
            hosts: currentSettings().hosts,
          })
          return
        }

        json(res, { ok: false, error: `未知操作：${action}` }, 404)
        return
      }

      json(res, { ok: false, error: `未知请求：${method} ${action}` }, 404)
    } catch (error) {
      warn(`路由处理失败：${method} ${action}`, error)
      json(res, { ok: false, error: describeError(error) }, 500)
    }
  }

  // 冷启动时 webServer 可能晚于本插件就绪（实测 apply 早于它 → 直接 ctx.get 会拿到 undefined，
  // 路由就永远不会注册，界面全部 404）。用 ctx.inject 等依赖就绪，服务消失时 Cordis 自动清理。
  const mountRoutes = (webCtx) => {
    const webServer = (webCtx && webCtx.webServer) || (webCtx && webCtx.get && webCtx.get('webServer'))
    if (!webServer || typeof webServer.register !== 'function') {
      warn('webServer 服务不可用，跳过界面数据接口（工具仍然可用）')
      return
    }
    webCtx.effect(() => {
      try {
        return webServer.register({
          kind: 'prefix',
          path: ROUTE,
          handler(req, res) {
            void handleRoute(req, res)
          },
        })
      } catch (error) {
        warn('路由注册失败（可能已存在）', error)
        return () => {}
      }
    }, 'dsh-gitlab-issues: routes')
    log(`界面数据接口已挂载：${ROUTE}`)
  }

  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], mountRoutes)
  } else {
    mountRoutes(ctx)
  }

  log(`已装载：hosts=${currentSettings().hosts.join(', ')}`)
}
