/**
 * 插件自己的设置文件（~/.dsh/dsh-gitlab-issues.json）。
 * 令牌优先放 DSH 凭据服务（ctx.credentials），本文件里的 token 只是兜底。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_COMPANY_HOSTS } from './company-rules.js'

export const SETTINGS_FILE = 'dsh-gitlab-issues.json'
export const TOKEN_REF = 'GITLAB_TOKEN'

export function dshHome() {
  const home = process.env.DSH_HOME
  return home && home.trim() ? home.trim() : join(homedir(), '.dsh')
}

export function settingsPath() {
  return join(dshHome(), SETTINGS_FILE)
}

export function defaultSettings() {
  return {
    version: 1,
    enabled: true,
    hosts: [...DEFAULT_COMPANY_HOSTS],
    tokenRef: TOKEN_REF,
    token: '',
    injectPrompt: true,
    pollSeconds: 60,
    // 默认筛选用户：0 表示不筛选（全部）；名字只用于界面显示
    defaultAssigneeId: 0,
    defaultAssigneeName: '',
  }
}

function sanitize(raw) {
  const base = defaultSettings()
  const input = raw && typeof raw === 'object' ? raw : {}
  const hosts = Array.isArray(input.hosts)
    ? input.hosts.map((h) => String(h ?? '').trim()).filter(Boolean)
    : base.hosts
  const poll = Number.parseInt(String(input.pollSeconds ?? base.pollSeconds), 10)
  const assigneeRaw = Number.parseInt(String(input.defaultAssigneeId ?? base.defaultAssigneeId), 10)
  return {
    version: 1,
    enabled: input.enabled !== false,
    hosts: hosts.length > 0 ? Array.from(new Set(hosts)) : base.hosts,
    tokenRef: String(input.tokenRef ?? base.tokenRef).trim() || base.tokenRef,
    token: typeof input.token === 'string' ? input.token.trim() : '',
    injectPrompt: input.injectPrompt !== false,
    pollSeconds: Number.isFinite(poll) ? Math.min(Math.max(poll, 15), 600) : base.pollSeconds,
    defaultAssigneeId: Number.isFinite(assigneeRaw) && assigneeRaw > 0 ? assigneeRaw : 0,
    defaultAssigneeName: typeof input.defaultAssigneeName === 'string'
      ? input.defaultAssigneeName.trim().slice(0, 80)
      : '',
  }
}

export function readSettings() {
  const file = settingsPath()
  try {
    if (!existsSync(file)) return defaultSettings()
    return sanitize(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return defaultSettings()
  }
}

/** 原子写（临时文件 + rename），避免并发写坏。 */
export function writeSettings(patch) {
  const next = sanitize({ ...readSettings(), ...(patch && typeof patch === 'object' ? patch : {}) })
  const file = settingsPath()
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  try {
    mkdirSync(dshHome(), { recursive: true })
    writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    try { if (existsSync(tmp)) unlinkSync(tmp) } catch { /* ignore */ }
    throw error
  }
  return next
}

/** 给界面看的设置（令牌只回是否已配置与掩码）。 */
export function publicSettings(settings, tokenConfigured) {
  const s = settings ?? readSettings()
  const token = String(s.token ?? '')
  return {
    enabled: s.enabled,
    hosts: s.hosts,
    tokenRef: s.tokenRef,
    tokenConfigured: !!tokenConfigured || !!token,
    tokenHint: token ? maskToken(token) : '',
    injectPrompt: s.injectPrompt,
    pollSeconds: s.pollSeconds,
    defaultAssigneeId: Number(s.defaultAssigneeId) || 0,
    defaultAssigneeName: String(s.defaultAssigneeName || ''),
    settingsPath: settingsPath(),
  }
}

export function maskToken(token) {
  const text = String(token ?? '').trim()
  if (!text) return ''
  return text.length <= 6 ? `${text.slice(0, 2)}****` : `${text.slice(0, 6)}****${text.slice(-2)}`
}
