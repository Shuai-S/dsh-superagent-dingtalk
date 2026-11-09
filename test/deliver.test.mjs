/** 主动投递（契约 docs/rpc-contract.md §2，P-B）：targets 读写/原子写/targetId
 *  校验/路由语义（400/404/409/受理）/deliver/test 发送桩 /health 快照 /
 *  sameOrigin 闸门。零外网：HTTP 走本机 loopback 自挂路由，fetch 只拦截
 *  api.dingtalk.com 打桩、loopback 请求透传真实 fetch。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  channelConfig, DingConfigSchema, registerDeliverRoutes, resolveRobots,
  readTargets, SEEN_LIMIT, targetsFile, touchTarget, validTargetId, writeTargets,
} from '../lib/index.js'

const API = '/dsh-dingtalk/api'
const STAFF_TARGET = { id: 'me', address: { staffId: '085' }, label: '值班', createdAt: '2026-11-09T10:00:00.000Z', lastUsedAt: '2026-11-09T10:00:00.000Z' }
const ROOM_TARGET = { id: 'room', address: { conversationId: 'cidG' }, label: '群', createdAt: '2026-11-09T10:00:00.000Z', lastUsedAt: '2026-11-09T10:00:00.000Z' }

const readyConfig = () => {
  const config = DingConfigSchema.parse({ robots: [{ clientId: 'ck', appSecret: 'sec' }], chats: [] })
  return { config, robots: resolveRobots(config) }
}

/** 模拟引擎 webServer seam：register 收集 prefix 路由，挂到真实 loopback server。 */
async function mountRoutes(deps) {
  const routes = []
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const route = routes.find((r) => url.startsWith(r.path))
    if (!route) { res.writeHead(404); res.end('no route'); return }
    void route.handler(req, res)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const webServer = { port: server.address().port, register: (route) => { routes.push(route); return () => {} } }
  registerDeliverRoutes(webServer, deps)
  return { base: 'http://127.0.0.1:' + webServer.port, close: () => new Promise((resolve) => server.close(resolve)) }
}

const post = (base, path, body) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-orchestrator-request': '1' },
  body: JSON.stringify(body ?? {}),
})

/** accessToken + robot 端点打桩（仅拦截 api.dingtalk.com，loopback 透传真实 fetch）；返回恢复函数。 */
const stubFetch = (impl) => {
  const real = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (!String(url).includes('api.dingtalk.com')) return real(url, init)
    return impl(String(url))
  }
  return () => { globalThis.fetch = real }
}
const okImpl = (u) => u.includes('oauth2/accessToken')
  ? new Response(JSON.stringify({ accessToken: 'T', expireIn: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } })
  : new Response('{}', { status: 200 })

test('targets: 读写回环、形状、原子写无 .tmp 遗留、损坏按空表容错', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ding-dlv-t-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeTargets([STAFF_TARGET], dir)
  const list = await readTargets(dir)
  assert.equal(list.length, 1)
  assert.equal(list[0].id, 'me')
  assert.equal(list[0].address.staffId, '085')
  const raw = JSON.parse(await readFile(targetsFile(dir), 'utf8'))
  assert.equal(raw.version, 1)
  assert.ok(Array.isArray(raw.targets))
  const names = await readdir(dir)
  assert.ok(names.every((n) => !n.includes('.tmp')), 'no tmp left: ' + names.join(','))
  await writeFile(targetsFile(dir), 'not json at all', 'utf8')
  assert.deepEqual(await readTargets(dir), [])
})

test('targets: targetId 校验（1–128 字符 [A-Za-z0-9._@:-]）', () => {
  assert.equal(validTargetId('ops.main@corp:9-_'), true)
  assert.equal(validTargetId('a'.repeat(128)), true)
  assert.equal(validTargetId(''), false)
  assert.equal(validTargetId('a'.repeat(129)), false)
  assert.equal(validTargetId('bad id'), false)
  assert.equal(validTargetId(42), false)
})

test('targets: touchTarget 更新 lastUsedAt；未知 id 静默不抛', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ding-dlv-t2-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  await writeTargets([STAFF_TARGET], dir)
  await touchTarget('me', dir)
  const list = await readTargets(dir)
  assert.notEqual(list[0].lastUsedAt, STAFF_TARGET.lastUsedAt)
  await touchTarget('ghost', dir)
  assert.equal((await readTargets(dir)).length, 1)
})

test('deliver: 400 形状非法 / 404 unknown-target / 409 not-ready', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ding-dlv-r-'))
  t.after(() => { channelConfig.current = undefined; return rm(dir, { recursive: true, force: true }) })
  await writeTargets([STAFF_TARGET], dir)
  let source
  const { base, close } = await mountRoutes({ source: () => source, baseDir: dir })
  t.after(close)
  let res = await post(base, API + '/deliver', { targetId: 'bad id', text: 'x' })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'bad-request')
  res = await post(base, API + '/deliver', { targetId: 'me', text: '  ' })
  assert.equal(res.status, 400)
  res = await post(base, API + '/deliver', { targetId: 'me', text: 'x', kind: 'nope' })
  assert.equal(res.status, 400)
  res = await post(base, API + '/deliver', { targetId: 'ghost', text: 'x' })
  assert.equal(res.status, 404)
  assert.equal((await res.json()).error, 'unknown-target')
  // 目标存在但 source/config 未就绪 → 409
  source = { receive: () => {} }
  res = await post(base, API + '/deliver', { targetId: 'me', text: 'x' })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error, 'not-ready')
})

