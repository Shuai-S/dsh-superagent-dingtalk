/** Per-robot Stream-mode lifecycle: every configured robot runs ONE DWClient
 *  (dingtalk-stream SDK with its own auto-reconnect); credentials are the only
 *  respawn-affecting fields — chats, DM and emotion toggles apply live through
 *  the holder. Robot messages become Triggers (acked immediately; trigger ids
 *  carry the robot dimension so server redeliveries dedupe and two robots in
 *  one conversation never collide). Redeliveries are additionally caught by a
 *  persistent per-robot ID ring (dedup.ts), and the `dingtalkStream` health
 *  details carry compact in=/out=/fail=/last= counters (counters.ts). */
import { mkdir, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DWClient, TOPIC_ROBOT, type RobotMessage } from 'dingtalk-stream'
import type { SourceContextLike, TriggerLike } from './types.ts'
import { HEALTH_ENTRY, channelConfig, resolveRobots, type DingConfig, type EffectiveRobot } from './dingtalk-kind.ts'
import { attachThinkingEmotion, downloadDingtalkMediaToFile } from './robot.ts'
import { bumpIn, counterDetail } from './counters.ts'
import { seenOrAdd } from './dedup.ts'

interface DownStreamLike { data: string; headers?: { messageId?: string } }

export interface DownloadedMedia { kind: 'file' | 'video' | 'audio'; code: string; path?: string; name: string; error?: string }

const MEDIA_ROOT = join(homedir(), '.dsh', 'dingtalk-attachments')

const MEDIA_EXTS: Record<string, string> = {
  'video/mp4': '.mp4', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'video/webm': '.webm',
  'audio/mpeg': '.mp3', 'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/amr': '.amr',
  'application/pdf': '.pdf', 'application/msword': '.doc', 'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/zip': '.zip', 'text/plain': '.txt', 'text/markdown': '.md',
}

const extFromName = (name: string): string | undefined => {
  const m = /\.[a-z0-9]{1,6}$/i.exec(name)
  return m ? m[0].toLowerCase() : undefined
}

/** 收消息即把 file/video/audio 附件落盘到 ~/.dsh/dingtalk-attachments/<msgId>/，路径注入 trigger 文本供 agent 的 read/bash 工具消化；单件失败降级不阻塞。 */
export async function downloadMessageMedia(robot: EffectiveRobot, msg: RealRobotMessage): Promise<DownloadedMedia[]> {
  const items: { kind: 'file' | 'video' | 'audio'; code: string; name: string }[] = []
  for (const p of msg.content?.richText ?? []) {
    const kind = p.type || p.msgType || 'text'
    if ((kind === 'file' || kind === 'video' || kind === 'audio') && p.downloadCode) {
      items.push({ kind: kind as 'file' | 'video' | 'audio', code: p.downloadCode, name: (p.fileName || p.name || p.text || '').trim() })
    }
  }
  const topKind = String(msg.msgtype ?? '')
  if ((topKind === 'file' || topKind === 'video' || topKind === 'audio') && msg.content?.downloadCode) {
    items.push({ kind: topKind as 'file' | 'video' | 'audio', code: msg.content.downloadCode, name: (msg.content.fileName || msg.content.name || '').trim() })
  }
  if (items.length === 0) return []
  const dir = join(MEDIA_ROOT, (msg.msgId || 'msg').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60))
  const out: DownloadedMedia[] = []
  for (const [i, item] of items.entries()) {
    try {
      await mkdir(dir, { recursive: true })
      const base = (item.name.replace(/\.[^./\\]*$/, '') || `media-${i + 1}`).replace(/[^\w\u4e00-\u9fa5.-]/g, '_').slice(0, 60)
      const partPath = join(dir, base + '.part')
      // 断点续传：.part 保留跨重推进度；mime 到手后 rename 成带扩展名的最终名。
      const { bytes, mime } = await downloadDingtalkMediaToFile(robot.clientId, robot.appSecret, { downloadCode: item.code, robotCode: msg.robotCode || robot.robotCode }, partPath)
      const ext = MEDIA_EXTS[mime] ?? extFromName(item.name) ?? (item.kind === 'video' ? '.mp4' : item.kind === 'audio' ? '.mp3' : '')
      const path = join(dir, base + ext)
      await rename(partPath, path)
      out.push({ ...item, path })
      console.error(`[dingtalk] media saved: kind=${item.kind} bytes=${bytes} path=${path}`)
    } catch (error) {
      out.push({ ...item, error: String(error).slice(0, 160) })
      console.error(`[dingtalk] media download failed: kind=${item.kind} ${String(error).slice(0, 200)}`)
    }
  }
  return out
}

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

