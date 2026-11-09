/** 主动投递路由（契约 docs/rpc-contract.md §2，P-B）：把外部系统的一条文本构造为
 *  非人类 Trigger（human:false、meta.deliver=true、actor=本包源标识）交
 *  source.receive()，回复由引擎 channel.send 回到目标 thread。路由挂引擎
 *  webServer seam（同源闸门与引擎管理 API 同款，先例 wechat/dws 面板路由）：
 *
 *  - POST /dsh-dingtalk/api/deliver       {targetId,text,kind?} → {ok,accepted,triggerId}
 *  - POST /dsh-dingtalk/api/deliver/test  {targetId} → 直调 sendRobotMessage 发双语
 *                                         测试文案（不经引擎）→ {ok,sent,detail}
 *  - GET  /dsh-dingtalk/api/health        状态 + in/out/fail/deny 计数（机器人合计）
 *                                         + 最近 20 条 failure-log + dedup 水位
 *
 *  错误码（契约 §1）：400 {error:'bad-request',detail} / 404 {error:'unknown-target'}
 *  / 409 {error:'not-ready'}；受理即响应（收件即受理，完成与否见既有 failure-log）。
 *  目标 admission 与入站同规则：单聊目标走 robot.directMessages 闸门，群目标须已
 *  登记在 robot.chats（kind scope() 判 listened，未登记群在引擎侧 disposition=
 *  filtered，路由仍按受理语义返回）。 */
import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { SourceContextLike, TriggerLike } from './types.ts'
import { sendRobotMessage } from './robot.ts'
import { channelConfig } from './dingtalk-kind.ts'
import { counterTotals } from './counters.ts'
import { SEEN_LIMIT } from './dedup.ts'
import { failureLogFile } from './failure-log.ts'
import { findTarget, touchTarget, validTargetId, type TargetRecord } from './targets.ts'

/** @deepseek-ai/dsh-host-webserver 的结构化最小面（不引入包依赖；先例 wechat/dws）。 */
export interface WebServerLike {
  readonly port: number
  register(route: {
    kind: 'exact' | 'prefix'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

export const ROUTE_PREFIX = '/dsh-dingtalk/api'

const MAX_BODY_BYTES = 64 * 1024

export interface DeliverDeps {
  /** 引擎 source 上下文持有者（receive 入口）；未就绪返回 undefined。 */
  source: () => SourceContextLike | undefined
  /** 状态目录覆盖（测试注入）；缺省 ~/.local/state/dsh-superagent-dingtalk。 */
  baseDir?: string
}

/** holder 形状（dingtalk-kind channelConfig）：config + 生效机器人。 */
type Holder = NonNullable<typeof channelConfig.current>

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) { res.end(); return }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

/** 引擎同款同源闸门（wechat bind-panel.ts sameOrigin 的镜像实现）：Host 必须
 *  loopback:<port> + x-orchestrator-request: 1 + Origin 缺省或同源。 */
export function sameOrigin(req: Pick<IncomingMessage, 'headers'>, port: number): boolean {
  const host = req.headers.host
  if (host !== '127.0.0.1:' + port && host !== 'localhost:' + port) return false
  return req.headers['x-orchestrator-request'] === '1' &&
    (req.headers.origin === undefined || req.headers.origin === 'http://' + host)
}

function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { resolve(undefined); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) }
      catch { resolve(undefined) }
    })
    req.on('error', () => resolve(undefined))
  })
}

function ready(holder: Holder | undefined): boolean {
  return !!holder && holder.robots.length > 0
}

const stateDetail = (holder: Holder | undefined): string =>
  ready(holder)
    ? 'stream robots configured; connection state rides the dingtalkStream health entry'
    : 'waiting for robot configuration in settings'

/** 双语测试文案（/deliver/test 专用）。 */
const testText = (): string => '【dsh-superagent-dingtalk】主动投递测试消息 / Delivery test message — ' + new Date().toISOString()

/** 把一条投递文本构造为非人类 Trigger（契约 §2）：human:false、meta.deliver=true、
 *  addressed:'direct'（显式推送按「明确指派」走 admission）、actor=本包源标识。
 *  address 形状：{staffId}（oTo 单聊）或 {conversationId}（群）；可选 account 指定
 *  机器人（rowId），缺省第一个。无机器人或地址为空返回 undefined。 */
