import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { parseRemoteUrl, parseRemotes, readGitConfigAt, findRepo, detectCompanyRepo } from '../lib/git-detect.js'
import {
  DEFAULT_COMPANY_HOSTS,
  formatDate,
  isCompanyGitLabHost,
  nextFriday,
  normalizeHost,
  validateCreateIssue,
  ensureDescriptionTemplate,
} from '../lib/company-rules.js'
import { LabelCatalog, lastSegment, normalizeTypeKey } from '../lib/labels.js'
import { buildWorkPrompt, buildCreateIssuePrompt } from '../lib/prompt.js'
import { toBody, toQuery } from '../lib/gitlab.js'

// ---------------------------------------------------------------- remote 解析

test('parseRemoteUrl 支持 http / scp / ssh 三种形态', () => {
  const http = parseRemoteUrl('http://47.109.72.180:8000/cbhw/cbhw-react-app.git')
  assert.equal(http.scheme, 'http')
  assert.equal(http.hostPort, '47.109.72.180:8000')
  assert.equal(http.projectPath, 'cbhw/cbhw-react-app')

  const https = parseRemoteUrl('https://git.bobotechnology.cn:8000/group/sub/proj.git')
  assert.equal(https.scheme, 'https')
  assert.equal(https.projectPath, 'group/sub/proj')

  const scp = parseRemoteUrl('git@git.bobotechnology.cn:group/proj.git')
  assert.equal(scp.scheme, 'ssh')
  assert.equal(scp.hostPort, 'git.bobotechnology.cn')
  assert.equal(scp.projectPath, 'group/proj')

  const ssh = parseRemoteUrl('ssh://git@git.bobotechnology.cn:2222/group/proj.git')
  assert.equal(ssh.scheme, 'ssh')
  assert.equal(ssh.hostPort, 'git.bobotechnology.cn:2222')
  assert.equal(ssh.projectPath, 'group/proj')

  assert.equal(parseRemoteUrl(''), null)
  assert.equal(parseRemoteUrl('not a url'), null)
})

test('parseRemoteUrl 归一化 80/443 端口并剥掉 .git 与尾斜杠', () => {
  const a = parseRemoteUrl('http://git.example.com:80/group/proj.git/')
  assert.equal(a.hostPort, 'git.example.com')
  assert.equal(a.projectPath, 'group/proj')

  const b = parseRemoteUrl('https://Git.Example.COM/Group/Proj')
  assert.equal(b.host, 'git.example.com')
  assert.equal(b.projectPath, 'Group/Proj')
})

test('parseRemotes 解析多 remote 并把 origin 排最前', () => {
  const config = `
[core]
\trepositoryformatversion = 0
[remote "upstream"]
\turl = http://example.com/up/proj.git
\tfetch = +refs/heads/*:refs/remotes/upstream/*
[remote "origin"]
\turl = http://47.109.72.180:8000/cbhw/cbhw-react-app.git
\tfetch = +refs/heads/*:refs/remotes/origin/*
[branch "main"]
\tremote = origin
`
  const remotes = parseRemotes(config)
  assert.equal(remotes.length, 2)
  assert.equal(remotes[0].name, 'origin')
  assert.equal(remotes[0].url, 'http://47.109.72.180:8000/cbhw/cbhw-react-app.git')
  assert.equal(remotes[1].name, 'upstream')
  assert.equal(parseRemotes('[core]\n\tbare = false').length, 0)
})

// ------------------------------------------------------------ 仓库目录探测

function withTempRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-gi-'))
  try {
    return run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('findRepo 从子目录向上找到仓库根并读出 remote', () => {
  withTempRepo((root) => {
    const gitDir = join(root, '.git')
    mkdirSync(gitDir, { recursive: true })
    writeFileSync(join(gitDir, 'config'), '[remote "origin"]\n\turl = http://47.109.72.180:8000/cbhw/cbhw-react-app.git\n')
    const deep = join(root, 'src', 'views')
    mkdirSync(deep, { recursive: true })

    const repo = findRepo(deep)
    assert.ok(repo)
    assert.equal(repo.repoRoot, root)
    assert.equal(parseRemotes(repo.configText)[0].url, 'http://47.109.72.180:8000/cbhw/cbhw-react-app.git')
    assert.equal(readGitConfigAt(deep), null)
  })
})

test('findRepo 支持 worktree 形态（.git 是文件）', () => {
  withTempRepo((root) => {
    const realGit = join(root, 'main-repo', '.git')
    mkdirSync(join(realGit, 'worktrees', 'wt'), { recursive: true })
    writeFileSync(join(realGit, 'config'), '[remote "origin"]\n\turl = http://git.bobotechnology.cn:8000/g/p.git\n')

    const wt = join(root, 'worktree')
    mkdirSync(wt, { recursive: true })
    writeFileSync(join(wt, '.git'), `gitdir: ${join(realGit, 'worktrees', 'wt')}\n`)
    const repo = findRepo(wt)
    assert.ok(repo)
    assert.equal(repo.repoRoot, wt)
  })
})

test('detectCompanyRepo 只认白名单内的 remote，非公司仓库返回 null', () => {
  withTempRepo((root) => {
    const gitDir = join(root, '.git')
    mkdirSync(gitDir, { recursive: true })

    writeFileSync(join(gitDir, 'config'), '[remote "origin"]\n\turl = https://github.com/ibelick/ui-skills.git\n')
    assert.equal(detectCompanyRepo(root, DEFAULT_COMPANY_HOSTS), null)

    writeFileSync(join(gitDir, 'config'), '[remote "origin"]\n\turl = http://47.109.72.180:8000/cbhw/cbhw-react-app.git\n')
    const hit = detectCompanyRepo(root, DEFAULT_COMPANY_HOSTS)
    assert.ok(hit)
    assert.equal(hit.projectPath, 'cbhw/cbhw-react-app')
    assert.equal(hit.baseUrl, 'http://47.109.72.180:8000')
    assert.equal(hit.webUrl, 'http://47.109.72.180:8000/cbhw/cbhw-react-app')

    // 多 remote：origin 不是公司、第二个是公司时也能命中
    writeFileSync(join(gitDir, 'config'), [
      '[remote "origin"]',
      '\turl = http://218.89.76.35:7022/web_001/aidatav2-board.git',
      '[remote "company"]',
      '\turl = http://git.bobotechnology.cn:8000/web_001/aidatav2-board.git',
    ].join('\n') + '\n')
    const second = detectCompanyRepo(root, DEFAULT_COMPANY_HOSTS)
    assert.ok(second)
    assert.equal(second.remoteName, 'company')
    assert.equal(second.projectPath, 'web_001/aidatav2-board')
  })
})

// -------------------------------------------------------------- 公司 host 判定

test('isCompanyGitLabHost：域名与 IP 等价、端口省略也认、大小写不敏感', () => {
  assert.equal(isCompanyGitLabHost('git.bobotechnology.cn:8000'), true)
  assert.equal(isCompanyGitLabHost('git.bobotechnology.cn'), true)
  assert.equal(isCompanyGitLabHost('47.109.72.180:8000'), true)
  assert.equal(isCompanyGitLabHost('http://47.109.72.180:8000/x/y'), true)
  assert.equal(isCompanyGitLabHost('GIT.BOBOTECHNOLOGY.CN:8000'), true)
  assert.equal(isCompanyGitLabHost('github.com'), false)
  assert.equal(isCompanyGitLabHost('218.89.76.35:7022'), false)
  assert.equal(isCompanyGitLabHost(''), false)
  assert.equal(isCompanyGitLabHost('git.bobotechnology.cn:9999'), false)
  // 自定义白名单可覆盖
  assert.equal(isCompanyGitLabHost('218.89.76.35:7022', ['218.89.76.35:7022']), true)
})

test('normalizeHost 去掉协议、路径与 80/443', () => {
  assert.equal(normalizeHost('http://git.example.com:80/a/b'), 'git.example.com')
  assert.equal(normalizeHost('https://git.example.com:443'), 'git.example.com')
  assert.equal(normalizeHost('git.example.com:8000'), 'git.example.com:8000')
})

// ------------------------------------------------------------------ 日期

test('nextFriday / formatDate：本周五与跨周计算', () => {
  assert.equal(nextFriday(new Date(2026, 9, 12)), '2026-10-16') // 周一 → 本周五
  assert.equal(nextFriday(new Date(2026, 9, 16)), '2026-10-16') // 周五 → 当天
  assert.equal(nextFriday(new Date(2026, 9, 17)), '2026-10-23') // 周六 → 下周五
  assert.equal(nextFriday(new Date(2026, 9, 18)), '2026-10-23') // 周日 → 下周五
  assert.equal(formatDate(new Date(2026, 0, 5)), '2026-01-05')
})

// ---------------------------------------------------------------- 标签字典

test('LabelCatalog 识别复杂度/类型分组并把短值解析成真实标签', () => {
  const catalog = LabelCatalog.from([
    '复杂度::S', '复杂度::M', '复杂度::L',
    '类型::功能', '类型::修复', '类型::重构', '类型::文档',
    '前端', '后端',
  ])

  assert.equal(catalog.complexityPrefix, '复杂度')
  assert.equal(catalog.typePrefix, '类型')
  assert.deepEqual(catalog.complexityLabels, ['复杂度::S', '复杂度::M', '复杂度::L'])
  assert.equal(catalog.resolveComplexity('M'), '复杂度::M')
  assert.equal(catalog.resolveComplexity('小'), '复杂度::S')
  assert.equal(catalog.resolveComplexity('复杂'), '复杂度::L')
  assert.equal(catalog.resolveComplexity(''), '')
  assert.equal(catalog.resolveType('修复'), '类型::修复')
  assert.equal(catalog.resolveType('bug'), '类型::修复')
  assert.equal(catalog.resolveType('doc'), '类型::文档')
  assert.equal(catalog.resolveType('feature'), '类型::功能')
  // 只有「前缀::值」形态才算分组（前端/后端不成组）
  assert.equal(catalog.groupList().length, 2)
  assert.deepEqual(catalog.groupList().map((g) => g.prefix).sort(), ['复杂度', '类型'])
  assert.equal(lastSegment('复杂度::M'), 'M')
  assert.equal(normalizeTypeKey('修一下样式'), '修复')
})

test('LabelCatalog 对不是「前缀::值」的字典也能回退到默认前缀', () => {
  const catalog = LabelCatalog.from(['bug', 'frontend'])
  assert.equal(catalog.complexityPrefix, null)
  assert.equal(catalog.resolveComplexity('M'), '复杂度::M')
  assert.equal(catalog.resolveType('功能'), '类型::功能')
})

// ------------------------------------------------------------ 五必填校验

test('validateCreateIssue：缺标题/描述时报错，其余项给默认值', () => {
  const bad = validateCreateIssue({}, { today: new Date(2026, 9, 12) })
  assert.equal(bad.ok, false)
  assert.ok(bad.errors.some((e) => e.includes('标题')))
  assert.ok(bad.errors.some((e) => e.includes('描述')))

  const catalog = LabelCatalog.from(['复杂度::S', '复杂度::M', '复杂度::L', '类型::功能', '类型::修复'])
  const good = validateCreateIssue({
    title: '修复导入按钮样式错位',
    description: '## 任务目标\n修复导入按钮样式\n\n## 验收标准\n1. 截图对比一致',
    complexity: 'S',
    type: '修复',
    assigneeIds: [29],
  }, { catalog, today: new Date(2026, 9, 12) })

  assert.equal(good.ok, true)
  assert.equal(good.value.labels, '复杂度::S,类型::修复')
  assert.equal(good.value.dueDate, '2026-10-16')
  assert.deepEqual(good.value.assigneeIds, [29])
  assert.deepEqual(good.errors, [])
})

test('validateCreateIssue：描述缺模板时补全并给出告警，日期格式非法则报错', () => {
  const result = validateCreateIssue({
    title: '标题',
    description: '就是改一下',
    dueDate: '2026/10/16',
  }, { today: new Date(2026, 9, 12) })

  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('YYYY-MM-DD')))
  assert.ok(result.warnings.some((w) => w.includes('任务目标')))
  assert.ok(result.value.description.includes('## 任务目标'))
  assert.ok(result.value.description.includes('## 验收标准'))
  assert.equal(result.value.labels, '复杂度::M,类型::功能')
})