test('deliver: 受理构造非人类 Trigger（staffId → oTo；conversationId → 群）并更新 lastUsedAt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ding-dlv-a-'))
  t.after(() => { channelConfig.current = undefined; return rm(dir, { recursive: true, force: true }) })
  await writeTargets([STAFF_TARGET, ROOM_TARGET], dir)
  const received = []
  const source = { receive: (trigger) => { received.push(trigger) } }
  const { base, close } = await mountRoutes({ source: () => source, baseDir: dir })
  t.after(close)
  channelConfig.current = readyConfig()
  const res = await post(base, API + '/deliver', { targetId: 'me', text: '发版完成', kind: 'reply' })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(body.accepted, true)
  assert.match(body.triggerId, /^dingtalk:deliver:/)
  assert.equal(received.length, 1)
  const trig = received[0]
  assert.equal(trig.source, 'dingtalk')
  assert.equal(trig.human, false)
  assert.equal(trig.actor.id, 'deliver')
  assert.equal(trig.text, '发版完成')
  assert.deepEqual(trig.threads, [{ source: 'dingtalk', id: 'direct:085' }])
  assert.equal(trig.channel.address.account, 'ck')
  assert.equal(trig.channel.address.staffId, '085')
  assert.equal(trig.channel.address.direct, 'true')
  // 引擎两道门（machineGate + kind scope()）所需字段断言：addressed:'direct' 过
  // machineGate；meta.isDm/accountId 供 dingtalk kind scope() 判 listened（实读引擎
  // src/policy.ts / src/sources/registry.ts，2026-11-09）。
  assert.equal(trig.addressed, 'direct')
  assert.equal(trig.meta.deliver, true)
  assert.equal(trig.meta.kind, 'reply')
  assert.equal(trig.meta.accountId, 'ck')
  assert.equal(trig.meta.isDm, true)
  const list = await readTargets(dir)
  assert.notEqual(list[0].lastUsedAt, STAFF_TARGET.lastUsedAt)
  // 群目标：threads/address/meta 带群路由（未登记群在引擎侧 admission 判定，路由仍受理）
  const res2 = await post(base, API + '/deliver', { targetId: 'room', text: '群通知' })
  assert.equal(res2.status, 200)
  const g = received[1]
  assert.deepEqual(g.threads, [{ source: 'dingtalk', id: 'cidG' }])
  assert.equal(g.channel.address.conversation, 'cidG')
  assert.equal(g.meta.conversationId, 'cidG')
  assert.equal(g.meta.isDm, false)
})

test('deliver/test: 直调 sendRobotMessage（fetch 桩）成功与失败', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ding-dlv-s-'))
  t.after(() => { channelConfig.current = undefined; return rm(dir, { recursive: true, force: true }) })
  await writeTargets([STAFF_TARGET, ROOM_TARGET], dir)
  const source = { receive: () => {} }
  const { base, close } = await mountRoutes({ source: () => source, baseDir: dir })
  t.after(close)
  channelConfig.current = readyConfig()
  let restore = stubFetch(okImpl)
  try {
    const res = await post(base, API + '/deliver/test', { targetId: 'me' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, true)
    assert.equal(body.sent, true)
    assert.match(body.detail, /oToMessages/)
    const res2 = await post(base, API + '/deliver/test', { targetId: 'room' })
    const body2 = await res2.json()
    assert.equal(body2.ok, true)
    assert.match(body2.detail, /groupMessages/)
  } finally { restore() }
  restore = stubFetch((u) => u.includes('oauth2/accessToken')
    ? new Response(JSON.stringify({ accessToken: 'T', expireIn: 7200 }), { status: 200, headers: { 'content-type': 'application/json' } })
    : new Response('forbidden', { status: 400 }))
  try {
    const res = await post(base, API + '/deliver/test', { targetId: 'me' })
    assert.equal(res.status, 200)
    const body = await res.json()
    assert.equal(body.ok, false)
    assert.equal(body.sent, false)
    assert.match(body.detail, /400/)
  } finally { restore() }
})

test('health: 状态+机器人合计计数(deny)+failure-log 尾巴+dedup 水位；sameOrigin 缺头 403', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ding-dlv-h-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const { base, close } = await mountRoutes({ source: () => undefined, baseDir: dir })
  t.after(close)
  const res = await fetch(base + API + '/health', { headers: { 'x-orchestrator-request': '1' } })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.ok, true)
  assert.equal(['ready', 'paused'].includes(body.state), true)
  assert.equal(typeof body.counters.in, 'number')
  assert.equal(typeof body.counters.deny, 'number')
  assert.deepEqual(body.failures, [])
  // dedup 水位：seen-*.json（dingtalk 形状 {version,ids}）
  await writeFile(join(dir, 'seen-ck.json'), JSON.stringify({ version: 1, ids: ['a', 'b'] }), 'utf8')
  const res2 = await fetch(base + API + '/health', { headers: { 'x-orchestrator-request': '1' } })
  const body2 = await res2.json()
  assert.equal(body2.dedup.stores, 1)
  assert.equal(body2.dedup.ids, 2)
  assert.equal(body2.dedup.limit, SEEN_LIMIT)
  const denied = await fetch(base + API + '/health')
  assert.equal(denied.status, 403)
})
