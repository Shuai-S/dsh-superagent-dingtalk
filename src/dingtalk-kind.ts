/** The 'dingtalk' Source kind: robot messages arriving via Stream mode,
 *  replies through the OpenAPI. Shape mirrors the bundled github/feishu kinds
 *  (docs/008-cookbook.md); the engine duck-types it at runtime. */
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceContextLike, SourceKindLike, TriggerLike } from './types.ts'
import { downloadDingtalkImage, emptyLink, getAccessToken, recallThinkingEmotion, sendRobotMessage } from './robot.ts'

export interface DingChat { openConversationId: string; name: string }
export interface DingConfig {
  clientId: string
  appSecret: string
  robotCode: string
  chats: DingChat[]
  directMessages: boolean
  thinkingEmotion: boolean
}

export const HEALTH_ENTRY = 'dingtalkStream'
const dmRowId = 'direct-messages'

/** 从消息文本提取图片 key（与 buildTrigger 内嵌的 [dingtalk-image:CODE] 标记配对；keys 必须来自原文，防任意注入）。 */
const dingtalkImageKeys = (text: string): string[] =>
  [...new Set([...text.matchAll(/\[dingtalk-image:([^\]]+)\]/g)].map((m) => m[1] ?? ''))].filter(Boolean)

// channel.send reads config through this holder; watch() refreshes it every round.
export const channelConfig: { current?: DingConfig } = {}

export const DingConfigSchema = z.object({
  clientId: z.string().default(''),
  appSecret: z.string().default(''),
  robotCode: z.string().default(''),
  chats: z.array(z.object({
    openConversationId: z.string().min(1),
    name: z.string().default(''),
  })).default([]),
  directMessages: z.boolean().default(true),
  thinkingEmotion: z.boolean().default(true),
}).strict()
export type DingConfigInput = z.input<typeof DingConfigSchema>

