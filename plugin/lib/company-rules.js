/**
 * 公司 GitLab 判定 + 公司提交规范 + 新建议题的五必填校验。
 *
 * 行为对齐 F:\DSH_Work\gitlab-issue-bot 的 electron/core/git/companyRules.ts 与
 * skill gitlab-issue-workflow（同一套公司规范），但代码独立重写、纯 JS、无模型调用。
 */

import {
  LABEL_SEPARATOR,
  DEFAULT_COMPLEXITY_PREFIX,
  DEFAULT_TYPE_PREFIX,
  LabelCatalog,
} from './labels.js'

/** 只有这两个 host 算「公司 GitLab」；其余仓库不套用本规范。 */
export const DEFAULT_COMPANY_HOSTS = ['git.bobotechnology.cn:8000', '47.109.72.180:8000']

/** 允许的提交前缀（skill：前缀建议 feat/fix/refactor/docs）。 */
export const COMMIT_PREFIXES = ['feat', 'fix', 'refactor', 'docs']

/** 提交说明禁词（红线：禁用看不出做了什么的状态词）。 */
export const FORBIDDEN_WORDS = [
  '阶段提交', '阶段', '修改', '更新', '优化', '完善', '杂项', '临时', 'wip',
]

export const MAX_SUBJECT_LEN = 72

/** 一次提交里允许出现的不同 #编号 数量上限。 */
export const MAX_ISSUES_PER_COMMIT = 1

/** 规范要点（注入系统提示用的精简版；完整版在 skill gitlab-issue-workflow 里）。 */
export const RULES_SUMMARY =
  '公司 GitLab 仓库规范：开工前先看议题；提交信息必须带真实存在的 #编号，一次提交只关联一个议题；' +
  '提交前缀用 feat/fix/refactor/docs，说明要具体（禁「阶段提交」「修改」「更新」类词）；' +
  '新建、改动议题按 skill gitlab-issue-workflow 的五必填与标签规范执行。'

/** 判断 host 是否公司 GitLab（端口省略也认，域名与 IP 等价）。 */
export function isCompanyGitLabHost(host, hosts = DEFAULT_COMPANY_HOSTS) {
  if (!host) return false
  const normalized = normalizeHost(host)
  if (!normalized) return false
  const list = Array.isArray(hosts) && hosts.length > 0 ? hosts : DEFAULT_COMPANY_HOSTS
  return list.some((h) => {
    const candidate = normalizeHost(h)
    if (!candidate) return false
    return candidate === normalized || candidate.split(':')[0] === normalized
  })
}

/** 去掉协议、路径与 80/443 端口，留下可比较的 host[:port]。 */
export function normalizeHost(host) {
  return String(host ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, (m) => (m === ':80' || m === ':443' ? '' : m))
}

/** 本地日期格式化：YYYY-MM-DD。 */
export function formatDate(date) {
  const d = date instanceof Date ? date : new Date(date)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 本周五（今天就是周五则返回今天；周六周日取下周五）。 */
export function nextFriday(from = new Date()) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate())
  const dow = d.getDay() // 0=周日 … 5=周五
  const delta = dow <= 5 ? 5 - dow : 5 + (7 - dow)
  d.setDate(d.getDate() + delta)
  return formatDate(d)
}

export function isDateString(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value ?? '').trim())
}

/** 把描述补齐成规范模板（缺哪节补哪节，已有的内容不动）。 */
export function ensureDescriptionTemplate(description) {
  const text = String(description ?? '').trim()
  if (!text) return '## 任务目标\n（待补充）\n\n## 验收标准\n1. （待补充）'
  const parts = []
  if (!text.includes('## 任务目标')) parts.push('## 任务目标\n')
  parts.push(text)
  if (!text.includes('## 验收标准')) parts.push('\n\n## 验收标准\n1. （待补充）')
  return parts.join('')
}

/**
 * 新建议题的五必填校验与归一。
 * 复杂度/类型会用项目标签字典解析成真实标签名；截止日期默认本周五。
 *
 * @returns {{ ok: boolean, errors: string[], warnings: string[], value: {
 *   title: string, description: string, labels: string, dueDate: string, assigneeIds: number[]
 * } }}
 */
export function validateCreateIssue(input = {}, options = {}) {
  const catalog = options.catalog instanceof LabelCatalog ? options.catalog : LabelCatalog.empty()
  const today = options.today instanceof Date ? options.today : new Date()

  const errors = []
  const warnings = []

  const title = String(input.title ?? '').trim()
  if (!title) errors.push('标题必填')
  else if (title.length > 200) errors.push('标题过长（≤200 字）')

  const rawDescription = String(input.description ?? '').trim()
  if (!rawDescription) errors.push('描述必填（任务目标 + 验收标准）')

  const description = ensureDescriptionTemplate(rawDescription)
  if (rawDescription && !rawDescription.includes('## 任务目标')) warnings.push('描述缺少「## 任务目标」，已按模板补全')
  if (rawDescription && !rawDescription.includes('## 验收标准')) warnings.push('描述缺少「## 验收标准」，已按模板补全')

  const complexityInput = String(input.complexity ?? '').trim()
  const complexity = catalog.resolveComplexity(complexityInput || 'M') ||
    `${DEFAULT_COMPLEXITY_PREFIX}${LABEL_SEPARATOR}M`

  const typeInput = String(input.type ?? '').trim()
  const type = catalog.resolveType(typeInput || '功能') ||
    `${DEFAULT_TYPE_PREFIX}${LABEL_SEPARATOR}功能`

  const extraLabels = Array.isArray(input.extraLabels)
    ? input.extraLabels.map((s) => String(s ?? '').trim()).filter(Boolean)
    : []

  let dueDate = String(input.dueDate ?? '').trim()
  if (!dueDate) {
    dueDate = nextFriday(today)
    warnings.push(`截止日期缺省为本周五（${dueDate}）`)
  } else if (!isDateString(dueDate)) {
    errors.push('截止日期格式必须是 YYYY-MM-DD')
  }

  const assigneeIds = Array.isArray(input.assigneeIds)
    ? input.assigneeIds
      .map((n) => Number.parseInt(String(n), 10))
      .filter((n) => Number.isInteger(n) && n > 0)
    : []
  if (assigneeIds.length === 0) warnings.push('未指定指派人，将由调用方补成当前用户')

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    value: {
      title,
      description,
      labels: [...new Set([complexity, type, ...extraLabels])].join(','),
      dueDate,
      assigneeIds,
    },
  }
}
