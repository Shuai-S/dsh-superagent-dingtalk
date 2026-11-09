// stream.ts 消息 → Trigger 映射纯函数（buildTrigger）与连接退避（connectRetry）。
// 零网络零引擎：只喂构造好的 RealRobotMessage/DownloadedMedia。
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTrigger, connectRetry, dingtalkImageKeys } from '../lib/index.js'

const robot = {
  rowId: 'rc-1', label: 'A', clientId: 'ck', appSecret: 'sec', robotCode: 'rc-1',
  directMessages: true, thinkingEmotion: true,
  chats: [{ robot: '', openConversationId: 'cidG', name: 'G' }],
}

const baseMsg = {
  conversationId: 'cidG', conversationType: '1', msgId: 'm1',
  senderStaffId: 'u1', senderNick: '张三', msgtype: 'text', robotCode: 'rc-1',
  text: { content: '你好' }, createAt: 1731100000000,
}

test('trigger: 群内 @ 消息 → mention、地址带机器人维度', () => {
  const t = buildTrigger(robot, { ...baseMsg, isInAtList: true })
  assert.ok(t)
  assert.equal(t.id, 'dingtalk:rc-1:m1')
  assert.equal(t.addressed, 'mention')
  assert.equal(t.human, true)
  assert.equal(t.text, '你好')
  assert.equal(t.channel.address.account, 'rc-1')
  assert.equal(t.channel.address.robotCode, 'rc-1')
  assert.equal(t.channel.address.conversation, 'cidG')
  assert.equal(t.meta.accountId, 'rc-1')
  assert.equal(t.meta.isDm, false)
  assert.equal(t.meta.isConfiguredGroup, true)
})

test('trigger: atUsers 非空也算 mention', () => {
  const t = buildTrigger(robot, { ...baseMsg, atUsers: [{ dingtalkId: 'd', staffId: 'u1' }] })
  assert.equal(t?.addressed, 'mention')
})

test('trigger: 未登记会话按单聊（direct）处理', () => {
  const t = buildTrigger(robot, { ...baseMsg, conversationId: 'cidOther' })
  assert.equal(t?.addressed, 'direct')
  assert.equal(t?.meta.isDm, true)
  assert.equal(t?.channel.address.direct, 'true')
})

test('trigger: richText 图文 → 文本拼接 + 图片标记，与 images() 配对', () => {
  const t = buildTrigger(robot, {
    ...baseMsg,
    msgtype: 'richText',
    text: undefined,
    content: { richText: [
      { type: 'text', text: '看图' },
      { type: 'picture', downloadCode: 'dc1' },
      { type: 'picture', downloadCode: 'dc1' },
    ] },
  })
  assert.ok(t)
  assert.ok(t.text.includes('看图'))
  assert.ok(t.text.includes('[dingtalk-image:dc1]'))
  assert.deepEqual(dingtalkImageKeys(t.text), ['dc1'])
})

test('trigger: 语音优先取官方转写 recognition', () => {
  const t = buildTrigger(robot, {
    ...baseMsg,
    msgtype: 'audio',
    text: undefined,
    content: { downloadCode: 'ac1', recognition: ' 转写文字 ' },
  })
  assert.equal(t?.text, '转写文字')
})

test('trigger: 空文本返回 undefined（跳过）', () => {
  assert.equal(buildTrigger(robot, { ...baseMsg, text: { content: '   ' } }), undefined)
})

test('trigger: 落盘媒体注入提示文本', () => {
  const t = buildTrigger(robot, baseMsg, [{ kind: 'file', code: 'x', path: '/tmp/f.pdf', name: 'doc.pdf' }])
  assert.ok(t?.text.includes('文件已保存: /tmp/f.pdf'))
  assert.ok(t?.text.includes('原名: doc.pdf'))
})

test('trigger: 下载失败降级说明也注入', () => {
  const t = buildTrigger(robot, baseMsg, [{ kind: 'video', code: 'x', name: 'v.mp4', error: 'HTTP 403' }])
  assert.ok(t?.text.includes('钉钉视频下载失败'))
  assert.ok(t?.text.includes('HTTP 403'))
})

test('stream: connectRetry 退避曲线（1s 起步、翻倍、60s 封顶、稳态重置）', () => {
  assert.equal(connectRetry(undefined, 0), 1000)
  assert.equal(connectRetry(undefined, 61_000), 1000)   // 稳定跑过 1 分钟 → 重置
  assert.equal(connectRetry(1000, 5_000), 2000)
  assert.equal(connectRetry(2000, 5_000), 4000)
  assert.equal(connectRetry(30_000, 5_000), 60_000)
  assert.equal(connectRetry(60_000, 100), 60_000)
  assert.equal(connectRetry(1000, 60_000), 1000)
})
