/** The 'dingtalk' Source kind: robot messages arriving via Stream mode,
 *  replies through the OpenAPI. Multi-robot is a flat robots[] + chats[] pair
 *  (dws/mail-style; the engine keeps one config slot per kind), every trigger,
 *  address and admission row carries the robot dimension (rowId = RobotCode or
 *  AppKey) so two robots in one conversation never collide. The panel's rows
 *  dialogs render selects rather than switches, so the per-robot toggles are
 *  'true'/'false' strings with legacy booleans coerced in preprocess. Shape
 *  mirrors the dws kind; the engine duck-types it at runtime. */
import { z } from 'zod'
import type { Localized, OutboundMessageLike, SourceContextLike, SourceKindLike, TriggerLike } from './types.ts'
import { downloadDingtalkImage, emptyLink, getAccessToken, recallThinkingEmotion, sendRobotMessage } from './robot.ts'
import { bumpFail, bumpOut } from './counters.ts'
import { chunkText, DINGTALK_TEXT_MAX_BYTES } from './chunk.ts'
import { logSendFailure } from './failure-log.ts'

export const HEALTH_ENTRY = 'dingtalkStream'

interface ScopeOutcome { listened: boolean; observed?: boolean; row?: string; reason?: string }

export const RobotRowSchema = z.object({
  clientId: z.string().default(''),
  appSecret: z.string().default(''),
  robotCode: z.string().default(''),
  label: z.string().default(''),
  directMessages: z.enum(['true', 'false']).default('true'),
  thinkingEmotion: z.enum(['true', 'false']).default('true'),
}).strict()
export const ChatRowSchema = z.object({
  robot: z.string().default(''),
  openConversationId: z.string().min(1),
  name: z.string().default(''),
}).strict()

/** Coerces legacy boolean toggles into the schema's 'true'/'false' strings. */
const flagText = (value: unknown): string | undefined =>
  typeof value === 'boolean' ? (value ? 'true' : 'false') : typeof value === 'string' ? value : undefined

const normalizeRow = (row: unknown): Record<string, unknown> | undefined => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return undefined
  const next = { ...(row as Record<string, unknown>) }
  if ('directMessages' in next) next.directMessages = flagText(next.directMessages) ?? next.directMessages
  if ('thinkingEmotion' in next) next.thinkingEmotion = flagText(next.thinkingEmotion) ?? next.thinkingEmotion
  return next
}

export const DingConfigSchema = z.preprocess((raw) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw
  const record = raw as Record<string, unknown>
  if (Array.isArray(record.robots)) {
    return { ...record, robots: record.robots.map(normalizeRow).filter((r): r is Record<string, unknown> => r !== undefined) }
  }
  // Pre-0.2 configs stored one flat robot (clientId/appSecret/robotCode/...); lift it
  // into a single robots[] row so upgrades keep listening without a manual re-save.
  // Only the robot fields are lifted — chats stays a top-level list.
  if ('clientId' in record || 'appSecret' in record) {
    const row = normalizeRow({
      clientId: record.clientId,
      appSecret: record.appSecret,
      robotCode: record.robotCode,
      label: record.label,
      directMessages: record.directMessages,
      thinkingEmotion: record.thinkingEmotion,
    })
    return { robots: row ? [row] : [], chats: Array.isArray(record.chats) ? record.chats : [] }
  }
  return record
}, z.object({
  robots: z.array(RobotRowSchema).default([]),
  chats: z.array(ChatRowSchema).default([]),
}).strict()
  .refine((cfg) => cfg.chats.every((c) => !c.robot.trim() || cfg.robots.some((r) => idOf(r) === c.robot.trim())),
    "Chat robot must match a configured robot's RobotCode or AppKey (or stay empty for the first robot)"))
export type DingConfig = z.infer<typeof DingConfigSchema>
export type RobotRow = z.infer<typeof RobotRowSchema>
export type ChatRow = z.infer<typeof ChatRowSchema>

/** The robot dimension's stable id: RobotCode when set, else the AppKey
 *  (enterprise internal robots default RobotCode = AppKey). */
export const idOf = (row: { clientId: string; robotCode: string }): string =>
  row.robotCode.trim() || row.clientId.trim() || 'default'

export interface EffectiveRobot {
  rowId: string
  label: string
  clientId: string
  appSecret: string
  robotCode: string
  directMessages: boolean
  thinkingEmotion: boolean
  chats: ChatRow[]
}

/** Maps configured robot rows onto effective robots: a '' chat robot attaches to
 *  the default row (the first row) and a blank robotCode falls back to the AppKey. */
