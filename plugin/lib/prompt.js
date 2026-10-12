/**
 * 提示词模板：全部是「让 DSH agent 去干活」的文本，插件自己不调用任何模型。
 * 一条是"按议题开工"，一条是"新建议题"。
 */

/** 按议题开工：点议题条/列表里的某条议题时填进输入框。 */
export function buildWorkPrompt({ issue, repo }) {
  if (!issue) return ''
  const lines = [
    `按公司 GitLab 议题 #${issue.iid}「${issue.title}」开工。`,
  ]
  if (repo?.projectPath) {
    lines.push(`项目：${repo.projectPath}${issue.web_url ? `（${issue.web_url}）` : ''}`)
  }
  if (issue.due_date) lines.push(`截止日期：${issue.due_date}`)
  if (Array.isArray(issue.labels) && issue.labels.length > 0) {
    lines.push(`标签：${issue.labels.join('、')}`)
  }
  lines.push('')
  lines.push('请先用 gitlab_issue 拉取该议题的完整描述与验收标准，再开始实现。')
  lines.push(`提交信息带 #${issue.iid} 关联，一次提交只关联一个议题。`)
  return lines.join('\n')
}

/** 新建议题：把需求原文交给 DSH agent，由它补齐五必填后调用 gitlab_issue_create。 */
export function buildCreateIssuePrompt({ repo, requirement, dueDate }) {
  const text = String(requirement ?? '').trim()
  const project = repo?.projectPath ? `公司 GitLab 项目 ${repo.projectPath}` : '当前公司 GitLab 项目'
  return [
    `帮我在${project}新建一条议题。`,
    '',
    '需求原文：',
    text,
    '',
    '按 skill gitlab-issue-workflow 补齐五必填：',
    '1) 标题一句话、可验收（不要用「优化/完善/重构」这类状态词）；',
    '2) 描述含「## 任务目标」「## 验收标准」，验收标准可验证；',
    '3) 指派我本人；',
    '4) 复杂度与类型各选一个标签；',
    `5) 截止日期 ${dueDate || '本周五'}；Milestone 不填。`,
    '',
    '补齐后调用 gitlab_issue_create 创建（该工具会先让我确认）。',
  ].join('\n')
}

/**
 * 新建议题的"引导语"：点「＋ 新建议题」时填进 **DSH 会话自带的输入框**，
 * 用户在同一个对话框里把需求写清楚，回车后由 agent 补齐五必填并调 gitlab_issue_create。
 * 插件不再提供独立的小输入框。
 */
export function buildCreateIssueIntro({ repo }) {
  const project = repo?.projectPath ? `公司 GitLab 项目 ${repo.projectPath}` : '当前公司 GitLab 项目'
  return [
    `帮我在${project}新建一条议题。`,
    '',
    '需求：（在这里写清要做什么，越具体越好；复杂需求可以多写几行）',
    '',
    '按 skill gitlab-issue-workflow 补齐五必填，再调用 gitlab_issue_create 创建（该工具会先让我确认）：',
    '1) 标题一句话、可验收（别用「优化/完善/重构」这类状态词）；',
    '2) 描述含「## 任务目标」「## 验收标准」；',
    '3) 指派我本人；',
    '4) 复杂度与类型各一个标签；',
    '5) 截止日期默认本周五；Milestone 不填。',
  ].join('\n')
}

/** 面板里"复制提示词"用的简短说明。 */
export function describeRepo(repo) {
  if (!repo) return ''
  return `${repo.projectPath}（${repo.baseUrl}）`
}
