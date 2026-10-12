/**
 * 工作区仓库探测：从会话 cwd 找出 .git，解析 remote，判断是否公司 GitLab。
 *
 * 不执行 git 命令（不发子进程、不弹窗），只读 .git/config；worktree / submodule
 * 的 `.git` 是文件（`gitdir: <path>`）也支持。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { isCompanyGitLabHost, normalizeHost } from './company-rules.js'

/** 解析 `git remote` 的 URL：http(s):// / git@host:path / ssh://git@host:port/path。 */
export function parseRemoteUrl(raw) {
  const url = String(raw ?? '').trim()
  if (!url) return null

  const isSchemeUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(url)
  if (!isSchemeUrl) {
    const scp = /^(?:([^@/\s]+)@)?([^/:\s]+):(.+)$/.exec(url)
    if (scp) return buildParsed(scp[2], '', scp[3], 'ssh', scp[1] ?? '')
    return null
  }

  try {
    const u = new URL(url)
    const scheme = u.protocol.replace(/:$/, '').toLowerCase()
    if (scheme !== 'http' && scheme !== 'https' && scheme !== 'ssh' && scheme !== 'git') return null
    return buildParsed(u.hostname, u.port, u.pathname, scheme, u.username)
  } catch {
    return null
  }
}

function buildParsed(host, port, pathname, scheme, user) {
  const hostLower = String(host ?? '').trim().toLowerCase()
  if (!hostLower) return null
  const projectPath = decodeURIComponent(String(pathname ?? ''))
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
  if (!projectPath) return null

  const portText = String(port ?? '').trim()
  const hostPort = normalizeHost(portText ? `${hostLower}:${portText}` : hostLower)
  const resolvedScheme = scheme === 'https' ? 'https' : scheme === 'git' ? 'git' : scheme === 'ssh' ? 'ssh' : 'http'

  return {
    scheme: resolvedScheme,
    user: String(user ?? ''),
    host: hostLower,
    port: portText,
    hostPort,
    projectPath,
  }
}

/** 解析 .git/config 文本里的全部 remote（origin 排最前）。 */
export function parseRemotes(configText) {
  const out = []
  let current = null

  for (const rawLine of String(configText ?? '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue

    const section = /^\[remote\s+"([^"]+)"\]$/.exec(line)
    if (section) {
      current = { name: section[1], url: '' }
      out.push(current)
      continue
    }
    if (line.startsWith('[')) {
      current = null
      continue
    }
    if (!current) continue

    const kv = /^url\s*=\s*(.*)$/.exec(line)
    if (kv) {
      const value = kv[1].trim().replace(/^"|"$/g, '')
      if (value) current.url = value
    }
  }

  return out
    .filter((r) => r.url)
    .sort((a, b) => (a.name === 'origin' ? -1 : 0) - (b.name === 'origin' ? -1 : 0))
}

/** 读某一目录自己的 .git/config（目录形态与 worktree 文件形态都支持）。 */
export function readGitConfigAt(dir) {
  const dotGit = join(dir, '.git')
  let st
  try {
    st = statSync(dotGit)
  } catch {
    return null
  }

  try {
    if (st.isDirectory()) {
      const cfg = join(dotGit, 'config')
      return { gitDir: dotGit, configText: existsSync(cfg) ? readFileSync(cfg, 'utf8') : '' }
    }
    if (st.isFile()) {
      const text = readFileSync(dotGit, 'utf8')
      const m = /^\s*gitdir:\s*(.+)$/im.exec(text)
      if (!m) return null
      const gitDir = isAbsolute(m[1].trim()) ? m[1].trim() : resolve(dir, m[1].trim())
      const cfg = join(gitDir, 'config')
      return { gitDir, configText: existsSync(cfg) ? readFileSync(cfg, 'utf8') : '' }
    }
  } catch {
    return null
  }
  return null
}

/** 从 cwd 向上找仓库根（最多 maxUp 层）。 */
export function findRepo(cwd, maxUp = 6) {
  let dir = resolve(String(cwd ?? '.'))
  for (let i = 0; i <= maxUp; i++) {
    const hit = readGitConfigAt(dir)
    if (hit) return { repoRoot: dir, gitDir: hit.gitDir, configText: hit.configText }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

/**
 * 命中公司 GitLab 时才返回信息，否则 null。
 * 多 remote 时逐个匹配（origin 优先）。
 */
export function detectCompanyRepo(cwd, hosts) {
  const repo = findRepo(cwd)
  if (!repo) return null

  for (const remote of parseRemotes(repo.configText)) {
    const parsed = parseRemoteUrl(remote.url)
    if (!parsed) continue
    if (!isCompanyGitLabHost(parsed.hostPort, hosts)) continue

    const webScheme = parsed.scheme === 'https' ? 'https' : 'http'
    const baseUrl = `${webScheme}://${parsed.hostPort}`
    return {
      repoRoot: repo.repoRoot,
      gitDir: repo.gitDir,
      remoteName: remote.name,
      remoteUrl: remote.url,
      scheme: parsed.scheme,
      hostPort: parsed.hostPort,
      projectPath: parsed.projectPath,
      baseUrl,
      webUrl: `${baseUrl}/${parsed.projectPath}`,
    }
  }

  return null
}

/** 所有 remote 的解析结果（诊断用，不判定公司）。 */
export function listRepoRemotes(cwd) {
  const repo = findRepo(cwd)
  if (!repo) return { repoRoot: null, remotes: [] }
  return {
    repoRoot: repo.repoRoot,
    remotes: parseRemotes(repo.configText).map((r) => ({ ...r, parsed: parseRemoteUrl(r.url) })),
  }
}