export type RealRobotMessage = RobotMessage & {
  isInAtList?: boolean
  atUsers?: { dingtalkId: string; staffId: string }[]
  /** richText 消息（图片/文件+文字混合）：文字在 content.richText[] 的 text 项里，此时 text.content 为空。 */
  content?: {
    richText?: { type?: string; msgType?: string; text?: string; downloadCode?: string; fileName?: string; name?: string }[]
    /** 独立媒体消息（msgtype=audio/video/file）的下载码、文件名与语音转写。 */
    downloadCode?: string
    fileName?: string
    name?: string
    recognition?: string
  }
}

export function buildTrigger(robot: EffectiveRobot, msg: RealRobotMessage, media: DownloadedMedia[] = []): TriggerLike | undefined {
  // 纯文本消息走 text.content；语音优先取钉钉自带转写 recognition；richText（图+文）消息：文字项拼接、
  // 图片项以标记内嵌 downloadCode（threadContext.images 据标记提取，image() 下载注入；先例：qwen-code DingtalkAdapter / 引擎 feishu-image）。
  const parts: string[] = []
  const imageCodes: string[] = []
  for (const p of msg.content?.richText ?? []) {
    const kind = p.type || p.msgType || 'text'
    if (kind === 'text') parts.push(p.text ?? '')
    else if ((kind === 'picture' || kind === 'image') && p.downloadCode) {
      parts.push(`[dingtalk-image:${p.downloadCode}]`)
      imageCodes.push(p.downloadCode)
    }
  }
  // 独立媒体消息（msgtype=audio/video/file 整条一条，qwen-code 同样处理）。
  const topKind = String(msg.msgtype ?? '')
  if ((topKind === 'video' || topKind === 'file' || topKind === 'audio') && msg.content?.downloadCode) {
    parts.push(`[dingtalk-${topKind}:${msg.content.downloadCode}]`)
  }
  const recognition = msg.content?.recognition?.trim() ?? ''
  let text = (msg.text?.content || recognition || parts.join('')).trim()
  if (!text) return undefined
  if (imageCodes.length > 0) console.error(`[dingtalk] images embedded: n=${imageCodes.length} msgId=${msg.msgId}`)
  // 落盘结果注入：文件用 read/bash 消化，视频提示 ffmpeg 抽帧；失败降级说明。
  if (media.length > 0) {
    const notes = media.map((m) => {
      const label = m.kind === 'video' ? '视频' : m.kind === 'audio' ? '语音' : '文件'
      if (m.path) {
        const hint = m.kind === 'video' ? '如需理解内容，可用 ffmpeg 抽帧后用 read_image 查看' : '用 read/bash 工具查看内容'
        return `[${label}已保存: ${m.path}${m.name ? `（原名: ${m.name}）` : ''} —— ${hint}]`
      }
      return `[钉钉${label}下载失败${m.error ? `: ${m.error}` : ''}]`
    })
    text = `${text}\n${notes.join('\n')}`
  }
  const account = robot.rowId
  const robotCode = msg.robotCode || robot.robotCode
  const isConfiguredGroup = robot.chats.some((c) => c.openConversationId === msg.conversationId)
  // Anything that is not a chat registered for this robot is treated as a side
  // chat (DM-like): dispatchable without registering every cid up front.
  const isDm = !isConfiguredGroup
  const addressed = isDm ? 'direct' as const : ((msg.isInAtList === true || (msg.atUsers ?? []).length > 0) ? 'mention' as const : undefined)
  return {
    id: `dingtalk:${account}:${msg.msgId}`,
    source: 'dingtalk',
    threads: [{ source: 'dingtalk', id: msg.conversationId }],
    actor: { source: 'dingtalk', id: msg.senderStaffId },
    human: true,
    ...(addressed ? { addressed } : {}),
    at: msg.createAt ? new Date(msg.createAt).toISOString() : new Date().toISOString(),
    text,
    channel: { source: 'dingtalk', thread: 'dingtalk:' + msg.conversationId,
      address: { account, conversation: msg.conversationId, type: msg.conversationType, staffId: msg.senderStaffId, robotCode, sessionWebhook: msg.sessionWebhook ?? '', webhookExpiresAt: String(msg.sessionWebhookExpiredTime ?? 0), msgId: msg.msgId ?? '', direct: isDm ? 'true' : '' } },
    meta: { accountId: account, robotCode, conversationId: msg.conversationId, messageId: msg.msgId, isDm, isConfiguredGroup, senderNick: msg.senderNick },
  }
}

