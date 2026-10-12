/**
 * 公司 GitLab REST v4 客户端。
 *
 * 行为对齐 F:\DSH_Work\gitlab-issue-bot 的 electron/core/gitlab/client.ts：
 * 分页、超时、429/5xx 重试、请求体丢 null（GitLab 对「存在但为空的参数」硬报错）。
 * 代码独立重写，只有 PAT 一种认证（PRIVATE-TOKEN 头）。
 */

export class GitLabApiError extends Error {
  constructor(status, body, url) {
    super(`GitLab API 错误 HTTP ${status}：${String(body ?? '').slice(0, 300)}`)
    this.name = 'GitLabApiError'
    this.status = status
    this.body = String(body ?? '').slice(0, 1000)
    this.url = url
  }
}

export class GitLabTokenMissingError extends Error {
  constructor() {
    super('未配置 GitLab 令牌（个人访问令牌 PAT）')
    this.name = 'GitLabTokenMissingError'
  }
}

/** 请求体序列化：丢掉 undefined / null，避免 GitLab 判为空参数。 */
export function toBody(body) {
  return JSON.stringify(body, (_k, v) => (v === undefined || v === null ? undefined : v))
}

/** 去掉空值后的 query string（不含前导 ?）。 */
export function toQuery(params) {
  const qs = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue
    const text = String(value).trim()
    if (!text) continue
    qs.set(key, text)
  }
  return qs.toString()
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * @param {object} options
 * @param {() => Promise<string|null>} options.readToken 每次请求重新解析令牌（不跨操作缓存）
 * @param {(msg: string, detail?: unknown) => void} [options.log]
 */