export function resolveRobots(config: DingConfig): EffectiveRobot[] {
  const rows = config.robots
  const defaultRow = rows[0]
  return rows.map((row) => ({
    rowId: idOf(row),
    label: row.label.trim(),
    clientId: row.clientId.trim(),
    appSecret: row.appSecret.trim(),
    robotCode: row.robotCode.trim() || row.clientId.trim(),
    directMessages: row.directMessages !== 'false',
    thinkingEmotion: row.thinkingEmotion !== 'false',
    chats: config.chats.filter((c) => {
      const want = c.robot.trim()
      if (!want) return row === defaultRow
      return want === idOf(row)
    }),
  }))
}

const robotLabel = (robot: EffectiveRobot): string => robot.label || robot.robotCode || robot.clientId || 'default'

/** 单块发送：sessionWebhook 优先（官方示例模式），OpenAPI group/oTo 兜底，都失败时 throw。
 *  webhook 的 HTTP 200 不代表成功：body.errcode != 0 是失败（限流/权限/参数），必须检查后才能算送达。
 *  Send one chunk: sessionWebhook first, OpenAPI group/oTo fallback; throws when both fail. */
async function sendChunk(robot: EffectiveRobot, address: Record<string, string>, text: string): Promise<void> {
  const webhook = address.sessionWebhook ?? ''
  const expiresAt = Number(address.webhookExpiresAt ?? 0) // 钉钉 sessionWebhookExpiredTime 本就是毫秒（13 位），不再乘 1000。
  if (webhook && Date.now() < expiresAt) {
    const token = await getAccessToken(robot.clientId, robot.appSecret)
    const res = await fetch(webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-acs-dingtalk-access-token': token },
      body: JSON.stringify({ msgtype: 'text', text: { content: text } }),
      signal: AbortSignal.timeout(15_000),
    })
    if (res.ok) {
      // webhook 的 HTTP 200 不代表成功：body.errcode != 0 是失败（限流/权限/参数），必须检查后才能记 sent。
      const body = (await res.json().catch(() => ({}))) as { errcode?: number; errmsg?: string }
      if (body.errcode === undefined || body.errcode === 0) {
        console.error('[dingtalk] reply sent via webhook')
        return
      }
      console.error(`[dingtalk] webhook errcode=${body.errcode} ${body.errmsg ?? ''} — falling back to OpenAPI`)
    } else {
      console.error(`[dingtalk] webhook HTTP ${res.status} — falling back to OpenAPI`)
    }
    // fall through to the OpenAPI path on webhook failure
  } else if (webhook) {
    console.error('[dingtalk] webhook expired — using OpenAPI path')
  }
  await sendRobotMessage(robot.clientId, robot.appSecret, address.robotCode || robot.robotCode, address, text)
}

/** Resolves the robot for an address/trigger: by the account id first, then by
 *  the message's own robotCode, then a single-robot fallback for records that
 *  predate the account dimension (pre-0.2 triggers and outbound addresses). */
export function robotOf(holder: { robots: EffectiveRobot[] }, address: { account?: string; robotCode?: string }): EffectiveRobot | undefined {
  const account = (address.account ?? '').trim()
  if (account) {
    const found = holder.robots.find((r) => r.rowId === account)
    if (found) return found
  }
  const code = (address.robotCode ?? '').trim()
  if (code) {
    const found = holder.robots.find((r) => r.rowId === code)
    if (found) return found
  }
  return holder.robots.length === 1 ? holder.robots[0] : undefined
}

// channel.send/image read config through this holder; watch() refreshes it every round.
export const channelConfig: { current?: { config: DingConfig; robots: EffectiveRobot[] } } = {}

/** 从消息文本提取图片 key（与 buildTrigger 内嵌的 [dingtalk-image:CODE] 标记配对；keys 必须来自原文，防任意注入）。 */
export const dingtalkImageKeys = (text: string): string[] =>
  [...new Set([...text.matchAll(/\[dingtalk-image:([^\]]+)\]/g)].map((m) => m[1] ?? ''))].filter(Boolean)

const RECEIVE_OPTIONS = [
  { value: 'true', label: { zh: '接收', en: 'On' } },
  { value: 'false', label: { zh: '不接收', en: 'Off' } },
]

/** Listening rule for one message: finds the robot row by the account dimension
 *  and derives the admission row (robot:cid for listed groups, robot:direct for
 *  DM-like chats). Standalone so channel.allowed can reuse it. */
function scopeOf(input: { meta: Record<string, unknown> }, config: DingConfig): ScopeOutcome {
  const robots = resolveRobots(config)
  const accountId = String(input.meta.accountId ?? '').trim()
  // Pre-0.2 triggers and mandates carry no account dimension; they served the single robot of that era.
  const robot = robots.find((r) => r.rowId === accountId) ?? (accountId ? undefined : robots[0])
  if (!robot) return { listened: false, reason: 'dingtalk: robot not configured: ' + (accountId || '(none)') }
  if (input.meta.isDm === true) {
    return robot.directMessages
      ? { listened: true, observed: false, row: robot.rowId + ':direct' }
      : { listened: false, reason: 'dingtalk: direct messages disabled for ' + robot.rowId }
  }
  const conversation = String(input.meta.conversationId ?? '')
  const listed = robot.chats.some((c) => c.openConversationId === conversation)
  if (listed) return { listened: true, observed: false, row: robot.rowId + ':' + conversation }
  return { listened: false, reason: 'dingtalk: chat not configured for ' + robot.rowId + ': ' + conversation }
}

