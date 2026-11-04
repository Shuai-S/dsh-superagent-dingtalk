/** Stream-mode client lifecycle: one DWClient per config version; robot
 *  messages become Triggers (acked immediately; trigger ids dedupe server
 *  redeliveries); connection state reports to health each poll round. */
import { DWClient, TOPIC_ROBOT, type RobotMessage } from 'dingtalk-stream'
import type { SourceContextLike, TriggerLike } from './types.ts'
import { HEALTH_ENTRY, type DingConfig } from './dingtalk-kind.ts'
import { channelConfig } from './dingtalk-kind.ts'
import { attachThinkingEmotion } from './robot.ts'

interface DownStreamLike { data: string; headers?: { messageId?: string } }

export function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return }
    const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve() }, ms)
    const stop = () => { clearTimeout(timer); resolve() }
    signal.addEventListener('abort', stop, { once: true })
  })
}

export function resolveSecret(config: DingConfig): string {
  return (config.appSecret ?? '').trim()
}

export type RealRobotMessage = RobotMessage & { isInAtList?: boolean; atUsers?: { dingtalkId: string; staffId: string }[] }

export function buildTrigger(config: DingConfig, msg: RealRobotMessage): TriggerLike | undefined {
  const text = (msg.text?.content ?? '').trim()
  if (!text) return undefined
  const isConfiguredGroup = config.chats.some((c) => c.openConversationId === msg.conversationId)
  // Anything that is not a pre-registered group conversation is treated as a
  // side chat (DM-like): dispatchable without registering every cid up front.
  const isDm = !isConfiguredGroup
  const addressed = isDm ? 'direct' as const : ((msg.isInAtList === true || (msg.atUsers ?? []).length > 0) ? 'mention' as const : undefined)
  return {
    id: 'dingtalk:' + msg.msgId,
    source: 'dingtalk',
    threads: [{ source: 'dingtalk', id: msg.conversationId }],
    actor: { source: 'dingtalk', id: msg.senderStaffId },
    human: true,
    ...(addressed ? { addressed } : {}),
    at: msg.createAt ? new Date(msg.createAt).toISOString() : new Date().toISOString(),
    text,
    channel: { source: 'dingtalk', thread: 'dingtalk:' + msg.conversationId,
      address: { conversation: msg.conversationId, type: msg.conversationType, staffId: msg.senderStaffId, robotCode: msg.robotCode || config.robotCode, sessionWebhook: msg.sessionWebhook ?? '', webhookExpiresAt: String(msg.sessionWebhookExpiredTime ?? 0), msgId: msg.msgId ?? '' } },
    meta: { conversationId: msg.conversationId, messageId: msg.msgId, isDm, isConfiguredGroup, senderNick: msg.senderNick },
  }
}

/** Wraps the dingtalk-stream DWClient so the SDK stays swappable. */
export class StreamClient {
  connected = false
  private inner: DWClient
  constructor(private readonly config: { clientId: string; clientSecret: string }, onRobot: (msg: RealRobotMessage) => Promise<void>, onConn: (connected: boolean) => void) {
    this.inner = new DWClient({ clientId: config.clientId, clientSecret: config.clientSecret, keepAlive: true, debug: false, autoReconnect: true } as never)
    this.inner.registerCallbackListener(TOPIC_ROBOT, (downstream: DownStreamLike) => {
      let msg: RobotMessage | undefined
      try { msg = JSON.parse(downstream.data) as RobotMessage } catch { return { status: 'SUCCESS' as const } }
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

export async function ensureClient(
  source: SourceContextLike,
  state: { hash: string; client?: StreamClient },
  config: DingConfig,
): Promise<void> {
  const secret = resolveSecret(config)
  const hash = JSON.stringify([config.clientId, secret, config.robotCode, config.chats, config.directMessages])
  if (state.hash === hash && state.client) return
  if (state.client) { state.client.disconnect(); state.client = undefined }
  if (!config.clientId || !secret) {
    state.hash = hash
    source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for clientId / AppSecret in settings' })
    return
  }
  const client = new StreamClient({ clientId: config.clientId, clientSecret: secret }, async (msg: RobotMessage) => {
    const trigger = buildTrigger(config, msg)
    if (!trigger) return
    // 「思考中」表情（可在设置关闭，读 channelConfig 而非闭包 config：切开关不触发重连）。
    // fire-and-forget：贴表情失败只记日志，不阻塞接收与 Stream ack。
    if (channelConfig.current?.thinkingEmotion !== false) {
      void attachThinkingEmotion(config.clientId, secret, { robotCode: msg.robotCode || config.robotCode, msgId: msg.msgId, conversationId: msg.conversationId })
        .catch(() => { /* 表情失败不影响接收主流程 */ })
    }
    await source.receive(trigger)
  }, (connected) => {
    source.report(HEALTH_ENTRY, connected
      ? { state: 'ready', detail: 'stream connected' }
      : { state: 'error', detail: 'stream disconnected; SDK auto-reconnecting' })
  })
  await client.connect()
  state.client = client
  state.hash = hash
  source.report(HEALTH_ENTRY, { state: 'ready', detail: 'stream connected' })
}

export async function watch(source: SourceContextLike, signal: AbortSignal): Promise<void> {
  const state: { hash: string; client?: StreamClient } = { hash: '' }
  while (!signal.aborted) {
    try {
      const config = source.config<DingConfig>('dingtalk')
      const ready = !!config && !!config.clientId && !!resolveSecret(config)
      if (config && ready) {
        channelConfig.current = config
        await ensureClient(source, state, config)
        if (!state.client?.isConnected()) {
          source.report(HEALTH_ENTRY, { state: 'error', detail: 'stream not connected; SDK reconnecting' })
        }
      } else {
        if (state.client) { state.client.disconnect(); state.client = undefined; state.hash = '' }
        channelConfig.current = undefined
        source.report(HEALTH_ENTRY, { state: 'paused', detail: 'waiting for clientId / AppSecret in settings' })
      }
    } catch (error) {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
    }
    await pause(5000, signal)
  }
}