export function createGitLabApi({ readToken, log = () => {}, timeoutMs = 15000, maxRetries = 2, pageSize = 100 } = {}) {
  async function request(method, baseUrl, path, body) {
    const token = String((await readToken()) ?? '').trim()
    if (!token) throw new GitLabTokenMissingError()

    const url = /^https?:/i.test(path) ? path : `${String(baseUrl).replace(/\/+$/, '')}${path}`
    let lastError = null

    for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
      const started = Date.now()
      try {
        const headers = { Accept: 'application/json', 'PRIVATE-TOKEN': token }
        if (body !== undefined) headers['Content-Type'] = 'application/json'

        const res = await fetch(url, {
          method,
          headers,
          body: body === undefined ? undefined : toBody(body),
          signal: AbortSignal.timeout(timeoutMs),
        })
        const text = await res.text()
        log(`${method} ${url} → ${res.status} (${Date.now() - started}ms, ${text.length} 字节)`)

        if (res.status === 429 || res.status >= 500) {
          if (attempt <= maxRetries) {
            const delay = Math.pow(2, attempt - 1) * 800
            log(`HTTP ${res.status}，${delay}ms 后重试（第 ${attempt}/${maxRetries} 次）`, text.slice(0, 300))
            await sleep(delay)
            continue
          }
          throw new GitLabApiError(res.status, text, url)
        }

        if (!res.ok) throw new GitLabApiError(res.status, text, url)

        const headersObj = {}
        res.headers.forEach((value, key) => { headersObj[key.toLowerCase()] = value })

        if (!text.trim()) return { data: null, headers: headersObj }
        return { data: JSON.parse(text), headers: headersObj }
      } catch (error) {
        if (error instanceof GitLabApiError) throw error
        if (error instanceof Error && error.name === 'TimeoutError') {
          lastError = new Error(`请求超时（${timeoutMs}ms）：${url}`)
        } else {
          lastError = error
        }
        if (attempt > maxRetries) break
        const delay = Math.pow(2, attempt - 1) * 800
        log(`${method} ${url} 失败：${String(lastError)}，${delay}ms 后重试`, undefined)
        await sleep(delay)
      }
    }

    throw lastError instanceof Error ? lastError : new Error(`${method} ${url} 失败`)
  }

  const get = (baseUrl, path) => request('GET', baseUrl, path).then((r) => r.data)
  const getWithHeaders = (baseUrl, path) => request('GET', baseUrl, path)
  const post = (baseUrl, path, body) => request('POST', baseUrl, path, body).then((r) => r.data)
  const put = (baseUrl, path, body) => request('PUT', baseUrl, path, body).then((r) => r.data)

  const projectId = (projectPath) => encodeURIComponent(String(projectPath))

  return {
    request,
    getWithHeaders,

    async getCurrentUser(baseUrl) {
      return get(baseUrl, '/api/v4/user')
    },

    async getProject(baseUrl, projectPath) {
      return get(baseUrl, `/api/v4/projects/${projectId(projectPath)}`)
    },

    async getLabels(baseUrl, projectPath) {
      const data = await get(baseUrl, `/api/v4/projects/${projectId(projectPath)}/labels?per_page=${pageSize}`)
      return Array.isArray(data) ? data.map((l) => String(l?.name ?? '')).filter(Boolean) : []
    },

    async getAssignees(baseUrl, projectPath) {
      const data = await get(baseUrl, `/api/v4/projects/${projectId(projectPath)}/members/all?per_page=${pageSize}`)
      if (!Array.isArray(data)) return []
      return data
        .map((m) => ({ id: Number(m?.id), name: String(m?.name ?? ''), username: String(m?.username ?? '') }))
        .filter((m) => Number.isInteger(m.id) && !/[-_]bot$/i.test(m.username))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    },

    async listIssues(baseUrl, projectPath, options = {}) {
      const query = toQuery({
        state: options.state || 'opened',
        labels: options.labels || '',
        search: options.search || '',
        assignee_id: options.assigneeId || (options.mine && options.mineId ? options.mineId : ''),
        order_by: options.orderBy || 'created_at',
        sort: options.sort || 'desc',
        page: options.page || 1,
        per_page: Math.min(Math.max(Number(options.perPage) || pageSize, 1), 100),
      })
      const { data, headers } = await getWithHeaders(
        baseUrl,
        `/api/v4/projects/${projectId(projectPath)}/issues?${query}`,
      )
      const total = Number.parseInt(headers['x-total'] ?? '', 10)
      return {
        items: Array.isArray(data) ? data : [],
        total: Number.isFinite(total) ? total : (Array.isArray(data) ? data.length : 0),
        totalPages: Number.parseInt(headers['x-total-pages'] ?? '1', 10) || 1,
      }
    },

    getIssue(baseUrl, projectPath, iid) {
      return get(baseUrl, `/api/v4/projects/${projectId(projectPath)}/issues/${Number(iid)}`)
    },

    getNotes(baseUrl, projectPath, iid, limit = 20) {
      return get(
        baseUrl,
        `/api/v4/projects/${projectId(projectPath)}/issues/${Number(iid)}/notes?sort=desc&per_page=${limit}`,
      )
    },

    createIssue(baseUrl, projectPath, payload) {
      return post(baseUrl, `/api/v4/projects/${projectId(projectPath)}/issues`, payload)
    },

    addNote(baseUrl, projectPath, iid, body) {
      return post(baseUrl, `/api/v4/projects/${projectId(projectPath)}/issues/${Number(iid)}/notes`, { body })
    },

    updateIssue(baseUrl, projectPath, iid, payload) {
      return put(baseUrl, `/api/v4/projects/${projectId(projectPath)}/issues/${Number(iid)}`, payload)
    },

    /** 删除议题（GitLab 需要 Owner 权限；无权限时返回 403）。 */
    deleteIssue(baseUrl, projectPath, iid) {
      return request('DELETE', baseUrl, `/api/v4/projects/${projectId(projectPath)}/issues/${Number(iid)}`)
        .then((r) => r.data)
    },
  }
}

/** 把议题压成界面/工具要用的精简结构。 */
export function toIssueSummary(issue) {
  if (!issue) return null
  return {
    iid: Number(issue.iid),
    title: String(issue.title ?? ''),
    state: String(issue.state ?? ''),
    labels: Array.isArray(issue.labels) ? issue.labels.map(String) : [],
    assignees: Array.isArray(issue.assignees)
      ? issue.assignees.map((a) => ({ id: Number(a?.id), name: String(a?.name ?? ''), username: String(a?.username ?? '') }))
      : [],
    due_date: issue.due_date ?? null,
    web_url: String(issue.web_url ?? ''),
    created_at: issue.created_at ?? null,
    updated_at: issue.updated_at ?? null,
    description: typeof issue.description === 'string' ? issue.description : '',
    author: issue.author ? { name: String(issue.author.name ?? ''), username: String(issue.author.username ?? '') } : null,
  }
}
