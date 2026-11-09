// robot.ts / dingtalk-kind.ts 里的纯函数：消息构造 helper、表情键、图片 key 提取。
// 不触 token/credential 路径，零网络。
import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyLink, emotionKey, THINKING_EMOTION, dingtalkImageKeys } from '../lib/index.js'

test('robot: emptyLink 构造空链接占位', () => {
  assert.deepEqual(emptyLink({ zh: '钉钉', en: 'DingTalk' }), { url: '', label: { zh: '钉钉', en: 'DingTalk' } })
})

test('robot: emotionKey 按机器人维度组键（同 msgId 两个机器人互不串扰）', () => {
  assert.equal(emotionKey({ robotCode: 'rc', msgId: 'm1', conversationId: 'c' }), 'rc:m1')
  assert.equal(emotionKey({ robotCode: '', msgId: 'm1', conversationId: 'c' }), ':m1')
})

test('robot: THINKING_EMOTION 形状固定（官方 emotion 契约）', () => {
  assert.equal(THINKING_EMOTION.emotionId, '2659900')
  assert.equal(THINKING_EMOTION.emotionName, '🤔思考中')
})

test('kind: dingtalkImageKeys 从原文提取且去重、过滤空 code', () => {
  const text = '看 [dingtalk-image:abc] 与 [dingtalk-image:abc] 及 [dingtalk-image:]'
  assert.deepEqual(dingtalkImageKeys(text), ['abc'])
  assert.deepEqual(dingtalkImageKeys('no markers here'), [])
})