export const dingtalkKind = {
  kind: 'dingtalk',
  title: { zh: '钉钉机器人', en: 'DingTalk bot' },
  description: { zh: '通过 Stream 模式直连钉钉：群内 @ 机器人或机器人单聊即可派活，回复直接回钉钉。', en: 'Direct DingTalk via Stream mode: @ the bot in a chat or DM it to dispatch; replies go straight back to DingTalk.' },
  schema: DingConfigSchema,
  fields: [
    { key: 'clientId', type: 'text', label: { zh: 'AppKey（Client ID）', en: 'AppKey (Client ID)' }, hint: { zh: '钉钉开放平台-应用凭证页获取', en: 'From open-dev.dingtalk.com credentials page' } },
    { key: 'appSecret', type: 'text', label: { zh: 'AppSecret（Client Secret）', en: 'AppSecret (Client Secret)' }, hint: { zh: '明文存于引擎配置（本地 sqlite，仅本机可读）；更谨慎可改用环境变量方案', en: 'Stored in engine config (local sqlite); an env-based alternative can be added later' } },
    { key: 'robotCode', type: 'text', label: { zh: 'RobotCode', en: 'RobotCode' }, hint: { zh: '机器人配置页查看，发消息必带', en: 'From the bot configuration; required for sending' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Group chats' }, columns: [
      { key: 'openConversationId', type: 'text', label: { zh: '会话 ID（cid 开头）', en: 'Conversation ID (cid...)' } },
      { key: 'name', type: 'text', label: { zh: '群名', en: 'Name' }, optional: true },
    ] },
    { key: 'directMessages', type: 'switch', label: { zh: '接收机器人单聊', en: 'Receive bot direct messages' } },
    { key: 'thinkingEmotion', type: 'switch', label: { zh: '「思考中」表情反馈', en: 'Thinking emotion feedback' }, hint: { zh: '收到消息时在原消息上贴「🤔思考中」，回复送达后自动撤回', en: 'Attach a thinking emotion on receipt; recalled once the reply goes out' } },
  ],
  health: ['dingtalkStream'],
  scope(input: { meta: Record<string, unknown> }, config: DingConfig) {
    const isDm = input.meta.isDm === true
    if (isDm) {
      if (!config.directMessages) return { listened: false, reason: 'dingtalk: direct messages disabled' }
      return { listened: true, observed: false, row: dmRowId }
    }
    const conversation = String(input.meta.conversationId ?? '')
    const row = config.chats.find((c) => c.openConversationId === conversation)
    if (!row) return { listened: false, reason: 'dingtalk: chat not configured: ' + conversation }
    return { listened: true, observed: false, row: row.openConversationId }
  },
  channel: {
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const config = (channelConfig as { current?: DingConfig }).current
      if (!config) throw new Error('dingtalk: channel not ready (no config yet)')
      const address = message.channel.address as Record<string, string>
      // 「思考中」撤回时机 = 回复**确实送达之后**（发送失败/重试期间表情保留，仍表示处理中）；
      // acknowledgement 只是接单回执，不触发撤回。
      const recallAfterSend = message.kind !== 'acknowledgement' && config.thinkingEmotion !== false
      const recallEmotion = async () => {
        await recallThinkingEmotion(config.clientId, config.appSecret, {
          robotCode: address.robotCode ?? config.robotCode,
          msgId: address.msgId ?? '',
          conversationId: address.conversation ?? '',
        }).catch((error: unknown) => { console.error(`[dingtalk] recall pipe error: ${String(error).slice(0, 200)}`) })
      }
      console.error(`[dingtalk] outbound: kind=${message.kind} msgId=${address.msgId ?? '(none)'} text="${message.text.slice(0, 40)}"`)
      const webhook = address.sessionWebhook ?? ''
      const expiresAt = Number(address.webhookExpiresAt ?? 0) // 钉钉 sessionWebhookExpiredTime 本就是毫秒（13 位），不再乘 1000。
      if (webhook && Date.now() < expiresAt) {
        const token = await getAccessToken(config.clientId, config.appSecret)
        const res = await fetch(webhook, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
          body: JSON.stringify({ msgtype: 'text', text: { content: message.text } }),
          signal: AbortSignal.timeout(15_000),
        })
        if (res.ok) {
          // webhook 的 HTTP 200 不代表成功：body.errcode != 0 是失败（限流/权限/参数），必须检查后才能记 sent。
          const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
          if (body.errcode === undefined || body.errcode === 0) {
            console.error('[dingtalk] reply sent via webhook')
            if (recallAfterSend) await recallEmotion()
            return 'sent'
          }
          console.error(`[dingtalk] webhook errcode=${body.errcode} ${body.errmsg ?? ''} — falling back to OpenAPI`)
        } else {
          console.error(`[dingtalk] webhook HTTP ${res.status} — falling back to OpenAPI`)
        }
        // fall through to the OpenAPI path on webhook failure
      } else if (webhook) {
        console.error('[dingtalk] webhook expired — using OpenAPI path')
      }
      await sendRobotMessage(config.clientId, config.appSecret, config.robotCode, address, message.text)
      if (recallAfterSend) await recallEmotion()
      return 'sent'
    },
    link(address: Record<string, string>) {
      return emptyLink({ zh: '钉钉 ' + String(address.conversation ?? '').slice(0, 12), en: 'DingTalk ' + String(address.conversation ?? '').slice(0, 12) })
    },
  },
  threadContext: {
    messageId(trigger: TriggerLike): string {
      return String(trigger.meta.messageId ?? '')
    },
    // 图片支持（先例：引擎 feishu-image.ts）——images 从文本提取 key，image 下载后经 attachments.saveImage 注入会话。
    images(text: string): string[] {
      return dingtalkImageKeys(text)
    },
    async image(agent: unknown, _commands: unknown, _trigger: TriggerLike, message: { id: string; text: string }, key: string, _stateDir: string, signal: AbortSignal) {
      if (!dingtalkImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
      const config = (channelConfig as { current?: DingConfig }).current
      if (!config) throw new Error('dingtalk: channel not ready (no config yet)')
      const host = agent as {
        ctx?: { get?: (name: string) => unknown }
        session?: { requestHeader?: () => { config?: { provider?: string; model?: string } } }
        options?: { provider?: string; model?: string }
      }
      const attachments = host.ctx?.get?.('attachments') as {
        saveImage: (input: { data: Buffer; mediaType: string; name: string }) => Promise<unknown>
        imageLimits?: { maxImageBytes?: number; maxMessageImageBytes?: number }
      } | undefined
      if (!attachments?.saveImage) throw new Error('Image reading is unavailable: no attachment service is mounted')
      const route = host.session?.requestHeader?.()?.config
      const provider = route?.provider ?? host.options?.provider
      const model = route?.model ?? host.options?.model
      const llm = host.ctx?.get?.('llm') as { resolveModelInfo?: (p: string, m: string, s: AbortSignal) => Promise<{ inputModalities?: string[] }> } | undefined
      if (!llm?.resolveModelInfo || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
      const info = await llm.resolveModelInfo(provider, model, signal)
      if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
      signal.throwIfAborted()
      const media = await downloadDingtalkImage(config.clientId, config.appSecret, { downloadCode: key, robotCode: config.robotCode })
      const maxBytes = Math.min(attachments.imageLimits?.maxImageBytes ?? 20 * 1024 * 1024, attachments.imageLimits?.maxMessageImageBytes ?? 20 * 1024 * 1024)
      if (media.data.length > maxBytes) throw new Error(`The image exceeds the ${maxBytes} byte limit`)
      const name = `dingtalk-${key.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24) || 'image'}.${media.mediaType.split('/')[1]}`
      const image = await attachments.saveImage({ data: media.data, mediaType: media.mediaType, name })
      signal.throwIfAborted()
      return { source_message_id: message.id, image_key: key, image }
    },
    async read(_commands: unknown, trigger: TriggerLike, part: 'thread' | 'root' | 'parent', _cursor: string | undefined, _config: DingConfig) {
      // v1: the assessment reads the trigger's own message; conversation history needs extra API permissions.
      const from = String(trigger.meta.senderNick ?? trigger.actor.id)
      const own = { id: String(trigger.meta.messageId ?? trigger.id), from, at: trigger.at, text: trigger.text }
      return { messages: part === 'parent' ? [] : [own], body: {}, status: undefined }
    },
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({ id: z.string(), name: z.string().optional() })).default([]),
    }).strict(),
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '允许派活的成员', en: 'Allowed members' }, columns: [
        { key: 'id', type: 'text', label: { zh: 'staffId', en: 'staffId' } },
        { key: 'name', type: 'text', label: { zh: '名称', en: 'Name' }, optional: true },
      ] },
    ],
    explicit: { zh: '群内 @ 机器人，或在机器人单聊里发言', en: 'Mentioned the bot in a chat, or messaged the bot directly' },
    rows(config: Record<string, unknown>) {
      const chats = (Array.isArray(config.chats) ? config.chats : []) as DingChat[]
      const rows: { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }[] = chats.map((c) => ({
        id: c.openConversationId,
        label: c.name || c.openConversationId,
        note: { zh: '群聊（仅 @ 可指派）', en: 'Group chat (mention to assign)' },
        cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
      }))
      if (config.directMessages !== false) {
        rows.push({ id: dmRowId, label: { zh: '机器人单聊', en: 'Bot direct messages' }, note: { zh: '单聊消息均为明确指派', en: 'DMs are explicit assignments' }, cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true } })
      }
      return rows
    },
  },
} as unknown as SourceKindLike