test('ensureDescriptionTemplate 对空描述给出可填模板', () => {
  const text = ensureDescriptionTemplate('')
  assert.ok(text.includes('## 任务目标'))
  assert.ok(text.includes('## 验收标准'))
  assert.equal(ensureDescriptionTemplate('## 任务目标\nx\n\n## 验收标准\n1. y'), '## 任务目标\nx\n\n## 验收标准\n1. y')
})

// ------------------------------------------------------------------ 提示词

test('buildWorkPrompt 带编号、链接与提交要求', () => {
  const prompt = buildWorkPrompt({
    repo: { projectPath: 'cbhw/cbhw-react-app' },
    issue: { iid: 12, title: '修复推送权限', web_url: 'http://x/12', labels: ['复杂度::M'], due_date: '2026-10-16' },
  })
  assert.ok(prompt.includes('#12'))
  assert.ok(prompt.includes('修复推送权限'))
  assert.ok(prompt.includes('cbhw/cbhw-react-app'))
  assert.ok(prompt.includes('gitlab_issue'))
  assert.equal(buildWorkPrompt({}), '')
})

test('buildCreateIssuePrompt 把需求原文交给 agent，并要求五必填', () => {
  const prompt = buildCreateIssuePrompt({
    repo: { projectPath: 'cbhw/cbhw-react-app' },
    requirement: '修一下导入按钮的样式',
    dueDate: '2026-10-16',
  })
  assert.ok(prompt.includes('修一下导入按钮的样式'))
  assert.ok(prompt.includes('gitlab-issue-workflow'))
  assert.ok(prompt.includes('gitlab_issue_create'))
  assert.ok(prompt.includes('2026-10-16'))
})

// -------------------------------------------------------------- REST 辅助

test('toBody 丢掉 null/undefined，toQuery 丢掉空值', () => {
  assert.equal(toBody({ a: 1, b: null, c: undefined, d: 'x' }), '{"a":1,"d":"x"}')
  assert.equal(toQuery({ state: 'opened', search: '', labels: null, page: 2 }), 'state=opened&page=2')
  assert.equal(toQuery({}), '')
})
