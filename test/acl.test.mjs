/** ACL 访问模式（契约 docs/rpc-contract.md §3，vendored tools/acl/acl.ts）：
 *  纯函数判定测试——缺省放行 / open 放行 / allowlist 命中 / 未命中 / 大小写
 *  敏感 / groupOnly 生效与兜底（会话类型不可得时不拒绝）/ 拒绝回执文案。
 *  零网络零引擎：从构建产物 lib/index.js 导入。 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { aclDenyNoticeText, evaluateAcl } from '../lib/index.js'

test('acl: 缺省（policy 未设）与 mode=open 一律放行', () => {
  assert.deepEqual(evaluateAcl(undefined, { actorId: 'anyone' }), { allowed: true })
  assert.deepEqual(evaluateAcl({ mode: 'open', allowUsers: [] }, { actorId: 'anyone', conversationType: 'single' }), { allowed: true })
})

test('acl: allowlist 命中放行；未命中拒绝并给原因码', () => {
  const policy = { mode: 'allowlist', allowUsers: ['zhang', 'wang'] }
  assert.deepEqual(evaluateAcl(policy, { actorId: 'zhang', conversationType: 'single' }), { allowed: true })
  const denied = evaluateAcl(policy, { actorId: 'li', conversationType: 'group' })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'allowlist')
  assert.ok(denied.denyText)
})

test('acl: allowUsers 精确匹配、大小写敏感（契约 §3）', () => {
  const policy = { mode: 'allowlist', allowUsers: ['Alice'] }
  assert.equal(evaluateAcl(policy, { actorId: 'Alice' }).allowed, true)
  assert.equal(evaluateAcl(policy, { actorId: 'alice' }).allowed, false)
})

test('acl: groupOnly 拒绝单聊；群聊放行；会话类型不可得时兜底放行（宁可放行不误伤）', () => {
  const policy = { mode: 'allowlist', allowUsers: ['u1'], groupOnly: true }
  assert.equal(evaluateAcl(policy, { actorId: 'u1', conversationType: 'group' }).allowed, true)
  const denied = evaluateAcl(policy, { actorId: 'u1', conversationType: 'single' })
  assert.equal(denied.allowed, false)
  assert.equal(denied.reason, 'group-only')
  assert.equal(evaluateAcl(policy, { actorId: 'u1' }).allowed, true)
})

test('acl: 空 actorId 在 allowlist 下拒绝（匿名不派活）', () => {
  const policy = { mode: 'allowlist', allowUsers: ['u1'] }
  assert.equal(evaluateAcl(policy, { actorId: '' }).allowed, false)
})

test('acl: 拒绝回执文案——缺省双语、自定义 denyText 覆盖、aclDenyNoticeText 取语言', () => {
  const denied = evaluateAcl({ mode: 'allowlist', allowUsers: [] }, { actorId: 'x' })
  assert.deepEqual(denied.denyText, { zh: '该机器人未向你开放。', en: 'This bot is not open to you.' })
  assert.equal(aclDenyNoticeText(denied, 'zh'), '该机器人未向你开放。')
  assert.equal(aclDenyNoticeText(denied, 'en'), 'This bot is not open to you.')
  const custom = evaluateAcl({ mode: 'allowlist', allowUsers: [], denyText: { zh: '定制文案', en: 'Custom text' } }, { actorId: 'x' })
  assert.deepEqual(custom.denyText, { zh: '定制文案', en: 'Custom text' })
  assert.equal(aclDenyNoticeText(custom, 'zh'), '定制文案')
  assert.equal(aclDenyNoticeText(custom, 'en'), 'Custom text')
})
