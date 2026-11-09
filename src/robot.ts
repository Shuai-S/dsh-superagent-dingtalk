/** DingTalk robot message body (Stream mode '/v1.0/im/bot/messages/get') and
 *  the OpenAPI helpers: access-token cache, group/robot replies. */
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
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
/** 多机器人：每个 AppKey 独立缓存 accessToken（单槽会让两个机器人互相踢掉对方的有效 token）。 */
const tokenCache = new Map<string, TokenCache>()

export async function getAccessToken(clientId: string, clientSecret: string): Promise<string> {
  const now = Date.now()
  const cached = tokenCache.get(clientId)
  if (cached && cached.expiresAt > now + 60_000) return cached.token
  const res = await fetch('https://api.dingtalk.com/v1.0/oauth2/accessToken', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ appKey: clientId, appSecret: clientSecret }),
    signal: AbortSignal.timeout(15_000),
  })
  const body = (await res.json()) as { accessToken?: string; expireIn?: number }
  if (!res.ok || !body.accessToken) throw new Error('accessToken failed: HTTP ' + res.status + ' ' + JSON.stringify(body).slice(0, 200))
  tokenCache.set(clientId, { token: body.accessToken, expiresAt: now + (body.expireIn ?? 7200) * 1000 })
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
  // 端点经探针/先例实证（2026-11-04）：群聊 groupMessages/send（openConversationId）；单聊 oToMessages/batchSend（userIds）。
  // 旧端点 groupMessages 与 oToMessages 均 404 InvalidAction.NotFound。
  // conversationType 在此环境不可信（实测 '1' 出现在群聊、'2' 也是群），故不按 type 猜：先群后单依次尝试。
  const payload: Record<string, unknown> = {
    msgKey: 'sampleText',
    msgParam: JSON.stringify({ content: { text } }),
    robotCode,
  }
  const attempts: { url: string; label: string; payload: Record<string, unknown> }[] = []
  if (address.conversation) attempts.push({ url: 'https://api.dingtalk.com/v1.0/robot/groupMessages/send', label: 'group', payload: { ...payload, openConversationId: address.conversation } })
  if (address.staffId) attempts.push({ url: 'https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend', label: 'dm', payload: { ...payload, userIds: [address.staffId] } })
  if (attempts.length === 0) throw new Error('send failed: no conversation/staffId in address')
  let lastError = 'unknown'
  for (const [i, a] of attempts.entries()) {
    const res = await fetch(a.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify(a.payload),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      console.error(`[dingtalk] reply sent via OpenAPI (${a.label})`)
      return
    }
    const bodyText = await res.text()
    lastError = `HTTP ${res.status} ${bodyText.slice(0, 200)}`
    console.error(`[dingtalk] OpenAPI ${a.label} send failed: ${lastError}${i < attempts.length - 1 ? ' — trying next endpoint' : ''}`)
  }
  throw new Error(`send failed: ${lastError}`)
}

export const emptyLink = (label: Localized) => ({ url: '', label })

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

/** TTL 兜底：仅针对孤儿表情（引擎崩溃/永远无回复）；正常路径由 outbound 送达时撤回，不依赖 TTL。 */
const EMOTION_TTL_MS = 30 * 60_000
const EMOTION_MAP_LIMIT = 500
const emotionTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** 已贴过表情的目标：钉钉 Stream 是 at-least-once 投递，重连/超时会重推同 msgId，去重防表情「撤了又回来」。
 *  键含 robotCode：同一 msgId 可能同时 @ 了两个机器人，两条 Stream 各收到一次，表情按机器人独立去重与撤回。 */
