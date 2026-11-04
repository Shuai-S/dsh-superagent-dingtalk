/** DingTalk robot message body (Stream mode '/v1.0/im/bot/messages/get') and
 *  the OpenAPI helpers: access-token cache, group/robot replies. */
import type { Localized, OutboundMessageLike } from './types.ts'

export interface RobotMessage {
  conversationId: string
  conversationType: string   // '1' single chat, '0' group chat
  msgId: string
  senderStaffId: string
  senderNick: string
  senderCorpId?: string
  text?: { content: string }
  msgtype: string
  robotCode: string
  sessionWebhook?: string
  sessionWebhookExpiredTime?: number
  createAt?: number
  isInAtList?: boolean
  atUsers?: { dingtalkId: string; staffId: string }[]
  [key: string]: unknown
}

export interface TokenCache { token: string; expiresAt: number }
const tokenCache: { current?: TokenCache } = {}

export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now()
  if (tokenCache.current && tokenCache.current.expiresAt > now + 60_000) return tokenCache.current.token
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json()) as { accessToken?: string; expireIn?: number }
  if (!res.ok || !body.accessToken) throw new Error('accessToken failed: HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
  tokenCache.current = { token: body.accessToken, expiresAt: now + (body.expireIn ?? 7200) * 1000 }
  return body.accessToken
}

export async function sendRobotMessage(
  clientId: string,
  clientSecret: string,
  robotCode: string,
  address: Record<string, string>,
  text: string,
): Promise<void> {
  const token = await getAccessToken(clientId, clientSecret)
  const isSingle = address.type === '1'
  const url = isSingle
    ? 'https://api.dingtalk.com/v1.0/robot/oToMessages'
    : 'https://api.dingtalk.com/v1.0/robot/groupMessages'
  const payload: Record<string, unknown> = {
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: { text } }),
    robotCode,
  }
  if (isSingle) payload.userIds = [address.staffId]
  else payload.openConversationId = address.conversation
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const bodyText = await res.text()
    throw new Error('send failed: HTTP ' + res.status + ' ' + bodyText.slice(0, 200))
  }
}

export const emptyLink = (label: Localized) => ({ url: '', label })
// Token accessor used by the webhook reply path (adds the account identity header).
sendRobotMessage.token = async () => { try { const { getAccessToken } = await import('./robot.ts'); return undefined } catch { return undefined } }

// ===== 「思考中」表情（robot/emotion/reply | recall） =====
// 契约来源：钉钉官方 SDK alibabacloud-dingtalk robot_1_0（RobotReplyEmotion / RobotRecallEmotion，
// POST /v1.0/robot/emotion/reply 与 /recall）；参数取自官方 openclaw connector 先例实现。

export const THINKING_EMOTION = {
  emotionId: '2659900',
  emotionName: '🤔思考中',
  text: '🤔思考中',
  backgroundId: 'im_bg_1',
} as const

export interface EmotionTarget { robotCode: string; msgId: string; conversationId: string }

/** TTL 兜底：贴上后若一直没有 outbound 触发撤回（引擎错误/无回复），到时自动撤，防表情残留。 */
const EMOTION_TTL_MS = 5 * 60_000
const EMOTION_MAP_LIMIT = 500
const emotionTimers = new Map<string, ReturnType<typeof setTimeout>>()

async function robotEmotion(action: 'reply' | 'recall', clientId: string, clientSecret: string, target: EmotionTarget): Promise<void> {
  if (!target.msgId || !target.conversationId) return
  const token = await getAccessToken(clientId, clientSecret)
  const res = await fetch(`https://api.dingtalk.com/v1.0/robot/emotion/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({
      robotCode: target.robotCode,
      openMsgId: target.msgId,
      openConversationId: target.conversationId,
      emotionType: 2,
      emotionName: THINKING_EMOTION.emotionName,
      textEmotion: THINKING_EMOTION,
    }),
    signal: AbortSignal.timeout(5_000),
  })
  if (!res.ok) {
    const bodyText = await res.text()
    throw new Error(`emotion/${action}: HTTP ${res.status} ${bodyText.slice(0, 200)}`)
  }
}

/** 在入站消息上贴「🤔思考中」。失败抛给调用方记日志，绝不影响接收主流程。 */
export async function attachThinkingEmotion(clientId: string, clientSecret: string, target: EmotionTarget): Promise<void> {
  if (!target.msgId) return
  // 防泄漏：登记超上限时清掉最旧的一条（其 TTL 大概率已自然过期）。
  if (emotionTimers.size >= EMOTION_MAP_LIMIT) {
    const oldest = emotionTimers.keys().next().value
    if (oldest !== undefined) {
      const timer = emotionTimers.get(oldest)
      if (timer) clearTimeout(timer)
      emotionTimers.delete(oldest)
    }
  }
  await robotEmotion('reply', clientId, clientSecret, target)
  const existing = emotionTimers.get(target.msgId)
  if (existing) clearTimeout(existing)
  emotionTimers.set(target.msgId, setTimeout(() => {
    emotionTimers.delete(target.msgId)
    void robotEmotion('recall', clientId, clientSecret, target).catch(() => { /* TTL 撤回失败仅忽略 */ })
  }, EMOTION_TTL_MS))
}

/** 撤回「🤔思考中」。幂等 best-effort：进程重启后登记丢失也照常发撤回请求，由钉钉侧兜底。 */
export async function recallThinkingEmotion(clientId: string, clientSecret: string, target: EmotionTarget): Promise<void> {
  const timer = target.msgId ? emotionTimers.get(target.msgId) : undefined
  if (timer) { clearTimeout(timer); emotionTimers.delete(target.msgId) }
  await robotEmotion('recall', clientId, clientSecret, target)
}