export function buildDeliverTrigger(target: TargetRecord, text: string, kind: 'notice' | 'reply', holder: Holder): TriggerLike | undefined {
  const address = target.address ?? {}
  const staffId = String(address.staffId ?? '')
  const conversationId = String(address.conversationId ?? '')
  const id = 'dingtalk:deliver:' + randomUUID()
  const robot = holder.robots.find((r) => r.rowId === String(address.account ?? '')) ?? holder.robots[0]
  if (!robot) return undefined
  if (staffId) {
    // 单聊目标：meta.isDm=true 与入站单聊同款 admission（robot.directMessages 闸门）。
    return {
      id,
      source: 'dingtalk',
      threads: [{ source: 'dingtalk', id: 'direct:' + staffId }],
      actor: { source: 'dingtalk', id: 'deliver' },
      human: false,
      addressed: 'direct',
      at: new Date().toISOString(),
      text,
      channel: { source: 'dingtalk', thread: 'dingtalk:direct:' + staffId,
        address: { account: robot.rowId, conversation: '', type: '', staffId, robotCode: robot.robotCode, msgId: '', direct: 'true', sessionWebhook: '', webhookExpiresAt: '0' } },
      meta: { accountId: robot.rowId, robotCode: robot.robotCode, messageId: id, isDm: true, isConfiguredGroup: false, deliver: true, kind },
    }
  }
  if (conversationId) {
    // 群目标：与入站群消息同款 admission（chat 须已登记在 robot.chats）。
    const configured = robot.chats.some((c) => c.openConversationId === conversationId)
    return {
      id,
      source: 'dingtalk',
      threads: [{ source: 'dingtalk', id: conversationId }],
      actor: { source: 'dingtalk', id: 'deliver' },
      human: false,
      addressed: 'direct',
      at: new Date().toISOString(),
      text,
      channel: { source: 'dingtalk', thread: 'dingtalk:' + conversationId,
        address: { account: robot.rowId, conversation: conversationId, type: '', staffId: '', robotCode: robot.robotCode, msgId: '', direct: '', sessionWebhook: '', webhookExpiresAt: '0' } },
      meta: { accountId: robot.rowId, robotCode: robot.robotCode, conversationId, messageId: id, isDm: false, isConfiguredGroup: configured, deliver: true, kind },
    }
  }
  return undefined
}

/** /deliver/test：不经引擎，直调既有发送函数（sendRobotMessage，oTo/group 端点）。
 *  发送失败折进 {ok,sent,detail} 不抛出。 */
export async function deliverTestSend(target: TargetRecord, holder: Holder): Promise<{ ok: boolean; sent: boolean; detail: string }> {
  const address = target.address ?? {}
  const staffId = String(address.staffId ?? '')
  const conversationId = String(address.conversationId ?? '')
  const robot = holder.robots.find((r) => r.rowId === String(address.account ?? '')) ?? holder.robots[0]
  if (!robot) return { ok: false, sent: false, detail: 'dingtalk: no robot configured' }
  try {
    if (staffId) {
      await sendRobotMessage(robot.clientId, robot.appSecret, robot.robotCode, { staffId }, testText())
      return { ok: true, sent: true, detail: 'sent via oToMessages (robot ' + robot.rowId + ') to ' + staffId }
    }
    if (conversationId) {
      await sendRobotMessage(robot.clientId, robot.appSecret, robot.robotCode, { conversation: conversationId }, testText())
      return { ok: true, sent: true, detail: 'sent via groupMessages (robot ' + robot.rowId + ') to ' + conversationId }
    }
    return { ok: false, sent: false, detail: 'dingtalk: target address needs staffId or conversationId' }
  } catch (error) {
    return { ok: false, sent: false, detail: String(error).slice(0, 300) }
  }
}

interface FailureTailEntry { at?: string; channelKey?: string; kind?: string; error?: string }

/** failure-log 尾巴（契约：最近 20 条）；单行损坏不拖垮整表。 */
async function failureTail(baseDir?: string): Promise<FailureTailEntry[]> {
  try {
    const lines = (await readFile(failureLogFile(baseDir), 'utf8')).split('\n').filter((l) => l.trim())
    return lines.slice(-20).map((line) => {
      try { return JSON.parse(line) as FailureTailEntry } catch { return { error: 'unparsable failure-log line' } }
    })
  } catch { return [] }
}

/** dedup 水位：扫状态目录 seen-*.json 汇总各 store 的 id 数（单文件损坏跳过）。 */
async function dedupWatermark(baseDir?: string): Promise<{ stores: number; ids: number; limit: number }> {
  const dir = baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dingtalk')
  let names: string[] = []
  try { names = await readdir(dir) } catch { return { stores: 0, ids: 0, limit: SEEN_LIMIT } }
  let stores = 0
  let ids = 0
  for (const name of names) {
    if (!name.startsWith('seen-') || !name.endsWith('.json')) continue
    stores += 1
    try {
      const parsed = JSON.parse(await readFile(join(dir, name), 'utf8')) as { ids?: unknown }
      if (Array.isArray(parsed?.ids)) ids += parsed.ids.length
    } catch { /* 单文件损坏跳过 */ }
  }
  return { stores, ids, limit: SEEN_LIMIT }
}