export const emotionKey = (target: EmotionTarget): string => (target.robotCode || '') + ':' + target.msgId
const emotionSeen = new Set<string>()

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
  const key = emotionKey(target)
  // 重推去重：同 robotCode+msgId 只贴一次（引擎按 trigger id 幂等，表情也要对齐）。
  if (emotionSeen.has(key)) {
    console.error(`[dingtalk] emotion skip (redelivered): msgId=${target.msgId}`)
    return
  }
  emotionSeen.add(key)
  if (emotionSeen.size >= EMOTION_MAP_LIMIT) {
    const oldestSeen = emotionSeen.values().next().value
    if (oldestSeen !== undefined) emotionSeen.delete(oldestSeen)
  }
  // 防泄漏：登记超上限时清掉最旧的一条（其 TTL 大概率已自然过期）。
  if (emotionTimers.size >= EMOTION_MAP_LIMIT) {
    const oldest = emotionTimers.keys().next().value
    if (oldest !== undefined) {
      const timer = emotionTimers.get(oldest)
      if (timer) clearTimeout(timer)
      emotionTimers.delete(oldest)
    }
  }
  try {
    await robotEmotion('reply', clientId, clientSecret, target)
  } catch (error) {
    console.error(`[dingtalk] emotion attach failed: msgId=${target.msgId} ${String(error).slice(0, 300)}`)
    return
  }
  console.error(`[dingtalk] emotion attached: msgId=${target.msgId}`)
  const existing = emotionTimers.get(key)
  if (existing) clearTimeout(existing)
  emotionTimers.set(key, setTimeout(() => {
    emotionTimers.delete(key)
    void robotEmotion('recall', clientId, clientSecret, target).catch(() => { /* TTL 撤回失败仅忽略 */ })
  }, EMOTION_TTL_MS))
}

/** 撤回「🤔思考中」。幂等 best-effort：进程重启后登记丢失也照常发撤回请求，由钉钉侧兜底。 */
export async function recallThinkingEmotion(clientId: string, clientSecret: string, target: EmotionTarget): Promise<void> {
  if (!target.msgId) return
  const key = emotionKey(target)
  const timer = emotionTimers.get(key)
  if (timer) { clearTimeout(timer); emotionTimers.delete(key) }
  try {
    await robotEmotion('recall', clientId, clientSecret, target)
  } catch (error) {
    console.error(`[dingtalk] emotion recall failed: msgId=${target.msgId} ${String(error).slice(0, 300)}`)
    return
  }
  console.error(`[dingtalk] emotion recalled: msgId=${target.msgId}`)
}

// ===== 图片下载（robot/messageFiles/download） =====
// 契约来源：钉钉「机器人获取媒体文件」API + qwen-code channels/dingtalk media.ts 先例实现。

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/webp': 'image/webp',
  'image/gif': 'image/gif',
}

