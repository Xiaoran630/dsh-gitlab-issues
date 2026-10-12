# dsh-gitlab-issues —— DSH 常驻插件

把「公司 GitLab 议题」接进 [DeepSeek Harness](https://github.com/deepseek-ai)：**进入工作区就认出仓库、看到议题、直接按议题开工**。

插件装进 DSH 的 profile，跨会话常驻。代码与另一个 Electron 项目 `gitlab-issue-bot` 完全隔离——只按行为对齐重写了几段纯逻辑，不 import 它的任何文件。

## 它做什么

| 能力 | 说明 |
|---|---|
| 自动识别 | 从会话工作区目录向上找 `.git`（含 worktree 的 `.git` 文件），解析 remote 判断是否公司 GitLab；**不跑 git 命令、不弹窗** |
| 会话内入口 | 命中的会话在**输入框工具行**里多一个小按钮「议题 N」，点开是插件自绘的浮层：列表 + 刷新 + 全部议题 + 新建议题 |
| 一键开工 | 点一条议题 → 开工提示词填入输入框（**不自动发送**，你确认后回车） |
| 独立面板 | 左侧栏「议题」入口：项目选择 / 状态·标签·关键词·只看我的 筛选 / 详情 / 评论 / **编辑** / 关闭·重开 / **删除** / **手动新建** |
| Agent 工具 | 4 个工具按会话注册，写操作先走 DSH 审批 |
| 上下文注入 | 命中的会话自动带上「本工作区项目 + 打开议题摘要」（默认 ≤12 条，同步读缓存，不打网络） |

插件**不含任何模型调用**：需求理解、标题撰写、复杂度/类型判断都交给当前会话的 DSH agent；插件只做「探测 + 取数 + 结构化写 GitLab」。
`gitlab-issue-bot` 里的 LLM、文档摄取、排期引擎一律没有搬过来。

## 安装

```
plugin_manager install_bundle  target = <本仓库>/plugin
```

安装以 pnpm `link:` 方式引用源码目录。**关于改动生效方式（踩过坑，务必知道）**：

| 改了什么 | 怎么生效 |
|---|---|
| `plugin/client.js`（界面） | 刷新页面即可（DSH 会重建 Web bundle） |
| `plugin/index.js`、`plugin/lib/*`（Host） | **必须重启 DSH Desktop 应用本体**（不能只刷新；`plugin_manager` 停用→启用也不行，那只会重跑缓存里的旧模块） |

> DSH 设置页里那个「重启 ⌄」重启的是**终端**，不是应用进程，别用它来换 Host 代码。

## 配置令牌（必须，一次）

`设置 → GitLab 议题` → 粘贴个人访问令牌（PAT）→ 点「**保存并测试**」（会先保存，再用**刚输入的那串**验证，不会拿旧的糊弄你）。

- 令牌优先写入 DSH 凭据库（environment ref 名默认 `GITLAB_TOKEN`），失败才落到插件自己的设置文件；
- 也可以直接设置环境变量 `GITLAB_TOKEN`；
- 令牌只走 `PRIVATE-TOKEN` 请求头，不写进 URL、不进日志（最多前 6 位掩码）。

**地址白名单**：默认 `git.bobotechnology.cn:8000` 与 `47.109.72.180:8000`（同一台服务器）。同仓库若有别的入口地址，在设置页追加。

> 为什么不能自动复用 `gitlab-issue-bot` 的凭据：它把密码/令牌用 Electron `safeStorage`（Windows 上是 DPAPI）加密存在
> `%APPDATA%\GitLabIssueBot\credentials.dat`，换进程解不开，只能重新授权一次。

## Agent 工具（只对命中公司 GitLab 的会话注册）

| 工具 | 用途 |
|---|---|
| `gitlab_issues` | 列议题（状态/标签/关键词/只看我的/条数） |
| `gitlab_issue` | 读某条议题的完整描述与验收标准（可选带最近评论） |
| `gitlab_issue_create` | 新建议题：五必填校验 + 项目标签字典解析 + **审批** + 创建 |
| `gitlab_issue_write` | 评论 / 关闭 / 重开 / 改指派 / 改标签：同样先审批 |

- 写操作通过 `ctx.approval.request` 请求确认，只有 `allowed-once` 才真正发出请求；**没有审批通道时一律拒绝**（fail closed）。
- 几个工具都**不接受 project 参数**——目标项目永远是当前会话工作区的那个仓库，避免误建到别的仓库。

## HTTP 路由（同源，供界面用）

```
GET  /dsh-gitlab-issues/api/state?sessionId=     会话工作区的仓库/项目/议题摘要
GET  /dsh-gitlab-issues/api/projects             已知工作区扫描出的公司项目
GET  /dsh-gitlab-issues/api/issues?project=&...  议题列表（状态/标签/关键词/只看我的）
GET  /dsh-gitlab-issues/api/issue?project=&iid=&notes=1
GET  /dsh-gitlab-issues/api/labels?project=      标签字典分组（complexity / type / others）
GET  /dsh-gitlab-issues/api/members?project=     可指派成员
GET  /dsh-gitlab-issues/api/prepare?sessionId=&iid=       开工提示词
GET  /dsh-gitlab-issues/api/prepare?project=&iid=&title=  面板用
GET  /dsh-gitlab-issues/api/prepare?...&intent=create     建议题引导语（交给 agent）
GET  /dsh-gitlab-issues/api/settings             读设置（令牌只回 configured + 掩码）
POST /dsh-gitlab-issues/api/settings             存设置 / 存令牌
POST /dsh-gitlab-issues/api/test                 连接测试（可带未保存的 token）
POST /dsh-gitlab-issues/api/refresh              强制刷新缓存
POST /dsh-gitlab-issues/api/create               手动新建（五必填校验 + 可选 labelsOverride）
POST /dsh-gitlab-issues/api/update               编辑议题
POST /dsh-gitlab-issues/api/delete               删除议题（需 Owner 权限）
POST /dsh-gitlab-issues/api/comment|close|reopen 评论 / 关闭 / 重开
POST /dsh-gitlab-issues/api/diagnostics          remote / 白名单诊断
```

写路由校验同源 + `Content-Type: application/json` + 体 ≤64KB；令牌永不回显。

## 目录结构

```
plugin/
├─ index.js              Host：探测、缓存、REST、工具、路由、提示注入
├─ client.js             Client：工具行入口 + 自绘浮层 / 独立面板 / 设置页
├─ cordis.patch.yml      bundle patch（insert 一行）
├─ package.json          dsh.bundle.patch + dsh.client
├─ icon.svg  locale/*    插件管理器里的图标与文案
├─ lib/
│  ├─ git-detect.js      .git 定位、remote 解析（http / git@host:path / ssh://、多 remote、worktree）
│  ├─ company-rules.js   公司白名单、规范要点、五必填校验、本周五
│  ├─ labels.js          标签字典分组识别与短值解析（复杂度 / 类型）
│  ├─ gitlab.js          REST 客户端（PAT、分页、超时、重试、丢 null）
│  ├─ prompt.js          开工 / 建议题提示词模板
│  └─ settings.js        设置文件读写（~/.dsh/dsh-gitlab-issues.json）
└─ test/core.test.mjs    17 个单测（node --test）
```

## 测试

```powershell
cd plugin
node --test test/*.test.mjs     # 17 passed
```

覆盖：remote 三形态解析、多 remote 与 origin 优先、worktree 的 `.git` 文件、白名单判定（端口省略/大小写/IP 与域名等价）、
标签分组识别与短值解析、五必填校验与默认值、描述模板补全、提示词生成、请求体丢空值。

## 设置文件

`~/.dsh/dsh-gitlab-issues.json`（Windows：`C:\Users\<你>\.dsh\`）

```json
{
  "version": 1,
  "enabled": true,
  "hosts": ["git.bobotechnology.cn:8000", "47.109.72.180:8000"],
  "tokenRef": "GITLAB_TOKEN",
  "token": "",
  "injectPrompt": true,
  "pollSeconds": 60
}
```

## 界面落点的设计约束（重要，别踩）

会话内入口**刻意不放在** `conversation.input.dock`（composer 卡片上方）。那个位置一插元素就会改变整块几何，
把同一个 composer 浮层容器（`conversation.input.overlay`）里其它插件的浮层一起挤错位——实测会把表情面板与技能搜索顶飞。
现在放在 `conversation.input.left`（工具行里与表情按钮同排），展开列表用**插件自绘的 `position: fixed` 浮层**（有 `react-dom` 时 portal 到 body），
定位自己算，不占用任何宿主浮层容器。

## 边界与已知限制

- **和 `gitlab-issue-bot` 完全隔离**：只按行为对齐重写了少量纯逻辑，没有 import 它的任何文件，也不往它的目录写东西。
- **不能自动复用它的 DPAPI 凭据**，首次要粘一次 PAT（或设 `GITLAB_TOKEN`）。
- 面板是 root 作用域、拿不到会话 id，所以「填入输入框」只在会话内那个小按钮里提供；面板里的对应动作是「复制开工提示词」。
- 不做提交门禁（DSH 没有提交钩子）：提交信息带 `#编号` 靠上下文注入 + `gitlab-issue-workflow` skill 约束。
  可选增强（未做）：`tools/pre-execute` 拦截缺 `#编号` 的 `git commit`。
- 议题缓存 60s、项目信息 5min、工作区扫描 5min；刷新失败保留上次成功结果，只在界面提示原因。
- 标签选择器依赖 `GET /api/labels`：读不到时会降级成「手填标签串」的输入框（并说明原因），不会让你没法建单。