async function handleDeliver(req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  const body = await readJsonBody(req)
  if (!body) { respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' }); return }
  const { targetId, text, kind } = body as { targetId?: unknown; text?: unknown; kind?: unknown }
  if (!validTargetId(targetId)) { respondJson(res, 400, { error: 'bad-request', detail: 'targetId must be 1-128 chars of [A-Za-z0-9._@:-]' }); return }
  if (typeof text !== 'string' || !text.trim()) { respondJson(res, 400, { error: 'bad-request', detail: 'text must be a non-empty string' }); return }
  const kindValue = kind === undefined ? 'notice' : kind
  if (kindValue !== 'notice' && kindValue !== 'reply') { respondJson(res, 400, { error: 'bad-request', detail: "kind must be 'notice' or 'reply'" }); return }
  const target = await findTarget(targetId, deps.baseDir)
  if (!target) { respondJson(res, 404, { error: 'unknown-target' }); return }
  const holder = channelConfig.current
  const source = deps.source()
  if (!holder || !source || !ready(holder)) { respondJson(res, 409, { error: 'not-ready' }); return }
  const trigger = buildDeliverTrigger(target, text, kindValue, holder)
  if (!trigger) { respondJson(res, 400, { error: 'bad-request', detail: 'unroutable target address (needs staffId or conversationId)' }); return }
  try {
    await source.receive(trigger)
  } catch (error) {
    respondJson(res, 500, { error: 'internal', detail: String(error).slice(0, 300) })
    return
  }
  // lastUsedAt 落盘后再应答（本地小文件原子写；确定性优先，测试也据此断言）。
  await touchTarget(targetId, deps.baseDir)
  respondJson(res, 200, { ok: true, accepted: true, triggerId: trigger.id })
}

async function handleDeliverTest(req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  const body = await readJsonBody(req)
  if (!body) { respondJson(res, 400, { error: 'bad-request', detail: 'invalid JSON body' }); return }
  const { targetId } = body as { targetId?: unknown }
  if (!validTargetId(targetId)) { respondJson(res, 400, { error: 'bad-request', detail: 'targetId must be 1-128 chars of [A-Za-z0-9._@:-]' }); return }
  const target = await findTarget(targetId, deps.baseDir)
  if (!target) { respondJson(res, 404, { error: 'unknown-target' }); return }
  const holder = channelConfig.current
  if (!holder || !ready(holder)) { respondJson(res, 409, { error: 'not-ready' }); return }
  respondJson(res, 200, await deliverTestSend(target, holder))
}

async function handleHealth(_req: IncomingMessage, res: ServerResponse, deps: DeliverDeps): Promise<void> {
  const holder = channelConfig.current
  respondJson(res, 200, {
    ok: true,
    state: ready(holder) ? 'ready' : 'paused',
    detail: stateDetail(holder),
    counters: counterTotals(),
    failures: await failureTail(deps.baseDir),
    dedup: await dedupWatermark(deps.baseDir),
  })
}

/** 路由处理器（测试注入点：直接拿 handler 挂在任意 http server 上，url 需带前缀）。 */
export function createDeliverHandler(deps: DeliverDeps, port: number): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (!sameOrigin(req, port)) { respondJson(res, 403, { error: 'Same-origin management request required' }); return }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname.startsWith(ROUTE_PREFIX) ? url.pathname.slice(ROUTE_PREFIX.length) : ''
    if (path === '/deliver' && req.method === 'POST') { await handleDeliver(req, res, deps); return }
    if (path === '/deliver/test' && req.method === 'POST') { await handleDeliverTest(req, res, deps); return }
    if (path === '/health' && req.method === 'GET') { await handleHealth(req, res, deps); return }
    respondJson(res, 404, { error: 'not found' })
  }
}

/** 在引擎 webserver 上注册 /dsh-dingtalk/api 前缀路由，返回卸载 disposer。 */
export function registerDeliverRoutes(webServer: WebServerLike, deps: DeliverDeps): () => void {
  const handler = createDeliverHandler(deps, webServer.port)
  return webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: (req, res) => {
      handler(req, res).catch((error: unknown) => {
        console.error('[dingtalk-deliver] request error: ' + String(error).slice(0, 200))
        respondJson(res, 400, { error: 'bad request' })
      })
    },
  })
}
