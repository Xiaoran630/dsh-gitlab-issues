/**
 * dsh-gitlab-issues —— Client 半。
 *
 * 三处注册：
 *  1. conversation.input.left：输入框工具行里的「议题 N」小按钮，点开是插件自绘的 fixed 浮层
 *     （刻意不用 conversation.input.dock：那个位置会改变 composer 几何，连带挤错别的插件浮层）；
 *  2. main（key=gitlab-issues）+ sidebar.panellist：「议题」独立面板，项目选择 / 全量列表 / 详情 / 评论 / 关闭；
 *  3. settings.section：GitLab 地址白名单、PAT、注入开关、连接测试。
 *
 * 数据全部走同源 HTTP 路由 /dsh-gitlab-issues/api/*（Host 半），插件不含任何模型调用：
 * 「新建议题」只是把需求原文拼成提示词塞进输入框，由 DSH agent 调 gitlab_issue_create 完成。
 */

window.__ModuleLoader__.load({
  id: 'dsh-gitlab-issues',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState } = React
    // 展开的浮层优先用 portal 挂到 body：躲开 composer 的定位上下文，关闭即移除，不残留节点
    let ReactDOM = null
    try { ReactDOM = require('react-dom') } catch { ReactDOM = null }

    const ROUTE = '/dsh-gitlab-issues'

    const CSS = `
.dgi-dock{box-sizing:border-box;width:100%;flex:0 0 auto;align-self:stretch;min-height:34px;margin:0 0 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;overflow:hidden}
.dgi-dock-head{display:flex;align-items:center;gap:8px;padding:6px 10px;min-height:32px;box-sizing:border-box;flex-wrap:wrap}
.dgi-glyph{flex:none;display:block;color:currentColor}
.dgi-trigger{display:inline-flex;align-items:center;gap:5px;height:28px;box-sizing:border-box;padding:0 8px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:8px;font-size:12px;line-height:1;cursor:pointer;font-family:inherit;white-space:nowrap}
.dgi-trigger:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dgi-trigger.on{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}
.dgi-pop{position:fixed;z-index:80;box-sizing:border-box;max-height:min(60vh,520px);overflow:auto;padding:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;background:var(--dsw-alias-bg-overlay);color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px;box-shadow:0 12px 36px rgba(0,0,0,.28)}
.dgi-pop-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:4px 4px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);margin-bottom:4px}
.dgi-pager{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:6px 4px;border-top:1px solid var(--dsw-alias-border-l1);margin-top:4px}
.dgi-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-brand-primary);flex:none}
.dgi-title{font-weight:500}
.dgi-sub{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:38%}
.dgi-spacer{flex:1 1 auto}
.dgi-warn{color:var(--dsw-alias-label-secondary);font-size:12px}
.dgi-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);border-radius:7px;padding:2px 9px;font-size:12px;line-height:18px;cursor:pointer;font-family:inherit}
.dgi-btn:hover{border-color:var(--dsw-alias-brand-primary)}
.dgi-btn:disabled{opacity:.5;cursor:default}
.dgi-btn.primary{border-color:var(--dsw-alias-brand-primary)}
.dgi-body{border-top:1px solid var(--dsw-alias-border-l1);max-height:300px;overflow:auto;padding:4px 0}
.dgi-row{display:flex;align-items:center;gap:8px;padding:5px 10px;cursor:pointer}
.dgi-row:hover{background:var(--dsw-alias-bg-layer-2)}
.dgi-row.picked{background:color-mix(in srgb, var(--dsw-alias-brand-primary) 12%, transparent)}
.dgi-check{flex:none;margin:0;cursor:pointer}
.dgi-iid{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none;min-width:34px}
.dgi-rtitle{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dgi-chip{border:1px solid var(--dsw-alias-border-l1);border-radius:6px;padding:0 5px;font-size:11px;color:var(--dsw-alias-label-secondary);flex:none}
.dgi-meta{color:var(--dsw-alias-label-secondary);font-size:12px;flex:none}
.dgi-hint{padding:6px 10px;color:var(--dsw-alias-label-secondary);font-size:12px}
.dgi-pre{white-space:pre-wrap;word-break:break-all;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px;max-height:50vh;overflow:auto;margin:0}
.dgi-create{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 10px;display:flex;flex-direction:column;gap:6px}
.dgi-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:6px 8px;font-size:13px;font-family:inherit;resize:vertical;outline:none}
.dgi-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.dgi-notice{color:var(--dsw-alias-label-secondary);font-size:12px}
.dgi-panel{display:flex;flex-direction:column;gap:10px;padding:16px 20px;font-size:13px;color:var(--dsw-alias-label-primary);box-sizing:border-box}
.dgi-panel-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex:none}
.dgi-panel-title{font-size:15px;font-weight:600}
.dgi-input,.dgi-select{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 9px;font-size:13px;font-family:inherit;outline:none}
.dgi-select-sm{height:26px;padding:0 6px;font-size:12px;max-width:150px}
.dgi-input:focus,.dgi-select:focus{border-color:var(--dsw-alias-brand-primary)}
.dgi-split{display:flex;gap:12px;flex:1 1 auto;min-height:320px;max-height:calc(100vh - 260px)}
.dgi-list{flex:1 1 58%;min-width:0;min-height:0;max-height:calc(100vh - 230px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1)}
.dgi-detail{flex:1 1 42%;min-width:0;min-height:0;max-height:calc(100vh - 230px);overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:12px}
.dgi-detail h4{margin:0 0 6px;font-size:14px}
.dgi-kv{display:flex;gap:6px;flex-wrap:wrap;margin:6px 0}
.dgi-desc{white-space:pre-wrap;word-break:break-word;font-size:13px;line-height:21px;margin:8px 0}
.dgi-note{border-top:1px solid var(--dsw-alias-border-l1);padding:6px 0;font-size:12px;line-height:18px}
.dgi-note b{font-weight:500}
.dgi-empty{padding:16px;color:var(--dsw-alias-label-secondary);text-align:center}
.dgi-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:160px;overflow:auto}
.dgi-labelrow{display:flex;align-items:flex-start;gap:8px;margin:2px 0}
.dgi-labeltag{flex:0 0 48px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:26px}
.dgi-mask{position:fixed;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:60}
.dgi-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:16px 18px;min-width:340px;max-width:520px;box-shadow:0 12px 36px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary);font-size:13px}
.dgi-modal-title{font-size:14px;font-weight:600;margin-bottom:8px}
.dgi-modal-body{white-space:pre-wrap;word-break:break-word;line-height:20px;margin-bottom:12px;max-height:320px;overflow:auto}
.dgi-modal-actions{display:flex;justify-content:flex-end;gap:8px}
.dgi-settings{display:flex;flex-direction:column;gap:14px;padding:4px 0;font-size:13px;color:var(--dsw-alias-label-primary)}
.dgi-field{display:flex;flex-direction:column;gap:5px}
.dgi-field-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary)}
.dgi-field-help{font-size:12px;color:var(--dsw-alias-label-secondary);line-height:18px}
.dgi-inline{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dgi-switch{position:relative;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l1);cursor:pointer;transition:background .15s ease;flex:none;display:inline-block;border:none;padding:0}
.dgi-switch::after{content:"";position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.2);transition:transform .15s ease}
.dgi-switch.on{background:var(--dsw-alias-brand-primary)}
.dgi-switch.on::after{transform:translateX(16px)}
`

    function api(path, options) {
      return fetch(ROUTE + path, options).then(async (res) => {
        let data = null
        try { data = await res.json() } catch { data = null }
        if (!res.ok && !(data && data.ok === true)) {
          const message = (data && (data.error || data.message)) || ('HTTP ' + res.status)
          throw new Error(message)
        }
        return data
      })
    }

    function post(path, body) {
      return api(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    function fmtDate(value) {
      if (!value) return ''
      const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value))
      return m ? `${m[2]}-${m[3]}` : String(value).slice(0, 10)
    }

    function assigneeText(issue) {
      if (!issue || !Array.isArray(issue.assignees) || issue.assignees.length === 0) return ''
      return issue.assignees.map((a) => a.name || a.username).join('、')
    }

    function splitLabels(labels) {
      if (!Array.isArray(labels)) return { complexity: '', type: '', rest: [] }
      let complexity = ''
      let type = ''
      const rest = []
      for (const name of labels) {
        const text = String(name)
        if (!complexity && text.includes('::') && /::\s*[SMLX]/i.test(text)) { complexity = text; continue }
        if (!type && /^(类型|类别|分类|type|kind|category)\s*::/i.test(text)) { type = text; continue }
        rest.push(text)
      }
      return { complexity, type, rest }
    }

    // 会话内的议题条会把自己登记进来，这样全局面板也能把提示词送进对应会话的输入框
    // （面板是 root 作用域，拿不到 sessionId；宿主也没有"当前会话"的公开服务）
    const liveDocks = new Map()

    function registerDock(entry) {
      liveDocks.set(entry.sessionId, entry)
      return () => {
        if (liveDocks.get(entry.sessionId) === entry) liveDocks.delete(entry.sessionId)
      }
    }

    function pickDock(projectPath) {
      let best = null
      for (const entry of liveDocks.values()) {
        if (projectPath && entry.projectPath && entry.projectPath !== projectPath) continue
        if (!best || entry.updatedAt > best.updatedAt) best = entry
      }
      return best
    }

    /** 上一次由本插件写进输入框的完整文本：用于「再点一条议题就替换，而不是越堆越长」。 */
    let lastFilled = ''

    /** 把提示词送进某个会话的输入框（已有草稿则换行追加）。返回 'filled' | 'unavailable'。 */
    function fillIntoDock(entry, prompt) {
      if (!entry || typeof entry.actions !== 'function') return 'unavailable'
      const actions = entry.actions()
      if (!actions || typeof actions.setDraft !== 'function') return 'unavailable'
      const current = typeof entry.draft === 'function' ? String(entry.draft() || '') : ''
      let next
      if (!current.trim() || current === lastFilled) {
        next = prompt
      } else {
        next = current.replace(/\s+$/, '') + '\n\n' + prompt
      }
      actions.setDraft(next)
      lastFilled = next
      return 'filled'
    }

    async function copyText(text) {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(text)
          return true
        }
      } catch { /* ignore */ }
      return false
    }

    function IssueRow(props) {
      const issue = props.issue
      const parsed = splitLabels(issue.labels)
      const children = []
      if (props.selectable) {
        children.push(h('input', {
          type: 'checkbox',
          key: 'sel',
          className: 'dgi-check',
          checked: !!props.checked,
          'aria-label': `选择议题 #${issue.iid}`,
          title: '勾选后可多条一起开工',
          onClick: (event) => event.stopPropagation(),
          onChange: () => { if (props.onToggle) props.onToggle(issue) },
        }))
      }
      children.push(
        h('span', { className: 'dgi-iid', key: 'iid' }, '#' + issue.iid),
        h('span', { className: 'dgi-rtitle', key: 'title', title: issue.title }, issue.title),
      )
      if (parsed.complexity) children.push(h('span', { className: 'dgi-chip', key: 'cx' }, parsed.complexity))
      if (parsed.type) children.push(h('span', { className: 'dgi-chip', key: 'ty' }, parsed.type))
      for (const extra of parsed.rest.slice(0, 2)) children.push(h('span', { className: 'dgi-chip', key: 'l-' + extra }, extra))
      const who = assigneeText(issue)
      if (who) children.push(h('span', { className: 'dgi-meta', key: 'who' }, who))
      if (issue.due_date) children.push(h('span', { className: 'dgi-meta', key: 'due' }, '截止 ' + fmtDate(issue.due_date)))
      if (issue.state && issue.state !== 'opened') children.push(h('span', { className: 'dgi-chip', key: 'st' }, issue.state))
      if (props.onEdit) {
        children.push(h('button', {
          className: 'dgi-btn',
          key: 'edit',
          title: '编辑标题 / 描述 / 标签 / 指派 / 截止日期',
          onClick: (event) => { event.stopPropagation(); props.onEdit(issue) },
        }, '编辑'))
      }
      return h('div', {
        className: 'dgi-row' + (props.selectable && props.checked ? ' picked' : ''),
        role: 'button',
        tabIndex: 0,
        onClick: () => props.onPick && props.onPick(issue),
        onKeyDown: (event) => { if (event.key === 'Enter' && props.onPick) props.onPick(issue) },
      }, children)
    }

    function ConfirmModal(props) {
      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') props.onCancel && props.onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [props])
      return h('div', {
        className: 'dgi-mask',
        onClick: (event) => { if (event.target === event.currentTarget && props.onCancel) props.onCancel() },
      }, h('div', { className: 'dgi-modal', role: 'dialog', 'aria-modal': 'true' },
        h('div', { className: 'dgi-modal-title' }, props.title || '确认'),
        h('div', { className: 'dgi-modal-body' }, props.body || ''),
        h('div', { className: 'dgi-modal-actions' },
          h('button', { className: 'dgi-btn', onClick: () => props.onCancel && props.onCancel() }, '取消'),
          h('button', { className: 'dgi-btn primary', onClick: () => props.onConfirm && props.onConfirm(), disabled: !!props.busy }, props.busy ? '执行中…' : (props.confirmText || '确认')),
        ),
      ))
    }

    // ------------------------------------------------------------ 会话内议题条

    /** 把议题的标签数组拆成「复杂度 / 类型 / 其它」，供选择器回显。 */
    function splitLabelSelection(allLabels, complexityLabels, typeLabels) {
      const list = Array.isArray(allLabels) ? allLabels.map(String) : []
      const complexitySet = new Set(Array.isArray(complexityLabels) ? complexityLabels : [])
      const typeSet = new Set(Array.isArray(typeLabels) ? typeLabels : [])
      let complexity = ''
      let type = ''
      const extra = []
      for (const label of list) {
        if (!complexity && complexitySet.has(label)) { complexity = label; continue }
        if (!type && typeSet.has(label)) { type = label; continue }
        extra.push(label)
      }
      return { complexity, type, extra }
    }

    /** 标签显示短名：`复杂度::M` → `M`。 */
    function shortLabel(label) {
      const text = String(label ?? '')
      const idx = text.lastIndexOf('::')
      return idx >= 0 ? text.slice(idx + 2).trim() : text
    }

    /** 预设标签选择器：复杂度和类型各自单选，其它组多选。 */
    function LabelChips(props) {
      const labels = Array.isArray(props.labels) ? props.labels : []
      if (labels.length === 0) {
        return h('span', { className: 'dgi-field-help' }, props.emptyHint || '（项目里没有这一组标签）')
      }
      const selected = Array.isArray(props.selected) ? props.selected : []
      return h('div', { className: 'dgi-chips' }, labels.map((label) => {
        const on = selected.includes(label)
        return h('button', {
          key: label,
          type: 'button',
          className: 'dgi-btn' + (on ? ' primary' : ''),
          title: label,
          'aria-pressed': on ? 'true' : 'false',
          onClick: () => props.onToggle(label),
        }, shortLabel(label) + (on ? ' ✓' : ''))
      }))
    }

    function IssuesTrigger(props) {
      const sessionId = props.sessionId
      const ctx = props.ctx
      const [data, setData] = useState(null)
      const [error, setError] = useState('')
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(false)
      const [notice, setNotice] = useState('')
      const [anchor, setAnchor] = useState(null)
      const [assigneeId, setAssigneeId] = useState(0)
      const [members, setMembers] = useState([])
      const [page, setPage] = useState(1)
      const [selectedIids, setSelectedIids] = useState([])
      const alive = useRef(true)
      const dockEntry = useRef(null)
      const triggerRef = useRef(null)
      const popRef = useRef(null)
      const defaultApplied = useRef(false)

      // 宿主通过 standardProps 直接给到 inputActions（官方途径）；自己解析 conversation.input.for 只作兜底
      const actionsResolver = useCallback(() => {
        if (props.inputActions && typeof props.inputActions.setDraft === 'function') return props.inputActions
        return typeof props.resolveActions === 'function' ? props.resolveActions() : null
      }, [props])

      const draftReader = useCallback(
        () => (typeof props.getDraft === 'function' ? String(props.getDraft() || '') : ''),
        [props],
      )

      const load = useCallback(async (refresh) => {
        if (!sessionId) return
        setBusy(true)
        try {
          const next = await api('/api/state?sessionId=' + encodeURIComponent(sessionId) + (refresh ? '&refresh=1' : ''))
          if (!alive.current) return
          setData(next)
          // 首次拿到设置里的「默认筛选用户」就应用它（之后用户手选的优先）
          if (!defaultApplied.current) {
            defaultApplied.current = true
            const preferred = Number(next && next.defaultAssigneeId) || 0
            if (preferred > 0) setAssigneeId(preferred)
          }
          if (dockEntry.current) dockEntry.current.updatedAt = Date.now()
          setError(next && next.error && !next.repo ? next.error : '')
        } catch (err) {
          if (alive.current) setError(err && err.message ? err.message : String(err))
        } finally {
          if (alive.current) setBusy(false)
        }
      }, [sessionId])

      useEffect(() => {
        alive.current = true
        void load(false)
        return () => { alive.current = false }
      }, [load])

      const projectPath = (data && data.repo && data.repo.projectPath) || ''
      useEffect(() => {
        if (!sessionId) return undefined
        const entry = {
          sessionId,
          projectPath,
          updatedAt: Date.now(),
          actions: actionsResolver,
          draft: draftReader,
        }
        dockEntry.current = entry
        return registerDock(entry)
      }, [sessionId, projectPath, actionsResolver, draftReader])

      // 用户筛选用：该项目可指派成员（拉不到就只显示「全部用户」）
      useEffect(() => {
        if (!projectPath) {
          setMembers([])
          return undefined
        }
        let aliveFlag = true
        void (async () => {
          try {
            const res = await api('/api/members?project=' + encodeURIComponent(projectPath))
            if (aliveFlag) setMembers((res && res.members) || [])
          } catch {
            if (aliveFlag) setMembers([])
          }
        })()
        return () => { aliveFlag = false }
      }, [projectPath])

      const pollSeconds = data && Number(data.pollSeconds) || 60
      const polling = !!(data && data.repo && data.tokenConfigured && data.enabled !== false)
      useEffect(() => {
        if (!polling) return undefined
        const timer = window.setInterval(() => { void load(true) }, Math.max(15, pollSeconds) * 1000)
        return () => window.clearInterval(timer)
      }, [polling, pollSeconds, load])

      // 展开列表用我们自己的 fixed 浮层：位置自己算，既不改变 composer 高度，
      // 也不占用宿主的 conversation.input.overlay（那里被别的插件浮层共用）。
      const togglePopover = useCallback(() => {
        setNotice('')
        setOpen((wasOpen) => {
          if (wasOpen) return false
          const rect = triggerRef.current && triggerRef.current.getBoundingClientRect
            ? triggerRef.current.getBoundingClientRect()
            : null
          const viewportW = window.innerWidth || 900
          const viewportH = window.innerHeight || 700
          const width = Math.max(280, Math.min(440, viewportW - 32))
          const left = rect ? Math.max(8, Math.min(rect.left, viewportW - width - 8)) : 16
          const bottom = rect ? Math.max(8, viewportH - rect.top + 8) : 80
          setAnchor({ left, bottom, width })
          return true
        })
      }, [])

      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          const target = event.target
          if (triggerRef.current && triggerRef.current.contains(target)) return
          if (popRef.current && popRef.current.contains(target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => { if (event.key === 'Escape') setOpen(false) }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown, true)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown, true)
        }
      }, [open])

      const setDraft = useCallback((prompt) => {
        if (fillIntoDock(dockEntry.current, prompt) === 'filled') {
          setNotice('已填入输入框，按回车发送')
          return true
        }
        void copyText(prompt).then((ok) => {
          setNotice(ok ? '输入框通道不可用，任务提示词已复制到剪贴板' : '请手动复制任务提示词')
        })
        return false
      }, [])

      const fillWork = useCallback(async (issue) => {
        try {
          const res = await api('/api/prepare?sessionId=' + encodeURIComponent(sessionId) + '&iid=' + issue.iid)
          if (res && res.prompt) setDraft(res.prompt)
        } catch (err) {
          setNotice(err && err.message ? err.message : '生成提示词失败')
        }
      }, [sessionId, setDraft])

      // 新建议题：只把"引导语"送进 DSH 自带的输入框，需求由用户在那里写（插件不再单独开输入框）
      const fillCreateIntro = useCallback(async () => {
        try {
          const res = await api('/api/prepare?sessionId=' + encodeURIComponent(sessionId) + '&intent=create')
          if (res && res.prompt) setDraft(res.prompt)
        } catch (err) {
          setNotice(err && err.message ? err.message : '生成建议题引导失败')
        }
      }, [sessionId, setDraft])

      // 多选：勾若干条议题，合成一段"连续开工"的提示词填进输入框
      const toggleSelect = useCallback((issue) => {
        setSelectedIids((list) => (list.includes(issue.iid)
          ? list.filter((n) => n !== issue.iid)
          : [...list, issue.iid]))
      }, [])

      const fillMultiWork = useCallback(async () => {
        const iids = selectedIids.slice().sort((a, b) => a - b)
        if (iids.length === 0) return
        setNotice('')
        try {
          const res = await api('/api/prepare?sessionId=' + encodeURIComponent(sessionId) + '&iids=' + iids.join(','))
          if (res && res.prompt) {
            setDraft(res.prompt)
            setNotice(`已把 ${iids.length} 条议题的开工提示词填入输入框（不自动发送）`)
          }
        } catch (err) {
          setNotice(err && err.message ? err.message : '生成提示词失败')
        }
      }, [selectedIids, sessionId, setDraft])

      if (!data || data.enabled === false || !data.repo) {
        if (error && data === null) {
          console.warn('[dsh-gitlab-issues] state 读取失败：' + error)
        }
        return null
      }

      const openedAll = data.issues ? data.issues.filter((i) => i.state === 'opened') : []
      const opened = assigneeId > 0
        ? openedAll.filter((issue) => (issue.assignees || []).some((a) => Number(a && a.id) === assigneeId))
        : openedAll
      const perPage = 8
      const totalPages = Math.max(1, Math.ceil(opened.length / perPage))
      const currentPage = Math.min(page, totalPages)
      const visible = opened.slice((currentPage - 1) * perPage, currentPage * perPage)
      const repo = data.repo
      const memberName = (id) => {
        const hit = members.find((m) => Number(m.id) === Number(id))
        return hit ? (hit.name || hit.username) : ''
      }

      const trigger = h('button', {
        ref: triggerRef,
        type: 'button',
        className: 'dgi-trigger' + (open ? ' on' : ''),
        title: `${repo.projectPath} · ${opened.length} 条打开中的议题`,
        'aria-expanded': open ? 'true' : 'false',
        onClick: togglePopover,
      },
      h('svg', { className: 'dgi-glyph', width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
        h('path', { d: 'M2.5 4.3h11M2.5 8h11M2.5 11.7h6', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round' }),
        h('circle', { cx: 13, cy: 11.7, r: 1.7, fill: 'currentColor' })),
      h('span', null, `议题 ${opened.length}`))

      if (!open) return trigger

      const popover = h('div', {
        ref: popRef,
        className: 'dgi-pop',
        role: 'dialog',
        'aria-label': 'GitLab 议题',
        style: {
          left: (anchor ? anchor.left : 16) + 'px',
          bottom: (anchor ? anchor.bottom : 80) + 'px',
          width: (anchor ? anchor.width : 380) + 'px',
        },
      },
      h('div', { className: 'dgi-pop-head' },
        h('span', { className: 'dgi-title' }, `GitLab 议题 ${opened.length} 条`),
        h('span', { className: 'dgi-sub', title: repo.projectPath }, repo.projectPath),
        h('span', { className: 'dgi-spacer' }),
        h('select', {
          className: 'dgi-select dgi-select-sm',
          value: String(assigneeId),
          title: '按指派用户筛选',
          onChange: (event) => { setAssigneeId(Number.parseInt(event.target.value, 10) || 0); setPage(1) },
        }, [
          h('option', { key: 'all', value: '0' }, '全部用户'),
          ...members.map((member) => h('option', { key: 'u' + member.id, value: String(member.id) },
            member.name || member.username)),
        ]),
        h('button', { className: 'dgi-btn', onClick: () => void load(true), disabled: busy }, busy ? '刷新中…' : '刷新'),
        h('button', { className: 'dgi-btn primary', onClick: () => void fillCreateIntro() }, '＋ 新建议题'),
      ),
      assigneeId > 0
        ? h('div', { className: 'dgi-hint' }, `已按「${memberName(assigneeId) || ('用户 ' + assigneeId)}」筛选（全部 ${openedAll.length} 条）`)
        : null,
      data.tokenConfigured ? null : h('div', { className: 'dgi-hint' }, '未配置令牌（设置 → GitLab 议题）'),
      notice ? h('div', { className: 'dgi-hint' }, notice) : null,
      data.error ? h('div', { className: 'dgi-hint' }, data.error) : null,
      visible.length === 0
        ? h('div', { className: 'dgi-empty' }, data.tokenConfigured ? '当前没有打开的议题' : '配置令牌后即可看到议题')
        : visible.map((issue) => h(IssueRow, {
          key: issue.iid,
          issue,
          selectable: true,
          checked: selectedIids.includes(issue.iid),
          onToggle: toggleSelect,
          onPick: fillWork,
        })),
      h('div', { className: 'dgi-pager' },
        opened.length > perPage
          ? [
            h('button', { className: 'dgi-btn', key: 'prev', disabled: currentPage <= 1, onClick: () => setPage(currentPage - 1) }, '上一页'),
            h('span', { className: 'dgi-meta', key: 'info' }, `${currentPage} / ${totalPages} 页 · 共 ${opened.length} 条`),
            h('button', { className: 'dgi-btn', key: 'next', disabled: currentPage >= totalPages, onClick: () => setPage(currentPage + 1) }, '下一页'),
          ]
          : h('span', { className: 'dgi-meta', key: 'info' }, `共 ${opened.length} 条`),
        h('span', { className: 'dgi-spacer', key: 'sp' }),
        h('button', {
          className: 'dgi-btn',
          key: 'all',
          disabled: visible.length === 0,
          onClick: () => setSelectedIids((list) => {
            const ids = visible.map((i) => i.iid)
            const allOn = ids.length > 0 && ids.every((n) => list.includes(n))
            return allOn ? list.filter((n) => !ids.includes(n)) : Array.from(new Set([...list, ...ids]))
          }),
        }, '全选本页'),
        selectedIids.length > 0
          ? h('button', { className: 'dgi-btn', key: 'clear', onClick: () => setSelectedIids([]) }, '清空')
          : null,
        h('button', {
          className: 'dgi-btn primary',
          key: 'go',
          disabled: selectedIids.length === 0,
          onClick: () => void fillMultiWork(),
        }, `一起开工${selectedIids.length > 0 ? `（${selectedIids.length}）` : ''}`),
      ),
      h('div', { className: 'dgi-hint' }, '点议题 = 单条开工；勾选多条 = 「一起开工」（都是填进输入框，不自动发送）'))

      return h(React.Fragment, null, trigger,
        ReactDOM && ReactDOM.createPortal ? ReactDOM.createPortal(popover, document.body) : popover)
    }

    // -------------------------------------------------------------- 独立面板

    // 面板出错时不要把整块区域留白：显示原因与堆栈，便于定位（也避免"打开就是空白"）
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      componentDidCatch(error, info) {
        try { console.error('[dsh-gitlab-issues] 面板渲染失败', error, info) } catch { /* ignore */ }
      }

      render() {
        const error = this.state.error
        if (!error) return this.props.children
        const message = error && error.message ? error.message : String(error)
        const stack = error && error.stack ? String(error.stack) : ''
        return h('div', { className: 'dgi-panel' },
          h('div', { className: 'dgi-panel-head' },
            h('span', { className: 'dgi-panel-title' }, '议题面板渲染失败')),
          h('div', { className: 'dgi-hint' }, message),
          h('pre', { className: 'dgi-pre' }, stack.slice(0, 3000)),
          h('div', { className: 'dgi-inline' },
            h('button', {
              className: 'dgi-btn',
              onClick: () => this.setState({ error: null }),
            }, '重试')),
        )
      }
    }

    function IssuesPanel(props) {
      const ctx = props.ctx
      const [projects, setProjects] = useState([])
      const [tokenReady, setTokenReady] = useState(true)
      const [selected, setSelected] = useState(null)
      const [issues, setIssues] = useState([])
      const [total, setTotal] = useState(0)
      const [page, setPage] = useState(1)
      const [selectedIids, setSelectedIids] = useState([])
      const [filters, setFilters] = useState({ state: 'opened', search: '', labels: '', assigneeId: 0 })
      const [filterUsers, setFilterUsers] = useState([])
      const [meId, setMeId] = useState(0)
      const [defaultUserId, setDefaultUserId] = useState(0)
      const defaultAppliedRef = useRef(false)
      const [detail, setDetail] = useState(null)
      const [notes, setNotes] = useState([])
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      const [comment, setComment] = useState('')
      const [confirm, setConfirm] = useState(null)
      const [notice, setNotice] = useState('')
      const [editing, setEditing] = useState(null)
      const [editForm, setEditForm] = useState({ title: '', description: '', complexity: '', type: '', extraLabels: [], rawLabels: '', dueDate: '', assigneeIds: [] })
      const [editBusy, setEditBusy] = useState(false)
      const [editError, setEditError] = useState('')
      const [members, setMembers] = useState([])
      const [membersError, setMembersError] = useState('')
      const [creating, setCreating] = useState(false)
      const [createForm, setCreateForm] = useState({ title: '', description: '', complexity: '', type: '', extraLabels: [], rawLabels: '', dueDate: '', assigneeIds: [] })
      const [createBusy, setCreateBusy] = useState(false)
      const [createError, setCreateError] = useState('')
      const [labelsData, setLabelsData] = useState({ loaded: false, complexity: [], type: [], others: [] })
      const [labelsError, setLabelsError] = useState('')

      // 用户筛选器的候选（项目成员）+ 当前账号 + 设置里的默认用户
      const loadFilterData = useCallback(async (project) => {
        if (!project) return
        const query = new URLSearchParams({ project: project.projectPath, host: project.baseUrl })
        const qs = query.toString()
        const [membersRes, userRes, settingsRes] = await Promise.all([
          api('/api/members?' + qs).catch(() => null),
          api('/api/user?' + qs).catch(() => null),
          api('/api/settings').catch(() => null),
        ])
        setFilterUsers((membersRes && membersRes.members) || [])
        setMeId(Number(userRes && userRes.user && userRes.user.id) || 0)
        const preferred = Number(settingsRes && settingsRes.settings && settingsRes.settings.defaultAssigneeId) || 0
        setDefaultUserId(preferred)
        // 默认用户只在首次生效，之后以用户手选的为准
        if (preferred > 0 && !defaultAppliedRef.current) {
          defaultAppliedRef.current = true
          setFilters((f) => ({ ...f, assigneeId: f.assigneeId || preferred }))
        } else {
          defaultAppliedRef.current = true
        }
      }, [])

      const loadProjects = useCallback(async () => {
        try {
          const res = await api('/api/projects')
          const list = (res && res.projects) || []
          setProjects(list)
          setTokenReady(!res || res.tokenConfigured !== false)
          setSelected((current) => current && list.some((p) => p.projectPath === current.projectPath) ? current : (list[0] || null))
          if (list.length === 0) setError('没有检测到公司 GitLab 工作区：请用公司仓库目录作为工作区打开会话')
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        }
      }, [])

      // 选中项目变化时刷新筛选器候选
      useEffect(() => {
        if (!selected) return
        void loadFilterData(selected)
      }, [selected, loadFilterData])

      useEffect(() => { void loadProjects() }, [loadProjects])

      const loadIssues = useCallback(async (refresh) => {
        if (!selected) return
        if (!tokenReady) {
          setIssues([])
          setTotal(0)
          return
        }
        setBusy(true)
        setError('')
        try {
          if (refresh) await post('/api/refresh', { project: selected.projectPath, host: selected.baseUrl })
          const query = new URLSearchParams({
            project: selected.projectPath,
            host: selected.baseUrl,
            state: filters.state,
            search: filters.search,
            labels: filters.labels,
            assigneeId: filters.assigneeId > 0 ? String(filters.assigneeId) : '',
            limit: '100',
          })
          const res = await api('/api/issues?' + query.toString())
          setIssues((res && res.items) || [])
          setTotal((res && res.total) || 0)
          setPage(1)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [selected, filters, tokenReady])

      useEffect(() => { void loadIssues(false) }, [loadIssues])

      const openDetail = useCallback(async (issue) => {
        if (!selected) return null
        setDetail(issue)
        setNotes([])
        if (!tokenReady) return issue
        try {
          const query = new URLSearchParams({ project: selected.projectPath, host: selected.baseUrl, iid: String(issue.iid), notes: '1' })
          const res = await api('/api/issue?' + query.toString())
          if (res && res.issue) setDetail(res.issue)
          setNotes((res && res.notes) || [])
          return (res && res.issue) || issue
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
          return issue
        }
      }, [selected, tokenReady])

      // 项目标签字典：编辑/新建表单用选择器挑标签，不再手打文本
      const loadLabels = useCallback(async (force) => {
        const empty = { loaded: true, complexity: [], type: [], others: [] }
        if (!selected) return empty
        if (!force && labelsData.loaded) return labelsData
        try {
          const query = new URLSearchParams({ project: selected.projectPath, host: selected.baseUrl })
          const res = await api('/api/labels?' + query.toString())
          const next = {
            loaded: true,
            complexity: (res && res.complexity) || [],
            type: (res && res.type) || [],
            others: (res && res.others) || [],
          }
          setLabelsData(next)
          setLabelsError('')
          return next
        } catch (err) {
          setLabelsError(err && err.message ? err.message : '标签字典加载失败')
          setLabelsData(empty)
          return empty
        }
      }, [selected, labelsData])

      // 面板版「＋ 新建议题」：直接开手动新建对话框
      const openCreate = useCallback(async () => {
        if (!selected) return
        setCreateError('')
        setCreateForm({
          title: '',
          description: '## 任务目标\n\n## 验收标准\n1. ',
          complexity: '',
          type: '',
          extraLabels: [],
          rawLabels: '',
          dueDate: '',
          assigneeIds: [],
        })
        setMembers([])
        setMembersError('')
        setCreating(true)
        const labels = await loadLabels(false)
        // 默认复杂度 M、类型 功能（字典里存在才预选）
        const preferComplexity = labels.complexity.find((l) => /::\s*M$/i.test(l)) || ''
        const preferType = labels.type.find((l) => /功能/.test(l)) || ''
        setCreateForm((form) => ({ ...form, complexity: preferComplexity, type: preferType }))
        try {
          const query = new URLSearchParams({ project: selected.projectPath, host: selected.baseUrl })
          const res = await api('/api/members?' + query.toString())
          setMembers((res && res.members) || [])
        } catch (err) {
          setMembersError(err && err.message ? err.message : '成员列表加载失败')
        }
      }, [selected, loadLabels])

      const saveCreate = useCallback(async () => {
        if (!selected) return
        setCreateBusy(true)
        setCreateError('')
        try {
          const res = await post('/api/create', {
            project: selected.projectPath,
            host: selected.baseUrl,
            title: createForm.title,
            description: createForm.description,
            complexity: createForm.complexity,
            type: createForm.type,
            labels: createForm.extraLabels,
            labelsOverride: (createForm.rawLabels || '').trim(),
            dueDate: createForm.dueDate,
            assigneeIds: createForm.assigneeIds,
          })
          const issue = res && res.issue
          setCreating(false)
          setNotice(issue ? `已创建 #${issue.iid}「${issue.title}」` : '已创建')
          await loadIssues(true)
          if (issue) await openDetail(issue)
        } catch (err) {
          setCreateError(err && err.message ? err.message : String(err))
        } finally {
          setCreateBusy(false)
        }
      }, [selected, createForm, loadIssues, openDetail])

      // 查看 → 编辑：先拿全文（列表里的描述可能是简版），填进表单，并拉一次标签字典与可指派成员
      const startEdit = useCallback(async (issue) => {
        setNotice('')
        setEditError('')
        const full = await openDetail(issue)
        const target = full || issue
        setEditing(target)
        setMembers([])
        setMembersError('')
        const labels = await loadLabels(false)
        const picked = splitLabelSelection(target.labels, labels.complexity, labels.type)
        setEditForm({
          title: target.title || '',
          description: target.description || '',
          complexity: picked.complexity,
          type: picked.type,
          extraLabels: picked.extra,
          rawLabels: '',
          dueDate: target.due_date || '',
          assigneeIds: (target.assignees || [])
            .map((a) => Number(a && a.id))
            .filter((n) => Number.isInteger(n) && n > 0),
        })
        if (!selected) return
        try {
          const query = new URLSearchParams({ project: selected.projectPath, host: selected.baseUrl })
          const res = await api('/api/members?' + query.toString())
          setMembers((res && res.members) || [])
        } catch (err) {
          setMembersError(err && err.message ? err.message : '成员列表加载失败')
        }
      }, [openDetail, selected, loadLabels])

      const saveEdit = useCallback(async () => {
        if (!editing || !selected) return
        const payload = {
          project: selected.projectPath,
          host: selected.baseUrl,
          iid: editing.iid,
          title: editForm.title,
          description: editForm.description,
          labels: (editForm.rawLabels || '').trim()
            || [editForm.complexity, editForm.type, ...editForm.extraLabels].filter(Boolean).join(','),
          dueDate: editForm.dueDate,
          assigneeIds: editForm.assigneeIds,
        }
        setEditBusy(true)
        try {
          await post('/api/update', payload)
          setEditing(null)
          setNotice(`已保存 #${editing.iid} 的修改`)
          await loadIssues(true)
          await openDetail({ ...editing, title: editForm.title })
        } catch (err) {
          setEditError(err && err.message ? err.message : String(err))
        } finally {
          setEditBusy(false)
        }
      }, [editing, editForm, selected, loadIssues, openDetail])

      const removeIssue = useCallback((issue) => {
        setConfirm({
          title: '删除议题',
          body: `确认删除 #${issue.iid}「${issue.title}」？\n\n删除不可撤销，且需要 Owner 权限（没有权限会报 403）。`,
          doneText: `已删除 #${issue.iid}`,
          confirmText: '删除',
          run: () => post('/api/delete', { project: selected.projectPath, host: selected.baseUrl, iid: issue.iid }),
          afterRun: () => { setDetail(null); setNotes([]) },
        })
      }, [selected])

      const loadPrompt = useCallback(async (issue) => {
        if (!selected) return ''
        const query = new URLSearchParams({
          project: selected.projectPath,
          host: selected.baseUrl,
          iid: String(issue.iid),
          title: issue.title || '',
        })
        const res = await api('/api/prepare?' + query.toString())
        return (res && res.prompt) || ''
      }, [selected])

      const copyPrompt = useCallback(async (issue) => {
        if (!selected) return
        try {
          const prompt = await loadPrompt(issue)
          const ok = await copyText(prompt)
          setNotice(ok ? '任务提示词已复制，去会话输入框粘贴即可' : '复制失败')
        } catch (err) {
          setNotice(err && err.message ? err.message : '生成提示词失败')
        }
      }, [selected, loadPrompt])

      // 标签选择器（编辑/新建共用一个渲染器）：复杂度、类型各单选，其它前缀组多选
      const labelFields = (form, setForm) => {
        // 字典拉不到时（例如 Host 侧接口还没重启生效 / 网络失败）给文本兜底，别让标签根本没法填
        if (labelsError) {
          return h('div', { className: 'dgi-field' },
            h('span', { className: 'dgi-field-label' }, '标签'),
            h('span', { className: 'dgi-field-help' }, `标签字典没读到（${labelsError}）—— 可直接手填，英文逗号分隔。`),
            h('input', {
              className: 'dgi-input',
              placeholder: '复杂度::M,类型::修复',
              value: form.rawLabels || '',
              onChange: (event) => setForm((f) => ({ ...f, rawLabels: event.target.value })),
            }),
          )
        }
        return h('div', { className: 'dgi-field' },
        h('span', { className: 'dgi-field-label' }, '标签（从项目标签字典选：复杂度、类型各一个，其它可多选）'),
        h('div', { className: 'dgi-labelrow' },
          h('span', { className: 'dgi-labeltag' }, '复杂度'),
          h(LabelChips, {
            labels: labelsData.complexity,
            selected: form.complexity ? [form.complexity] : [],
            emptyHint: '（项目里没有识别出复杂度组）',
            onToggle: (label) => setForm((f) => ({ ...f, complexity: f.complexity === label ? '' : label })),
          }),
        ),
        h('div', { className: 'dgi-labelrow' },
          h('span', { className: 'dgi-labeltag' }, '类型'),
          h(LabelChips, {
            labels: labelsData.type,
            selected: form.type ? [form.type] : [],
            emptyHint: '（项目里没有识别出类型组）',
            onToggle: (label) => setForm((f) => ({ ...f, type: f.type === label ? '' : label })),
          }),
        ),
        labelsData.others.map((group) => h('div', { className: 'dgi-labelrow', key: 'g-' + group.prefix },
          h('span', { className: 'dgi-labeltag' }, group.prefix),
          h(LabelChips, {
            labels: group.labels,
            selected: form.extraLabels,
            onToggle: (label) => setForm((f) => ({
              ...f,
              extraLabels: f.extraLabels.includes(label)
                ? f.extraLabels.filter((x) => x !== label)
                : [...f.extraLabels, label],
            })),
          }),
        )),
        )
      }

      const assigneeFields = (form, setForm) => h('div', { className: 'dgi-field' },
        h('span', { className: 'dgi-field-label' },
          `指派（可多选，已选 ${form.assigneeIds.length} 人；一个都不选则默认指派给我）`),
        members.length === 0
          ? h('span', { className: 'dgi-field-help' }, membersError || '成员列表加载中…')
          : h('div', { className: 'dgi-chips' }, members.map((member) => {
            const on = form.assigneeIds.includes(member.id)
            return h('button', {
              key: 'm' + member.id,
              type: 'button',
              className: 'dgi-btn' + (on ? ' primary' : ''),
              onClick: () => setForm((f) => ({
                ...f,
                assigneeIds: on
                  ? f.assigneeIds.filter((id) => id !== member.id)
                  : [...f.assigneeIds, member.id],
              })),
            }, `${member.name || member.username}${on ? ' ✓' : ''}`)
          })),
      )

      const runConfirm = useCallback(async () => {
        if (!confirm) return
        setConfirm((current) => (current ? { ...current, busy: true } : current))
        try {
          await confirm.run()
          setNotice(confirm.doneText || '已完成')
          if (typeof confirm.afterRun === 'function') confirm.afterRun()
          setConfirm(null)
          await loadIssues(true)
          if (detail && !confirm.afterRun) await openDetail(detail)
        } catch (err) {
          setError(err && err.message ? err.message : String(err))
          setConfirm(null)
        }
      }, [confirm, detail, loadIssues, openDetail])

      const toggleSelect = useCallback((issue) => {
        setSelectedIids((list) => (list.includes(issue.iid)
          ? list.filter((n) => n !== issue.iid)
          : [...list, issue.iid]))
      }, [])

      const perPage = 20
      const pageCount = Math.max(1, Math.ceil(issues.length / perPage))
      const currentPage = Math.min(page, pageCount)
      const pageItems = issues.slice((currentPage - 1) * perPage, currentPage * perPage)
      const list = h('div', { className: 'dgi-list' },
        busy && issues.length === 0 ? h('div', { className: 'dgi-empty' }, '加载中…') : null,
        !busy && issues.length === 0 ? h('div', { className: 'dgi-empty' }, '没有匹配的议题') : null,
        pageItems.map((issue) => h(IssueRow, {
          key: issue.iid,
          issue,
          selectable: true,
          checked: selectedIids.includes(issue.iid),
          onToggle: toggleSelect,
          onPick: (picked) => { void openDetail(picked) },
          onEdit: (picked) => { void startEdit(picked) },
        })),
      )

      // 多选一起开工：面板里没有 sessionId，靠会话内入口登记表把提示词送进对应会话
      const fillMultiWork = useCallback(async () => {
        if (!selected) return
        const iids = selectedIids.slice().sort((a, b) => a - b)
        if (iids.length === 0) return
        try {
          const query = new URLSearchParams({
            project: selected.projectPath,
            host: selected.baseUrl,
            iids: iids.join(','),
          })
          const res = await api('/api/prepare?' + query.toString())
          const prompt = (res && res.prompt) || ''
          if (!prompt) {
            setNotice('生成提示词失败')
            return
          }
          const entry = pickDock(selected.projectPath)
          if (fillIntoDock(entry, prompt) === 'filled') {
            setNotice(`已把 ${iids.length} 条议题的开工提示词填入该工作区会话的输入框（不自动发送）`)
            return
          }
          const ok = await copyText(prompt)
          setNotice(ok
            ? `该工作区没有打开着的会话，${iids.length} 条议题的提示词已复制到剪贴板`
            : '没有可用会话，请手动复制提示词')
        } catch (err) {
          setNotice(err && err.message ? err.message : '生成提示词失败')
        }
      }, [selected, selectedIids])

      // ⚠️ 所有 hook 必须写在这个提前 return 之前：否则 projects 空/非空两条渲染路径的
      // hook 数量不一致，React 会抛 #310（Rendered more hooks than during the previous render），
      // 整个面板直接崩成空白。
      if (projects.length === 0) {
        return h('div', { className: 'dgi-panel' },
          h('div', { className: 'dgi-panel-head' }, h('span', { className: 'dgi-panel-title' }, '议题')),
          h('div', { className: 'dgi-empty' }, error || '没有检测到公司 GitLab 工作区'),
          h('div', { className: 'dgi-inline' },
            h('button', { className: 'dgi-btn', onClick: () => void loadProjects() }, '重新扫描'),
            h('button', {
              className: 'dgi-btn',
              onClick: () => {
                try { if (ctx && ctx.layout) ctx.layout.selectPanel('settings') } catch { /* 面板名不可用就忽略 */ }
              },
            }, '打开设置'),
          ),
        )
      }

      const pager = h('div', { className: 'dgi-pager' },
        issues.length > perPage
          ? [
            h('button', { className: 'dgi-btn', key: 'prev', disabled: currentPage <= 1, onClick: () => setPage(currentPage - 1) }, '上一页'),
            h('span', { className: 'dgi-meta', key: 'info' }, `第 ${currentPage} / ${pageCount} 页 · 共 ${issues.length} 条（服务端总计 ${total}）`),
            h('button', { className: 'dgi-btn', key: 'next', disabled: currentPage >= pageCount, onClick: () => setPage(currentPage + 1) }, '下一页'),
          ]
          : h('span', { className: 'dgi-meta', key: 'info' }, `共 ${issues.length} 条（服务端总计 ${total}）`),
        h('span', { className: 'dgi-spacer', key: 'sp' }),
        h('button', {
          className: 'dgi-btn',
          key: 'all',
          disabled: pageItems.length === 0,
          onClick: () => setSelectedIids((list) => {
            const ids = pageItems.map((i) => i.iid)
            const allOn = ids.length > 0 && ids.every((n) => list.includes(n))
            return allOn ? list.filter((n) => !ids.includes(n)) : Array.from(new Set([...list, ...ids]))
          }),
        }, '全选本页'),
        selectedIids.length > 0
          ? h('button', { className: 'dgi-btn', key: 'clear', onClick: () => setSelectedIids([]) }, '清空')
          : null,
        h('button', {
          className: 'dgi-btn primary',
          key: 'go',
          disabled: selectedIids.length === 0,
          onClick: () => void fillMultiWork(),
        }, `一起开工${selectedIids.length > 0 ? `（${selectedIids.length}）` : ''}`),
      )

      const detailView = detail ? h('div', { className: 'dgi-detail' },
        h('h4', null, `#${detail.iid} ${detail.title}`),
        h('div', { className: 'dgi-kv' },
          (detail.labels || []).map((label) => h('span', { className: 'dgi-chip', key: label }, label)),
          detail.due_date ? h('span', { className: 'dgi-meta' }, '截止 ' + fmtDate(detail.due_date)) : null,
        ),
        h('div', { className: 'dgi-kv' },
          h('span', { className: 'dgi-meta' }, '指派：' + (assigneeText(detail) || '无')),
          h('a', { className: 'dgi-meta', href: detail.web_url, target: '_blank', rel: 'noreferrer' }, '在 GitLab 打开'),
        ),
        h('div', { className: 'dgi-desc' }, detail.description || '（无描述）'),
        h('div', { className: 'dgi-inline' },
          h('button', { className: 'dgi-btn', onClick: () => void copyPrompt(detail) }, '复制开工提示词'),
          h('button', { className: 'dgi-btn', onClick: () => void startEdit(detail) }, '编辑'),
          detail.state === 'opened'
            ? h('button', {
              className: 'dgi-btn',
              onClick: () => setConfirm({
                title: '关闭议题',
                body: `确认关闭 #${detail.iid}「${detail.title}」？`,
                doneText: `已关闭 #${detail.iid}`,
                run: () => post('/api/close', { project: selected.projectPath, host: selected.baseUrl, iid: detail.iid }),
              }),
            }, '关闭议题')
            : h('button', {
              className: 'dgi-btn',
              onClick: () => setConfirm({
                title: '重新打开议题',
                body: `确认重新打开 #${detail.iid}「${detail.title}」？`,
                doneText: `已重新打开 #${detail.iid}`,
                run: () => post('/api/reopen', { project: selected.projectPath, host: selected.baseUrl, iid: detail.iid }),
              }),
            }, '重新打开'),
          h('button', {
            className: 'dgi-btn',
            onClick: () => removeIssue(detail),
          }, '删除议题'),
        ),
        h('div', { className: 'dgi-field' },
          h('span', { className: 'dgi-field-label' }, '加评论'),
          h('textarea', {
            className: 'dgi-textarea',
            rows: 2,
            value: comment,
            placeholder: '写点什么…（提交后立即出现在 GitLab）',
            onChange: (event) => setComment(event.target.value),
          }),
          h('div', { className: 'dgi-inline' },
            h('button', {
              className: 'dgi-btn primary',
              onClick: () => {
                const text = comment.trim()
                if (!text) return
                setConfirm({
                  title: '发表评论',
                  body: `在 #${detail.iid} 下评论：\n\n${text}`,
                  doneText: `已在 #${detail.iid} 发表评论`,
                  run: () => post('/api/comment', { project: selected.projectPath, host: selected.baseUrl, iid: detail.iid, body: text }),
                })
              },
            }, '发表评论'),
          ),
        ),
        notes.length > 0 ? h('div', null, h('div', { className: 'dgi-field-label' }, '最近评论'),
          notes.slice(0, 10).map((note, index) => h('div', { className: 'dgi-note', key: (note.id || index) },
            h('b', null, note.author || '某人'), ' · ' + fmtDate(note.created_at),
            h('div', null, note.body),
          )),
        ) : null,
      ) : h('div', { className: 'dgi-detail dgi-empty' }, '点左侧一条议题看详情')

      return h('div', { className: 'dgi-panel' },
        h('div', { className: 'dgi-panel-head' },
          h('span', { className: 'dgi-panel-title' }, 'GitLab 议题'),
          h('select', {
            className: 'dgi-select',
            value: selected ? selected.projectPath : '',
            onChange: (event) => {
              const next = projects.find((p) => p.projectPath === event.target.value)
              setSelected(next || null)
              setDetail(null)
            },
          }, projects.map((project) => h('option', { key: project.projectPath, value: project.projectPath },
            project.title && project.title !== project.projectPath
              ? `${project.projectPath}（${project.title}）`
              : project.projectPath))),
          h('select', {
            className: 'dgi-select',
            value: filters.state,
            onChange: (event) => setFilters((f) => ({ ...f, state: event.target.value })),
          }, [
            h('option', { key: 'opened', value: 'opened' }, '打开中'),
            h('option', { key: 'closed', value: 'closed' }, '已关闭'),
            h('option', { key: 'all', value: 'all' }, '全部'),
          ]),
          h('input', {
            className: 'dgi-input',
            placeholder: '关键词',
            value: filters.search,
            onChange: (event) => setFilters((f) => ({ ...f, search: event.target.value })),
          }),
          h('input', {
            className: 'dgi-input',
            placeholder: '标签筛选（逗号分隔）',
            value: filters.labels,
            onChange: (event) => setFilters((f) => ({ ...f, labels: event.target.value })),
          }),
          h('select', {
            className: 'dgi-select',
            value: String(filters.assigneeId),
            title: '按指派用户筛选（默认用户可在「设置 → GitLab 议题」里配）',
            onChange: (event) => setFilters((f) => ({ ...f, assigneeId: Number.parseInt(event.target.value, 10) || 0 })),
          }, [
            h('option', { key: 'all', value: '0' }, '全部用户'),
            ...filterUsers.map((member) => h('option', { key: 'u' + member.id, value: String(member.id) },
              (meId && Number(member.id) === meId ? '我 · ' : '') + (member.name || member.username))),
          ]),
          h('button', { className: 'dgi-btn', onClick: () => void loadIssues(true), disabled: busy }, busy ? '刷新中…' : '刷新'),
          h('span', { className: 'dgi-meta' }, `共 ${total} 条`),
          h('button', { className: 'dgi-btn primary', onClick: () => void openCreate() }, '＋ 新建议题'),
          h('button', { className: 'dgi-btn', onClick: () => void loadProjects() }, '重新扫描工作区'),
        ),
        notice ? h('div', { className: 'dgi-notice-row dgi-hint' }, notice) : null,
        tokenReady ? null : h('div', { className: 'dgi-hint' }, '未配置 GitLab 令牌：请在「设置 → GitLab 议题」粘贴个人访问令牌（PAT），或设置环境变量 GITLAB_TOKEN。'),
        error ? h('div', { className: 'dgi-hint' }, error) : null,
        h('div', { className: 'dgi-hint' }, '勾选多行 → 「一起开工」把这几条的开工提示词一次填进该工作区会话；点一行看详情；行内「编辑」可改标题/描述/标签/指派/截止；详情里可评论、关闭·重开、删除。'),
        h('div', { className: 'dgi-split' }, list, detailView),
        pager,
        confirm ? h(ConfirmModal, {
          title: confirm.title,
          body: confirm.body,
          busy: confirm.busy,
          confirmText: confirm.confirmText || '确认',
          onCancel: () => setConfirm(null),
          onConfirm: () => void runConfirm(),
        }) : null,
        editing ? h('div', {
          className: 'dgi-mask',
          onClick: (event) => { if (event.target === event.currentTarget) setEditing(null) },
        },
        h('div', { className: 'dgi-modal', role: 'dialog', 'aria-modal': 'true', style: { minWidth: '560px', maxWidth: '760px' } },
          h('div', { className: 'dgi-modal-title' }, `编辑议题 #${editing.iid}`),
          h('div', { className: 'dgi-field' },
            h('span', { className: 'dgi-field-label' }, '标题'),
            h('input', {
              className: 'dgi-input',
              value: editForm.title,
              onChange: (event) => setEditForm((f) => ({ ...f, title: event.target.value })),
            }),
          ),
          h('div', { className: 'dgi-field' },
            h('span', { className: 'dgi-field-label' }, '描述（Markdown）'),
            h('textarea', {
              className: 'dgi-textarea',
              rows: 10,
              value: editForm.description,
              onChange: (event) => setEditForm((f) => ({ ...f, description: event.target.value })),
            }),
          ),
          labelFields(editForm, setEditForm),
          h('div', { className: 'dgi-field', style: { maxWidth: '200px' } },
            h('span', { className: 'dgi-field-label' }, '截止日期'),
            h('input', {
              className: 'dgi-input',
              type: 'date',
              value: editForm.dueDate || '',
              onChange: (event) => setEditForm((f) => ({ ...f, dueDate: event.target.value })),
            }),
          ),
          assigneeFields(editForm, setEditForm),
          editError ? h('div', { className: 'dgi-hint' }, editError) : null,
          h('div', { className: 'dgi-modal-actions' },
            h('button', { className: 'dgi-btn', disabled: editBusy, onClick: () => setEditing(null) }, '取消'),
            h('button', { className: 'dgi-btn primary', disabled: editBusy, onClick: () => void saveEdit() }, editBusy ? '保存中…' : '保存'),
          ),
        )) : null,
        creating ? h('div', {
          className: 'dgi-mask',
          onClick: (event) => { if (event.target === event.currentTarget) setCreating(false) },
        },
        h('div', { className: 'dgi-modal', role: 'dialog', 'aria-modal': 'true', style: { minWidth: '560px', maxWidth: '760px' } },
          h('div', { className: 'dgi-modal-title' }, `新建议题${selected ? ' · ' + selected.projectPath : ''}`),
          h('div', { className: 'dgi-field' },
            h('span', { className: 'dgi-field-label' }, '标题（一句话、可验收，别用「优化/完善」这类词）'),
            h('input', {
              className: 'dgi-input',
              value: createForm.title,
              onChange: (event) => setCreateForm((f) => ({ ...f, title: event.target.value })),
            }),
          ),
          h('div', { className: 'dgi-field' },
            h('span', { className: 'dgi-field-label' }, '描述（Markdown，含「## 任务目标」「## 验收标准」）'),
            h('textarea', {
              className: 'dgi-textarea',
              rows: 9,
              value: createForm.description,
              onChange: (event) => setCreateForm((f) => ({ ...f, description: event.target.value })),
            }),
          ),
          labelFields(createForm, setCreateForm),
          h('div', { className: 'dgi-field', style: { maxWidth: '220px' } },
            h('span', { className: 'dgi-field-label' }, '截止日期（留空则默认本周五）'),
            h('input', {
              className: 'dgi-input',
              type: 'date',
              value: createForm.dueDate || '',
              onChange: (event) => setCreateForm((f) => ({ ...f, dueDate: event.target.value })),
            }),
          ),
          assigneeFields(createForm, setCreateForm),
          createError ? h('div', { className: 'dgi-hint' }, createError) : null,
          h('div', { className: 'dgi-modal-actions' },
            h('button', { className: 'dgi-btn', disabled: createBusy, onClick: () => setCreating(false) }, '取消'),
            h('button', { className: 'dgi-btn primary', disabled: createBusy, onClick: () => void saveCreate() }, createBusy ? '创建中…' : '创建'),
          ),
        )) : null,
      )
    }

    // ---------------------------------------------------------------- 设置页

    function SettingsPanel() {
      const [settings, setSettings] = useState(null)
      const [hostsText, setHostsText] = useState('')
      const [token, setToken] = useState('')
      const [status, setStatus] = useState('')
      const [busy, setBusy] = useState(false)
      const [defaultMembers, setDefaultMembers] = useState([])

      // 默认用户的可选来源：任一已知项目的成员列表
      const loadDefaultMembers = useCallback(async () => {
        try {
          const projRes = await api('/api/projects')
          const first = (projRes && projRes.projects && projRes.projects[0]) || null
          if (!first) return
          const query = new URLSearchParams({ project: first.projectPath, host: first.baseUrl })
          const res = await api('/api/members?' + query.toString())
          setDefaultMembers((res && res.members) || [])
        } catch { /* 拿不到就只留「用当前登录账号」这条路 */ }
      }, [])

      useEffect(() => { void loadDefaultMembers() }, [loadDefaultMembers])

      const useCurrentAccount = useCallback(async () => {
        setBusy(true)
        setStatus('读取当前登录账号…')
        try {
          const res = await api('/api/user')
          const user = res && res.user
          if (!user || !user.id) throw new Error('没拿到账号信息（先确认令牌可用）')
          const saved = await post('/api/settings', {
            defaultAssigneeId: Number(user.id),
            defaultAssigneeName: String(user.name || user.username || ''),
          })
          if (saved && saved.settings) setSettings(saved.settings)
          setStatus(`默认筛选用户 = ${user.name || user.username}（id ${user.id}）`)
        } catch (err) {
          setStatus('设置失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setBusy(false)
        }
      }, [])

      const load = useCallback(async () => {
        try {
          const res = await api('/api/settings')
          const next = (res && res.settings) || null
          setSettings(next)
          setHostsText(next ? (next.hosts || []).join('\n') : '')
        } catch (err) {
          setStatus(err && err.message ? err.message : String(err))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const save = useCallback(async (patch) => {
        setBusy(true)
        setStatus('')
        try {
          const body = { ...(patch || {}) }
          if (hostsText.trim()) body.hosts = hostsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
          const res = await post('/api/settings', body)
          if (res && res.settings) {
            setSettings(res.settings)
            setHostsText((res.settings.hosts || []).join('\n'))
          }
          setToken('')
          setStatus(res && res.tokenSavedTo === 'credentials' ? '已保存（令牌存入 DSH 凭据库）' : '已保存')
        } catch (err) {
          setStatus(err && err.message ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }, [hostsText])

      const test = useCallback(async () => {
        setBusy(true)
        setStatus('连接测试中…')
        try {
          const res = await post('/api/test', {})
          setStatus(res && res.ok ? (res.message || '连接成功') : ('连接失败：' + ((res && res.error) || '未知原因')))
        } catch (err) {
          setStatus('连接失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setBusy(false)
        }
      }, [])

      // 粘贴令牌后一步到位：先存，再用"刚输入的这串"直接测（避免拿旧令牌测出新结果）
      const saveAndTest = useCallback(async () => {
        const fresh = token.trim()
        setBusy(true)
        setStatus(fresh ? '保存并用新令牌测试…' : '测试已保存的令牌…')
        try {
          if (fresh) {
            const body = { token: fresh }
            if (hostsText.trim()) body.hosts = hostsText.split(/[\n,]/).map((s) => s.trim()).filter(Boolean)
            const saved = await post('/api/settings', body)
            if (saved && saved.settings) {
              setSettings(saved.settings)
              setHostsText((saved.settings.hosts || []).join('\n'))
            }
            setToken('')
          }
          const res = await post('/api/test', fresh ? { token: fresh } : {})
          setStatus(res && res.ok ? (res.message || '连接成功') : ('连接失败：' + ((res && res.error) || '未知原因')))
        } catch (err) {
          setStatus('失败：' + (err && err.message ? err.message : String(err)))
        } finally {
          setBusy(false)
        }
      }, [token, hostsText])

      if (!settings) {
        return h('div', { className: 'dgi-settings' }, h('div', { className: 'dgi-field-help' }, status || '加载中…'))
      }

      return h('div', { className: 'dgi-settings' },
        h('div', { className: 'dgi-inline' },
          h('button', {
            className: 'dgi-switch' + (settings.enabled ? ' on' : ''),
            role: 'switch',
            'aria-checked': settings.enabled ? 'true' : 'false',
            'aria-label': '启用插件',
            onClick: () => void save({ enabled: !settings.enabled }),
          }),
          h('span', null, '启用 GitLab 议题插件（关闭后不再注册工具与界面）'),
        ),
        h('div', { className: 'dgi-field' },
          h('span', { className: 'dgi-field-label' }, '个人访问令牌（PAT）'),
          h('div', { className: 'dgi-inline' },
            h('input', {
              className: 'dgi-input',
              type: 'password',
              style: { minWidth: '320px' },
              placeholder: settings.tokenConfigured ? `已配置 ${settings.tokenHint || ''}（重填可覆盖）` : '粘贴 GitLab 个人访问令牌',
              value: token,
              onChange: (event) => setToken(event.target.value),
            }),
            h('button', { className: 'dgi-btn primary', disabled: busy, onClick: () => void saveAndTest() }, busy ? '处理中…' : '保存并测试'),
            h('button', { className: 'dgi-btn', disabled: busy || !settings.tokenConfigured, onClick: () => void test() }, '只测已保存的令牌'),
            h('button', { className: 'dgi-btn', disabled: busy || !settings.tokenConfigured, onClick: () => void save({ clearToken: true }) }, '清除令牌'),
          ),
          h('span', { className: 'dgi-field-help' },
            '粘贴令牌后直接点「保存并测试」即可：它会先用这串新令牌验证，通过才说成功（不会拿旧的已保存令牌糊弄你）。'),
          h('span', { className: 'dgi-field-help' },
            '优先写入 DSH 凭据库（环境变量名 ' + (settings.tokenRef || 'GITLAB_TOKEN') + '），也可直接设置同名环境变量；令牌只走 PRIVATE-TOKEN 请求头，不写进 URL。'),
          h('span', { className: 'dgi-field-help' }, '当前状态：' + (settings.tokenConfigured ? '已配置' : '未配置')),
        ),
        h('div', { className: 'dgi-field' },
          h('span', { className: 'dgi-field-label' }, '公司 GitLab 地址（每行一个，可含端口）'),
          h('textarea', {
            className: 'dgi-textarea',
            rows: 3,
            value: hostsText,
            onChange: (event) => setHostsText(event.target.value),
          }),
          h('span', { className: 'dgi-field-help' }, '只有 remote 指向这里列出的地址时，插件才会工作（默认两条公司地址，同仓库的其它入口可自行追加）。'),
        ),
        h('div', { className: 'dgi-field' },
          h('span', { className: 'dgi-field-label' }, '默认筛选用户（议题浮层与面板打开时默认按他筛）'),
          h('div', { className: 'dgi-inline' },
            h('span', { className: 'dgi-meta' },
              settings.defaultAssigneeId > 0
                ? `${settings.defaultAssigneeName || ('用户 ' + settings.defaultAssigneeId)}（id ${settings.defaultAssigneeId}）`
                : '未设置 —— 默认看全部'),
            h('button', { className: 'dgi-btn', disabled: busy, onClick: () => void useCurrentAccount() }, '用当前登录账号'),
            h('select', {
              className: 'dgi-select',
              value: '',
              disabled: busy || defaultMembers.length === 0,
              onChange: (event) => {
                const id = Number.parseInt(event.target.value, 10) || 0
                if (id <= 0) return
                const hit = defaultMembers.find((m) => Number(m.id) === id)
                void save({ defaultAssigneeId: id, defaultAssigneeName: hit ? (hit.name || hit.username) : '' })
              },
            }, [
              h('option', { key: 'pick', value: '' }, defaultMembers.length > 0 ? '从项目成员里选…' : '（没有已知项目）'),
              ...defaultMembers.map((m) => h('option', { key: 'u' + m.id, value: String(m.id) }, m.name || m.username)),
            ]),
            h('button', {
              className: 'dgi-btn',
              disabled: busy || !settings.defaultAssigneeId,
              onClick: () => void save({ defaultAssigneeId: 0, defaultAssigneeName: '' }),
            }, '清除（=全部）'),
          ),
          h('span', { className: 'dgi-field-help' }, '浮层与面板里的「用户筛选」下拉仍可随时改成别人或「全部用户」，这里只决定默认值。'),
        ),
        h('div', { className: 'dgi-inline' },
          h('button', {
            className: 'dgi-switch' + (settings.injectPrompt ? ' on' : ''),
            role: 'switch',
            'aria-checked': settings.injectPrompt ? 'true' : 'false',
            'aria-label': '注入工作区议题上下文',
            onClick: () => void save({ injectPrompt: !settings.injectPrompt }),
          }),
          h('span', null, '把「本工作区项目 + 打开议题摘要」注入会话上下文（默认开）'),
        ),
        h('div', { className: 'dgi-field' },
          h('span', { className: 'dgi-field-label' }, '界面轮询间隔（秒，15–600）'),
          h('div', { className: 'dgi-inline' },
            h('input', {
              className: 'dgi-input',
              type: 'number',
              min: 15,
              max: 600,
              style: { width: '110px' },
              value: settings.pollSeconds || 60,
              onChange: (event) => {
                const value = Number(event.target.value) || 60
                setSettings((current) => ({ ...current, pollSeconds: value }))
              },
            }),
            h('button', { className: 'dgi-btn', disabled: busy, onClick: () => void save({ pollSeconds: settings.pollSeconds }) }, '保存间隔'),
          ),
        ),
        h('div', { className: 'dgi-inline' },
          h('button', { className: 'dgi-btn primary', disabled: busy, onClick: () => void save({}) }, '保存地址白名单'),
          h('span', { className: 'dgi-field-help' }, status),
        ),
        h('div', { className: 'dgi-field-help' }, '设置文件：' + (settings.settingsPath || '')),
      )
    }

    // ------------------------------------------------------------------ apply

    const inject = ['slots']

    function apply(ctx) {
      const styleEl = document.createElement('style')
      styleEl.dataset.plugin = 'dsh-gitlab-issues'
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      ctx.effect(() => () => { styleEl.remove() }, 'dsh-gitlab-issues: styles')

      const slots = ctx.get('slots')
      if (slots === undefined) return

      const resolveShell = (sessionId) => {
        try {
          if (!ctx.sessions || typeof ctx.sessions.scope !== 'function') return null
          const actx = ctx.sessions.scope(sessionId)
          if (!actx || typeof actx.get !== 'function') return null
          const conversation = actx.get('conversation')
          if (!conversation || !conversation.input || typeof conversation.input.for !== 'function') return null
          return conversation.input.for(actx)
        } catch {
          return null
        }
      }

      // 会话内入口：输入框工具行里的一个小按钮（和表情按钮同排）。
      // 刻意不用 conversation.input.dock —— 那个位置在 composer 卡片上方，插进去会改变
      // 整块几何，把同一个 composer 浮层容器里其它插件（表情面板、技能搜索）一起挤错位。
      slots.inject('conversation.input.left', () => slots.register({
        name: 'conversation.input.left',
        id: 'gitlab-issues',
        order: 6,
        label: 'GitLab 议题',
        inject: (sessionId) => ({
          sessionId,
          ctx,
          resolveActions: () => {
            const shell = resolveShell(sessionId)
            return shell && shell.actions ? shell.actions : null
          },
          getDraft: () => {
            const shell = resolveShell(sessionId)
            const snapshot = shell && shell.snapshot
            return snapshot && typeof snapshot.draft === 'string' ? snapshot.draft : ''
          },
        }),
      }, IssuesTrigger))

      // 独立面板 + 左侧栏入口
      slots.inject('main', () => slots.register({
        name: 'main',
        key: 'gitlab-issues',
      }, () => h(PanelBoundary, null, h(IssuesPanel, { ctx }))))

      slots.inject('sidebar.panellist', () => slots.register({
        name: 'sidebar.panellist',
        id: 'gitlab-issues',
        order: 30,
        label: '议题',
      }, function IssuesGlyph(glyphProps) {
        const size = (glyphProps && glyphProps.size) || 18
        return h('svg', { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
          h('path', { d: 'M2.5 4.3h11M2.5 8h11M2.5 11.7h6', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
          h('circle', { cx: 13, cy: 11.7, r: 1.7, fill: 'currentColor' }),
        )
      }))

      // 设置页
      slots.inject('settings.section', () => slots.register({
        name: 'settings.section',
        id: 'gitlab-issues',
        order: 40,
        label: 'GitLab 议题',
      }, () => h(SettingsPanel, null)))
    }

    exports.apply = apply
    exports.inject = inject
    return module.exports
  },
})