/** Wraps the dingtalk-stream DWClient so the SDK stays swappable. */
export class StreamClient {
  connected = false
  lastInboundAt = 0
  private inner: DWClient
  constructor(private readonly config: { clientId: string; clientSecret: string }, onRobot: (msg: RealRobotMessage) => Promise<void>, onConn: (connected: boolean) => void) {
    this.inner = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret, keepAlive: true, debug: false, autoReconnect: true } as never)
    this.inner.registerCallbackListener(TOPIC_ROBOT, (downstream: DownStreamLike) => {
      let msg: RobotMessage | undefined
      try { msg = JSON.parse(downstream.data) as RobotMessage } catch { return { status: 'SUCCESS' as const } }
      this.connected = true   // a message arriving over the stream is proof of connectivity
      this.lastInboundAt = Date.now()
      if (msg && onRobot) void onRobot(msg as RealRobotMessage).catch(() => { /* receive errors surface via evals health */ })
      return { status: 'SUCCESS' as const, message: 'OK' }
    })
    this.inner.on('close', () => { this.connected = false; onConn(false) })
    this.inner.on('open', () => { this.connected = true; onConn(true) })
  }
  async connect(): Promise<void> { await this.inner.connect() }
  disconnect(): void { try { this.inner.disconnect() } catch { /* already down */ } this.connected = false }
  isConnected(): boolean { return this.connected || this.inner.connected === true }
}

const robotLabel = (robot: EffectiveRobot): string => robot.label || robot.robotCode || robot.clientId || 'default'

/** The live robot row for a runner: chats/labels/toggles follow the latest config
 *  through the holder; the runner snapshot only fills in when the holder is gone. */
const liveRobot = (snapshot: EffectiveRobot): EffectiveRobot =>
  channelConfig.current?.robots.find((r) => r.rowId === snapshot.rowId) ?? snapshot

/** 1 s after a run that stayed up for a minute, otherwise exponential backoff up to 60 s. */
export const connectRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

async function runRobot(source: SourceContextLike, signal: AbortSignal, snapshot: EffectiveRobot): Promise<void> {
  let retry: number | undefined
  while (!signal.aborted) {
    const began = Date.now()
    try {
      await streamOnce(source, signal, snapshot)
    } catch (error) {
      if (!signal.aborted) {
        source.report(HEALTH_ENTRY, { state: 'error', detail: `[${robotLabel(liveRobot(snapshot))}] ${String(error).slice(0, 300)} ${counterDetail(snapshot.rowId)}` })
      }
    }
    if (signal.aborted) break
    retry = connectRetry(retry, Date.now() - began)
    await delay(retry, undefined, { signal }).catch(() => {})
  }
}

/** One connection per call: connects, then parks until abort; transient drops
 *  are healed by the SDK's own auto-reconnect. Throws on connect failure so the
 *  runner retries with backoff. */
