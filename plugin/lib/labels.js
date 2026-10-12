/**
 * 项目标签字典的分组识别与短值解析。
 *
 * 行为对齐 F:\DSH_Work\gitlab-issue-bot 的 electron/core/gitlab/labelCatalog.ts，
 * 但代码是独立重写的纯 JS（插件免构建，不能引用那边的 TypeScript 源码）。
 * 这里没有任何模型调用：复杂度/类型分组是靠标签名前缀与取值特征推断出来的。
 */

export const LABEL_SEPARATOR = '::'
export const DEFAULT_COMPLEXITY_PREFIX = '复杂度'
export const DEFAULT_TYPE_PREFIX = '类型'

const COMPLEXITY_PREFIX_HINTS = [
  '复杂度', '难度', '规模', '工作量', '成本', '优先级',
  'complexity', 'effort', 'size', 'priority',
]

const TYPE_PREFIX_HINTS = ['类型', '类别', '分类', 'type', 'kind', 'category']

const TYPE_VALUE_HINTS = [
  '功能', '需求', '修复', '缺陷', 'bug', '重构', '文档', '优化',
  'feature', 'fix', 'refactor', 'docs',
]

/** 取标签的最后一段（`复杂度::M` → `M`）。 */
export function lastSegment(label) {
  const text = String(label ?? '').trim()
  const idx = text.lastIndexOf(LABEL_SEPARATOR)
  return idx >= 0 ? text.slice(idx + LABEL_SEPARATOR.length).trim() : text
}

/** 把任意写法归一到 S / M / L。 */
export function normalizeComplexityKey(raw) {
  const v = String(raw ?? '').trim().toUpperCase()
  if (!v) return ''
  if (v.startsWith('S') || /[小简易低]/.test(v) || v.includes('半天')) return 'S'
  if (v.startsWith('L') || /[大难高]/.test(v) || v.includes('复杂')) return 'L'
  return 'M'
}

/** 把任意写法归一到 功能 / 修复 / 重构 / 文档。 */
export function normalizeTypeKey(raw) {
  const v = String(raw ?? '').trim().toLowerCase()
  if (!v) return ''
  if (v.includes('修') || v.includes('bug') || v.includes('fix')) return '修复'
  if (v.includes('重构') || v.includes('refactor')) return '重构'
  if (v.includes('文档') || v.includes('doc')) return '文档'
  return '功能'
}

function isComplexityValue(value) {
  const v = String(value ?? '').trim().toUpperCase()
  if (v === 'S' || v === 'M' || v === 'L' || v === 'XS' || v === 'XL') return true
  return /[小中大难简易高低]/.test(v)
}

function isTypeValue(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return TYPE_VALUE_HINTS.some((h) => v.includes(h.toLowerCase()))
}

/**
 * 目标仓库的标签字典：从 `GET /projects/:id/labels` 的标签名里识别
 * 「复杂度组 / 类型组」，并把短值（M / 功能）解析成项目里真实存在的标签名。
 */
export class LabelCatalog {
  constructor(labelNames = []) {
    this.all = Array.from(new Set(
      (Array.isArray(labelNames) ? labelNames : [])
        .map((s) => String(s ?? '').trim())
        .filter(Boolean),
    ))

    this.groups = new Map()
    for (const name of this.all) {
      const idx = name.indexOf(LABEL_SEPARATOR)
      if (idx <= 0) continue
      const key = name.slice(0, idx).trim().toLowerCase()
      if (!key) continue
      const list = this.groups.get(key)
      if (list) list.push(name)
      else this.groups.set(key, [name])
    }

    this.complexityPrefix = this.#detectGroup(COMPLEXITY_PREFIX_HINTS, isComplexityValue)
    this.typePrefix = this.#detectGroup(TYPE_PREFIX_HINTS, isTypeValue)
  }

  static empty() {
    return new LabelCatalog([])
  }

  static from(labelNames) {
    return new LabelCatalog(labelNames)
  }

  labelsOf(prefix) {
    if (!prefix) return []
    return this.groups.get(String(prefix).toLowerCase()) ?? []
  }

  get complexityLabels() {
    return this.labelsOf(this.complexityPrefix)
  }

  get typeLabels() {
    return this.labelsOf(this.typePrefix)
  }

  /** 给界面/工具用：全部分组（前缀 → 标签）。 */
  groupList() {
    return Array.from(this.groups.entries()).map(([prefix, labels]) => ({ prefix, labels }))
  }

  resolveComplexity(key) {
    return this.#resolve(key, this.complexityPrefix, DEFAULT_COMPLEXITY_PREFIX, normalizeComplexityKey)
  }

  resolveType(key) {
    return this.#resolve(key, this.typePrefix, DEFAULT_TYPE_PREFIX, normalizeTypeKey)
  }

  #resolve(key, prefix, fallbackPrefix, normalize) {
    const raw = String(key ?? '').trim()
    if (!raw) return ''

    const exact = this.all.find((a) => a.toLowerCase() === raw.toLowerCase())
    if (exact) return exact

    const target = normalize(raw)
    if (prefix) {
      const list = this.labelsOf(prefix)
      const hit =
        list.find((l) => normalize(lastSegment(l)) === target) ??
        list.find((l) => lastSegment(l).toLowerCase() === raw.toLowerCase()) ??
        list.find((l) => lastSegment(l).toLowerCase().includes(raw.toLowerCase()))
      if (hit) return hit
    }

    return raw.includes(LABEL_SEPARATOR) ? raw : `${fallbackPrefix}${LABEL_SEPARATOR}${target || raw}`
  }

  #detectGroup(prefixHints, valueCheck) {
    for (const hint of prefixHints) {
      const hit = Array.from(this.groups.keys()).find((k) => k.includes(String(hint).toLowerCase()))
      if (hit) return hit
    }
    for (const [prefix, values] of this.groups.entries()) {
      if (values.length > 1 && values.length <= 8 && values.every((v) => valueCheck(lastSegment(v)))) {
        return prefix
      }
    }
    return null
  }
}
