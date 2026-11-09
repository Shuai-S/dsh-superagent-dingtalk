/** ACL 访问模式判定（canonical：/Users/zs/MyCode/dsh-plugin/tools/acl/acl.ts）。
 *  各源包按契约 docs/rpc-contract.md §3 vendored 本文件副本；包间零 npm 依赖。
 *  语义：policy 缺省 = 全放行（向后兼容）；allowlist 精确匹配 actor.id；
 *  groupOnly 仅在包内能可靠判定会话类型时生效；拒绝在派发前发生并回执。 */

export interface AclDenyText { zh: string; en: string }

export interface AclPolicy {
  mode: 'allowlist' | 'open'
  allowUsers: string[]
  groupOnly?: boolean
  denyText?: AclDenyText
}

export interface AclInput {
  /** Trigger actor.id —— 平台用户 id 精确串 */
  actorId: string
  /** 包内可靠可得时传 'group'|'single'；不可得传 undefined（groupOnly 视为不命中） */
  conversationType?: 'group' | 'single'
  /** ACL 拒绝时回执文案（kind 'notice'），由调用方发送 */
}

export interface AclVerdict {
  allowed: boolean
  /** 拒绝原因码：allowlist / group-only */
  reason?: 'allowlist' | 'group-only'
  /** 双语回执文案（拒绝时必非空） */
  denyText?: AclDenyText
}

const DEFAULT_DENY: AclDenyText = { zh: '该机器人未向你开放。', en: 'This bot is not open to you.' }

/** 纯函数判定；不抛错——policy 缺省或 mode=open 一律放行。 */
export function evaluateAcl(policy: AclPolicy | undefined, input: AclInput): AclVerdict {
  if (!policy || policy.mode !== 'allowlist') return { allowed: true }
  if (!input.actorId || !policy.allowUsers.includes(input.actorId)) {
    return { allowed: false, reason: 'allowlist', denyText: policy.denyText ?? DEFAULT_DENY }
  }
  if (policy.groupOnly && input.conversationType === 'single') {
    return { allowed: false, reason: 'group-only', denyText: policy.denyText ?? DEFAULT_DENY }
  }
  return { allowed: true }
}

/** groupOnly 的兜底语义：包内拿不到会话类型时（undefined）不拒绝——宁可放行不误伤。 */
export function aclDenyNoticeText(verdict: AclVerdict, lang: 'zh' | 'en'): string {
  return verdict.denyText ? verdict.denyText[lang] : DEFAULT_DENY[lang]
}