async function streamOnce(source: SourceContextLike, signal: AbortSignal, snapshot: EffectiveRobot): Promise<void> {
  const client = new StreamClient({ clientId: snapshot.clientId, clientSecret: snapshot.appSecret }, async (msg: RobotMessage) => {
    if (signal.aborted) return
    const current = liveRobot(snapshot)
    // 持久化去重：SDK at-least-once，重连/重启后的重推在这里挡住（引擎内存去重跨重启失效）。
    // 空 msgId 不入环按新消息处理；seenOrAdd 写失败时放行（log 在其内部），绝不因去重层吞消息。
    if (msg.msgId && (await seenOrAdd(current.rowId, msg.msgId))) {
      console.error(`[dingtalk][${robotLabel(current)}] msg skip (redelivered): msgId=${msg.msgId}`)
      return
    }
    if (msg.msgId) bumpIn(current.rowId)
    // 「思考中」表情按机器人开关（读 holder 而非闭包：切开关不重连）。
    // fire-and-forget：贴表情失败只记日志，不阻塞接收与 Stream ack。
    if (current.thinkingEmotion) {
      void attachThinkingEmotion(current.clientId, current.appSecret, { robotCode: msg.robotCode || current.robotCode, msgId: msg.msgId, conversationId: msg.conversationId })
        .catch(() => { /* 表情失败不影响接收主流程 */ })
    }
    // 文件/视频/语音附件先落盘（带超时降级），receive 时路径已就位。
    const media = await downloadMessageMedia(current, msg)
    const trigger = buildTrigger(current, msg, media)
    if (!trigger) {
      console.error(`[dingtalk] skip msg: type=${msg.msgtype} msgId=${msg.msgId} (no text after parse)`)
      return
    }
    console.error(`[dingtalk][${robotLabel(current)}] msg in: type=${msg.msgtype} msgId=${msg.msgId} chat=${msg.conversationType} text="${trigger.text.slice(0, 60)}"`)
    await source.receive(trigger)
  }, (connected) => {
    if (!connected && signal.aborted) return   // teardown disconnects are not errors
    source.report(HEALTH_ENTRY, connected
      ? { state: 'ready', detail: `[${robotLabel(liveRobot(snapshot))}] stream connected ${counterDetail(snapshot.rowId)}` }
      : { state: 'error', detail: `[${robotLabel(liveRobot(snapshot))}] stream disconnected; SDK auto-reconnecting ${counterDetail(snapshot.rowId)}` })
  })
  await client.connect()
  source.report(HEALTH_ENTRY, { state: 'ready', detail: `[${robotLabel(liveRobot(snapshot))}] stream connected ${counterDetail(snapshot.rowId)}` })
  await new Promise<void>((resolve) => {
    if (signal.aborted) { resolve(); return }
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
  client.disconnect()
}

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const runners = new Map<string, { key: string; stop: () => void; done: Promise<void> }>()
  while (!signal.aborted) {
    try {
      const config = source.config<DingConfig>('dingtalk')
      const robots = config ? resolveRobots(config) : []
      if (!config || robots.length === 0) {
        // No robots configured: tear every runner down instead of leaving stale connections.
        for (const [, runner] of runners) runner.stop()
        runners.clear()
        channelConfig.current = undefined
        source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for robot configuration in settings' })
      } else {
        channelConfig.current = { config, robots }
        const wanted = new Set<string>()
        for (const robot of robots) {
          const id = robot.rowId
          if (!robot.clientId || !robot.appSecret) {
            source.report(HEALTH_ENTRY, { state: 'error', detail: `[${robotLabel(robot)}] missing AppKey / AppSecret` })
            continue
          }
          wanted.add(id)
          // Only credentials are baked into the connection; chats/toggles apply through the holder.
          const key = JSON.stringify([robot.clientId, robot.appSecret])
          const existing = runners.get(id)
          if (existing && existing.key === key) continue
          existing?.stop()
          runners.delete(id)
          if (signal.aborted) break
          const controller = new AbortController()
          const done = runRobot(source, controller.signal, robot).catch((error: unknown) => {
            console.error(`[dingtalk] robot runner ${id} crashed: ${String(error).slice(0, 240)}`)
          })
          runners.set(id, { key, stop: () => controller.abort(), done })
        }
        for (const [id, runner] of [...runners]) {
          if (!wanted.has(id)) { runner.stop(); runners.delete(id) }
        }
      }
    } catch (error) {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
    }
    await pause(5000, signal)
  }
  for (const [, runner] of runners) runner.stop()
  await Promise.allSettled([...runners.values()].map((r) => r.done))
}
