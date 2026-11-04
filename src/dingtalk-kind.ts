/** The 'dingtalk' Source kind: robot messages arriving via Stream mode,
 *  replies through the OpenAPI. Shape mirrors the bundled github/feishu kinds
 *  (docs/008-cookbook.md); the engine duck-types it at runtime. */
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceContextLike, SourceKindLike, TriggerLike } from './types.ts'
import { emptyLink, sendRobotMessage } from './robot.ts'

export interface DingChat { openConversationId: string; name: string }
export interface DingConfig {
  clientId: string
  appSecret: string
  robotCode: string
  chats: DingChat[]
  directMessages: boolean
}

export const HEALTH_ENTRY = 'dingtalkStream'
const dmRowId = 'direct-messages'

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
      await sendRobotMessage(config.clientId, config.appSecret, config.robotCode, message.channel.address as Record<string, string>, message.text)
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