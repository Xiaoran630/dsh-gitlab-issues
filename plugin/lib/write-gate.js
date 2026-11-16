/**
 * 写操作授权闸门。
 *
 * DSH 的会话审批策略只有两个值：`ask` 和 `never`（见 @deepseek-ai/dsh-user-approval）。
 * `never` 表示「本次会话不再询问审批」——approval.request() 在这种会话里必定返回
 * `rejected`。所以插件不能把 `request()` 当成唯一许可来源，否则在完全权限（never）
 * 模式下永远写不了 GitLab，这正是之前建不了议题的原因。
 *
 * 分流规则：
 *   - 没有 approval 服务                → 直接执行（环境本来就没有审批通道）
 *   - 策略 never                        → 直接执行（用户明确关掉了逐条确认）
 *   - 策略 ask                          → 问一次；只有 allowed-once 才写
 *   - rejected / cancelled / unavailable / 抛错 → 拒绝，并说明怎么放行
 *
 * 这里只依赖传入的 approval 对象与 session，不碰 ctx，方便单测。
 */

/** approval.request() 的全部合法结果；只有 allowed-once 是许可。 */
export const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable']

/** 会话有效策略；读不到时报 unknown（调用方走保守分支）。 */
export function policyOfService(approval, session) {
  if (!approval) return 'no-service'
  if (!session) return 'unknown'
  try {
    if (typeof approval.effectivePolicy === 'function') {
      const policy = approval.effectivePolicy(session)
      if (typeof policy === 'string' && policy) return policy
    }
    if (typeof approval.overrideOf === 'function') {
      const override = approval.overrideOf(session)
      if (typeof override === 'string' && override) return override
    }
  } catch {
    return 'unknown'
  }
  return 'unknown'
}

/**
 * 决定这次写操作要不要问、能不能做。
 *
 * @param {object} options
 * @param {object|null} options.approval approval 服务实例（可缺省）
 * @param {object|null} options.agent 发起调用的 agent（用它的 session 读策略）
 * @param {string} options.toolName 工具名，写进审批记录
 * @param {string} options.reason 给人看的说明，写进审批记录
 * @param {string} [options.callId] 工具调用 id
 * @param {AbortSignal} [options.signal] 调用取消信号
 * @param {(message: string) => void} [options.log]
 * @param {(message: string) => void} [options.warn]
 * @returns {Promise<{ok: boolean, policy: string, prompted: boolean, message?: string}>}
 */
export async function gateWrite(options = {}) {
  const {
    approval = null,
    agent = null,
    toolName = 'unknown',
    reason = '',
    callId,
    signal,
    log = () => {},
    warn = () => {},
  } = options

  const policy = policyOfService(approval, agent?.session ?? null)

  if (!approval || typeof approval.request !== 'function' || policy === 'never') {
    if (policy === 'never') log(`审批策略 never，写操作直接执行：${toolName}`)
    else warn(`没有 approval 服务，写操作直接执行：${toolName}`)
    return { ok: true, policy, prompted: false }
  }

  try {
    const outcome = await approval.request({ agent, toolName, callId, reason, signal })
    if (outcome === 'allowed-once') return { ok: true, policy, prompted: true }
    if (outcome === 'unavailable') {
      return {
        ok: false,
        policy,
        prompted: true,
        message:
          '审批请求无人应答（unavailable），没有对 GitLab 做任何修改。'
          + '不需要逐条确认的话，把会话审批策略切到 never（完全权限）再重试，或直接用议题面板操作。',
      }
    }
    return {
      ok: false,
      policy,
      prompted: true,
      message: `写操作未获批准（${outcome}），没有对 GitLab 做任何修改。`,
    }
  } catch (error) {
    return {
      ok: false,
      policy,
      prompted: true,
      message: `审批未完成：${error?.message ?? String(error)}；不需要逐条确认的话请把审批策略切到 never 后重试。`,
    }
  }
}

/** 写成功后拼在工具结果末尾的说明（只有「策略 never 直接执行」才提示）。 */
export function approvalNote(result) {
  if (result && result.prompted === false && result.policy === 'never') return '\n（本会话审批策略为 never，写操作直接执行）'
  return ''
}
