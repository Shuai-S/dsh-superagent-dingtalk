// DingConfigSchema（多机器人配置）：默认值、拒绝非法项、多机器人解析与旧配置迁移。
// 零网络零引擎：schema 与解析函数均为纯函数，从构建产物 lib/index.js 导入。
import test from 'node:test'
import assert from 'node:assert/strict'
import { DingConfigSchema, resolveRobots, idOf, robotOf } from '../lib/index.js'

const TWO_ROBOTS = {
  robots: [
    { clientId: 'ck-a', appSecret: 'sec-a' },
    { clientId: 'ck-b', appSecret: 'sec-b', robotCode: 'rc-b', label: 'B' },
  ],
  chats: [
    { openConversationId: 'cid1' },
    { robot: 'rc-b', openConversationId: 'cid2', name: 'G2' },
  ],
}

test('config: 空配置给默认值（robots/chats 空数组）', () => {
  const cfg = DingConfigSchema.parse({})
  assert.deepEqual(cfg.robots, [])
  assert.deepEqual(cfg.chats, [])
})

test('config: 0.1.x 旧扁平配置自动迁移为单行机器人 + 群列表', () => {
  const cfg = DingConfigSchema.parse({
    clientId: 'ck-old', appSecret: 'sec-old', robotCode: 'rc-old',
    directMessages: false, thinkingEmotion: true,
    chats: [{ openConversationId: 'cid9', name: '旧群' }],
  })
  assert.equal(cfg.robots.length, 1)
  assert.equal(cfg.robots[0].clientId, 'ck-old')
  assert.equal(cfg.robots[0].robotCode, 'rc-old')
  assert.equal(cfg.robots[0].directMessages, 'false')   // 旧 boolean 强转 'true'/'false'
  assert.equal(cfg.robots[0].thinkingEmotion, 'true')
  const robots = resolveRobots(cfg)
  assert.equal(robots.length, 1)
  assert.equal(robots[0].rowId, 'rc-old')
  assert.equal(robots[0].chats.length, 1)
  assert.equal(robots[0].chats[0].openConversationId, 'cid9')
  assert.equal(robots[0].directMessages, false)
})

test('config: 旧 boolean 开关强转为 select 的 true/false 字符串', () => {
  const cfg = DingConfigSchema.parse({ robots: [{ clientId: 'c', appSecret: 's', directMessages: false }], chats: [] })
  assert.equal(cfg.robots[0].directMessages, 'false')
})

test('config: 拒绝非法项（未知顶层键/缺会话 ID/坏开关/群机器人不匹配）', () => {
  assert.throws(() => DingConfigSchema.parse({ foo: 'bar' }))
  assert.throws(() => DingConfigSchema.parse({ chats: [{ name: 'no cid' }] }))
  assert.throws(() => DingConfigSchema.parse({ robots: [{ clientId: 'c', appSecret: 's', directMessages: 'yes' }] }))
  assert.throws(() => DingConfigSchema.parse({ robots: [{ clientId: 'a', appSecret: 'b' }], chats: [{ robot: 'ghost', openConversationId: 'cid' }] }))
})

test('config: 多机器人解析（rowId 归属、群挂靠、robotCode 缺省取 AppKey）', () => {
  const robots = resolveRobots(DingConfigSchema.parse(TWO_ROBOTS))
  assert.equal(robots.length, 2)
  assert.deepEqual(
    robots.map((r) => r.rowId),
    ['ck-a', 'rc-b'],   // robotCode 留空 → AppKey 兜底
  )
  assert.equal(robots[0].robotCode, 'ck-a')
  assert.equal(robots[0].chats.length, 1)               // 留空 chat 挂第一行
  assert.equal(robots[0].chats[0].openConversationId, 'cid1')
  assert.equal(robots[1].chats[0].name, 'G2')           // 显式 robot 归属第二行
  assert.equal(robots[1].label, 'B')
})

test('config: idOf/robotOf 寻址（account 优先、robotCode 次之、单机器人兜底）', () => {
  assert.equal(idOf({ clientId: 'ck', robotCode: '' }), 'ck')
  assert.equal(idOf({ clientId: '', robotCode: 'rc' }), 'rc')
  assert.equal(idOf({ clientId: '', robotCode: '' }), 'default')
  const robots = resolveRobots(DingConfigSchema.parse(TWO_ROBOTS))
  const holder = { robots }
  assert.equal(robotOf(holder, { account: 'rc-b' })?.rowId, 'rc-b')
  assert.equal(robotOf(holder, { account: 'ck-a' })?.rowId, 'ck-a')
  assert.equal(robotOf(holder, { robotCode: 'rc-b' })?.rowId, 'rc-b')
  assert.equal(robotOf(holder, {}), undefined)          // 多机器人且无维度：不猜
  const single = resolveRobots(DingConfigSchema.parse({ robots: [{ clientId: 'only', appSecret: 's' }], chats: [] }))
  assert.equal(robotOf({ robots: single }, {})?.rowId, 'only')   // 0.1.x 遗留记录兜底
})