export const dingtalkKind = {
  kind: 'dingtalk',
  title: { zh: '钉钉机器人', en: 'DingTalk bots' },
  description: {
    zh: '通过 Stream 模式直连钉钉：每个机器人各保持一条长连接，群内 @ 机器人或机器人单聊即可派活，回复直接回钉钉。',
    en: 'Direct DingTalk via Stream mode: every configured robot keeps its own connection; @ a bot in a chat or DM it to dispatch; replies go straight back to DingTalk.',
  },
  schema: DingConfigSchema,
  fields: [
    { key: 'robots', type: 'rows', dialog: true, label: { zh: '钉钉机器人', en: 'DingTalk robots' }, columns: [
      { key: 'clientId', type: 'text', label: { zh: 'AppKey（Client ID）', en: 'AppKey (Client ID)' }, hint: { zh: '钉钉开放平台-应用凭证页获取', en: 'From open-dev.dingtalk.com credentials page' } },
      { key: 'label', type: 'text', label: { zh: '名称', en: 'Label' }, optional: true, hint: { zh: '面板里显示的名字', en: 'Display name in the panel' } },
      { key: 'robotCode', type: 'text', label: { zh: 'RobotCode', en: 'RobotCode' }, optional: true, hint: { zh: '机器人配置页查看；企业内部机器人默认与 AppKey 相同，留空按 AppKey 处理', en: 'From the bot configuration; internal robots default to the AppKey when left empty' } },
      { key: 'appSecret', type: 'text', label: { zh: 'AppSecret（Client Secret）', en: 'AppSecret (Client Secret)' }, hint: { zh: '明文存于引擎配置（本地 sqlite，仅本机可读）；更谨慎可改用环境变量方案', en: 'Stored in engine config (local sqlite); an env-based alternative can be added later' } },
      { key: 'directMessages', type: 'select', label: { zh: '接收单聊', en: 'Direct messages' }, options: RECEIVE_OPTIONS },
      { key: 'thinkingEmotion', type: 'select', label: { zh: '「思考中」表情反馈', en: 'Thinking emotion feedback' }, options: RECEIVE_OPTIONS, hint: { zh: '收到消息时在原消息上贴「🤔思考中」，回复送达后自动撤回', en: 'Attach a thinking emotion on receipt; recalled once the reply goes out' } },
    ] },
    { key: 'chats', type: 'rows', dialog: true, label: { zh: '接收的群', en: 'Group chats' }, columns: [
      { key: 'robot', type: 'text', label: { zh: '所属机器人', en: 'Robot' }, optional: true, hint: { zh: 'robots 里该机器人的 RobotCode 或 AppKey 原文；留空 = 第一行机器人', en: "The robot row's RobotCode or AppKey verbatim; empty = the first robot row" } },
      { key: 'openConversationId', type: 'text', label: { zh: '会话 ID（cid 开头）', en: 'Conversation ID (cid...)' } },
      { key: 'name', type: 'text', label: { zh: '群名', en: 'Name' }, optional: true },
    ] },
  ],
  health: ['dingtalkStream'],
  scope(input: { meta: Record<string, unknown> }, config: DingConfig): ScopeOutcome {
    return scopeOf(input, config)
  },
  channel: {
    allowed: (address: Record<string, string>, config: DingConfig) => {
      // Lenient for records predating the account dimension: a lone robot serves them.
      if (!(address.account ?? '').trim() && !(address.robotCode ?? '').trim() && resolveRobots(config).length === 1) return true
      return scopeOf({ meta: {
        accountId: String(address.account ?? ''),
        isDm: address.direct === 'true',
        conversationId: String(address.conversation ?? ''),
      } }, config).listened
    },
    async send(_host: unknown, message: OutboundMessageLike): Promise<'sent' | 'gone'> {
      const holder = channelConfig.current
      if (!holder) throw new Error('dingtalk: channel not ready (no config yet)')
      const address = message.channel.address as Record<string, string>
      const robot = robotOf(holder, address)
      if (!robot) throw new Error('dingtalk: robot not active: ' + String(address.account ?? address.robotCode ?? '(none)'))
      // 「思考中」撤回时机 = 回复**确实送达之后**（发送失败/重试期间表情保留，仍表示处理中）；
      // acknowledgement 只是接单回执，不触发撤回。
      const recallAfterSend = message.kind !== 'acknowledgement' && robot.thinkingEmotion
      const recallEmotion = async () => {
        await recallThinkingEmotion(robot.clientId, robot.appSecret, {
          robotCode: address.robotCode || robot.robotCode,
          msgId: address.msgId ?? '',
          conversationId: address.conversation ?? '',
        }).catch((error: unknown) => { console.error(`[dingtalk] recall pipe error: ${String(error).slice(0, 200)}`) })
      }
      console.error(`[dingtalk][${robotLabel(robot)}] outbound: kind=${message.kind} msgId=${address.msgId ?? '(none)'} text="${message.text.slice(0, 40)}"`)
      // 超限切块（UTF-8 安全边界；上限值见 DINGTALK_TEXT_MAX_BYTES 的 unverified 说明）。
      // 块失败语义：第 1 块失败 → throw，引擎按整条退避重试（前文未送出，重发无害）；
      // 第 k>1 块失败 → 记失败日志后返回 'sent'：引擎重试会整条重发，已送达的前 k-1 块会在
      // 会话里重复出现，宁缺后文不重发前文；表情撤回交由 TTL 兜底（孤儿表情 30 分钟自撤）。
      const chunks = chunkText(message.text, DINGTALK_TEXT_MAX_BYTES)
      const channelKey = robot.rowId + ':' + String(address.conversation || address.staffId || '')
      for (const [k, text] of chunks.entries()) {
        try {
          await sendChunk(robot, address, text)
        } catch (error) {
          bumpFail(robot.rowId)
          void logSendFailure({ at: new Date().toISOString(), channelKey, kind: message.kind, error: String(error) })
          if (k === 0) throw error
          console.error(`[dingtalk][${robotLabel(robot)}] chunk ${k + 1}/${chunks.length} failed after earlier chunks delivered; returning sent to avoid a full resend: ${String(error).slice(0, 200)}`)
          return 'sent'
        }
      }
      if (recallAfterSend) await recallEmotion()
      bumpOut(robot.rowId)
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
    async image(agent: unknown, _commands: unknown, trigger: TriggerLike, message: { id: string; text: string }, key: string, _stateDir: string, signal: AbortSignal) {
      if (!dingtalkImageKeys(message.text).includes(key)) throw new Error('Choose an image key from this source message')
      const holder = channelConfig.current
      const robot = holder ? robotOf(holder, { account: String(trigger.meta.accountId ?? ''), robotCode: String(trigger.meta.robotCode ?? '') }) : undefined
      if (!robot) throw new Error('dingtalk: channel not ready (no config yet)')
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
      const media = await downloadDingtalkImage(robot.clientId, robot.appSecret, { downloadCode: key, robotCode: String(trigger.meta.robotCode ?? '') || robot.robotCode })
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
  // Variables the execution environment exposes to worker sessions.
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_DINGTALK_ROBOT', description: { zh: '触发工单的机器人（RobotCode 或 AppKey）；工单不是从钉钉机器人来的时为空', en: 'The robot (RobotCode or AppKey) that started the ticket; empty when it did not start on a DingTalk robot' } },
      { key: 'DSH_SUPERAGENT_DINGTALK_CHAT', description: { zh: '接下工单的钉钉会话 ID；工单不是从钉钉机器人来的时为空', en: 'The conversation id that started the ticket; empty when it did not start on a DingTalk robot' } },
    ],
    values: (input: { trigger?: TriggerLike | null }) => ({
      DSH_SUPERAGENT_DINGTALK_ROBOT: input.trigger?.source === 'dingtalk' ? String(input.trigger.meta.accountId ?? '') : '',
      DSH_SUPERAGENT_DINGTALK_CHAT: input.trigger?.source === 'dingtalk' ? String(input.trigger.meta.conversationId ?? '') : '',
    }),
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
      const parsed = DingConfigSchema.parse(config)
      const rows: { id: string; label: Localized | string; note: Localized; cells: { listedUnaddressed: boolean; unlistedAddressed: boolean; unlistedUnaddressed: boolean } }[] = []
      for (const robot of resolveRobots(parsed)) {
        for (const chat of robot.chats) {
          rows.push({
            id: robot.rowId + ':' + chat.openConversationId,
            label: chat.name || chat.openConversationId,
            note: { zh: '群聊（仅 @ 可指派）', en: 'Group chat (mention to assign)' },
            cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false },
          })
        }
        if (robot.directMessages) {
          rows.push({
            id: robot.rowId + ':direct',
            label: robotLabel(robot) + ' · 单聊',
            note: { zh: '单聊与未登记会话（均为明确指派）', en: 'DMs and unregistered chats (explicit assignments)' },
            cells: { listedUnaddressed: true, unlistedAddressed: true, unlistedUnaddressed: true },
          })
        }
      }
      return rows
    },
  },
} as unknown as SourceKindLike