/** 用 downloadCode 换取临时 CDN 下载地址（attempt 级调用：重试时重新换取，防 URL 过期）。 */
async function resolveMediaDownloadUrl(clientId: string, clientSecret: string, target: { downloadCode: string; robotCode: string }): Promise<string> {
  if (!target.downloadCode || !target.robotCode) throw new Error('downloadMedia: downloadCode/robotCode required')
  const token = await getAccessToken(clientId, clientSecret)
  const res = await fetch('https://api.dingtalk.com/v1.0/robot/messageFiles/download', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
    body: JSON.stringify({ downloadCode: target.downloadCode, robotCode: target.robotCode }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const bodyText = await res.text()
    throw new Error(`messageFiles/download: HTTP ${res.status} ${bodyText.slice(0, 200)}`)
  }
  const body = (await res.json()) as { downloadUrl?: string; data?: { downloadUrl?: string } }
  const downloadUrl = body.downloadUrl ?? body.data?.downloadUrl
  if (!downloadUrl) throw new Error('messageFiles/download: no downloadUrl in response')
  return downloadUrl
}

/** 用 downloadCode 换取任意媒体字节（小文件内存路径）；mime 取自 CDN 响应头。 */
export async function downloadDingtalkMedia(
  clientId: string,
  clientSecret: string,
  target: { downloadCode: string; robotCode: string },
): Promise<{ data: Buffer; mime: string }> {
  const downloadUrl = await resolveMediaDownloadUrl(clientId, clientSecret, target)
  const file = await fetch(downloadUrl, { signal: AbortSignal.timeout(60_000) })
  if (!file.ok) throw new Error(`media fetch: HTTP ${file.status}`)
  const mime = (file.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
  const data = Buffer.from(await file.arrayBuffer())
  return { data, mime }
}

/** 分段流式下载到 .part 文件：Range 断点续传 + 重试退避 + 防呆上限；CDN 不支持 Range（返回 200 全量）时自动回退流式下载。
 *  每段 30s 超时，总预算默认 15 分钟；失败保留 .part（同一 msgId 重推时从断点继续）。完成后由调用方 rename 成目标名。 */
export async function downloadDingtalkMediaToFile(
  clientId: string,
  clientSecret: string,
  target: { downloadCode: string; robotCode: string },
  partPath: string,
  opts?: { maxBytes?: number; budgetMs?: number; segmentBytes?: number; attempts?: number },
): Promise<{ bytes: number; mime: string }> {
  const maxBytes = opts?.maxBytes ?? 200 * 1024 * 1024
  const deadline = Date.now() + (opts?.budgetMs ?? 15 * 60_000)
  const segment = opts?.segmentBytes ?? 8 * 1024 * 1024
  const maxAttempts = opts?.attempts ?? 4
  let offset = 0
  try { offset = (await stat(partPath)).size } catch { /* first run */ }
  if (offset > maxBytes) {
    await unlink(partPath).catch(() => {})
    throw new Error(`media exceeds ${maxBytes} byte limit`)
  }
  await mkdir(dirname(partPath), { recursive: true })
  let mime = ''
  let attempt = 0
  let lastError = 'unknown'
  while (Date.now() <= deadline) {
    try {
      const url = await resolveMediaDownloadUrl(clientId, clientSecret, target)
      for (;;) {
        if (offset > maxBytes) {
          await unlink(partPath).catch(() => {})
          throw new Error(`media exceeds ${maxBytes} byte limit`)
        }
        const res = await fetch(url, {
          headers: { Range: `bytes=${offset}-${offset + segment - 1}` },
          signal: AbortSignal.timeout(30_000),
        })
        if (!mime) mime = (res.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
        if (res.status === 206) {
          const buf = Buffer.from(await res.arrayBuffer())
          if (buf.length === 0) throw new Error('empty range response')
          const handle = await open(partPath, 'a')
          try { await handle.write(buf) } finally { await handle.close() }
          offset += buf.length
          const total = Number(/\/(\d+)$/.exec(res.headers.get('content-range') ?? '')?.[1] ?? -1)
          if (total >= 0 && offset >= total) return { bytes: offset, mime }
          if (total < 0 && buf.length < segment) return { bytes: offset, mime }
          continue
        }
        if (res.status === 200) {
          // 服务器不支持 Range：全量流式写（内存安全）；已有 .part 进度则从头重来。
          if (offset > 0) { offset = 0; await unlink(partPath).catch(() => {}) }
          const handle = await open(partPath, 'w')
          try {
            for await (const chunk of res.body ?? []) {
              const buf = Buffer.from(chunk as Uint8Array)
              await handle.write(buf)
              offset += buf.length
              if (offset > maxBytes) throw new Error(`media exceeds ${maxBytes} byte limit`)
            }
          } finally { await handle.close() }
          return { bytes: offset, mime }
        }
        throw new Error(`HTTP ${res.status}`)
      }
    } catch (error) {
      lastError = String(error).slice(0, 200)
      if (lastError.includes('byte limit')) throw error
      attempt += 1
      if (attempt >= maxAttempts || Date.now() > deadline) break
      await new Promise((resolve) => setTimeout(resolve, Math.min(500 * 2 ** (attempt - 1), 8_000)))
    }
  }
  throw new Error(`media download failed after ${attempt} attempts at ${offset} bytes: ${lastError}`)
}

/** 图片专用下载：通用下载 + 受支持图片 mime 白名单。 */
export async function downloadDingtalkImage(
  clientId: string,
  clientSecret: string,
  target: { downloadCode: string; robotCode: string },
): Promise<{ data: Buffer; mediaType: string }> {
  const { data, mime } = await downloadDingtalkMedia(clientId, clientSecret, target)
  const mediaType = IMAGE_MEDIA_TYPES[mime]
  if (!mediaType) throw new Error(`unsupported image type: ${mime || 'unknown'}`)
  return { data, mediaType }
}