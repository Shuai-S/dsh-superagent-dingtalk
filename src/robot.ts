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
