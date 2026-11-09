// chunk.ts：UTF-8 安全切块——边界、限长、空串/单块、切点优先级、代理对。
import test from 'node:test'
import assert from 'node:assert/strict'
import { chunkText, DINGTALK_TEXT_MAX_BYTES } from '../lib/index.js'

const validUtf8 = (s) => Buffer.from(s, 'utf8').toString('utf8') === s

test('chunk: 空串与短文本各返回单块', () => {
  assert.deepEqual(chunkText('', 100), [''])
  assert.deepEqual(chunkText('hello', 100), ['hello'])
  assert.deepEqual(chunkText('abc', 3), ['abc'])
})

test('chunk: 上限常量为保守 2000 字节', () => {
  assert.equal(DINGTALK_TEXT_MAX_BYTES, 2000)
})

test('chunk: 每块不超限且拼接无损（ASCII 硬切）', () => {
  const chunks = chunkText('x'.repeat(100), 40)
  assert.equal(chunks.length, 3)
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= 40)
  assert.equal(chunks.join(''), 'x'.repeat(100))
})

test('chunk: 中文按完整字符切，不产生坏字节', () => {
  const text = '中'.repeat(100)
  const chunks = chunkText(text, 50)
  for (const c of chunks) {
    assert.ok(Buffer.byteLength(c, 'utf8') <= 50)
    assert.ok(validUtf8(c))
  }
  assert.equal(chunks.join(''), text)
})

test('chunk: emoji（代理对）绝不劈半', () => {
  const text = '😀'.repeat(3)
  const chunks = chunkText(text, 6)
  assert.equal(chunks.join(''), text)
  for (const c of chunks) {
    assert.ok(validUtf8(c))
    assert.ok([...c].every((cp) => cp.codePointAt(0) > 0xffff))   // 每码点完整
  }
  const mixed = chunkText('a😀b😀c', 5)
  assert.equal(mixed.join(''), 'a😀b😀c')
  for (const c of mixed) assert.ok(validUtf8(c))
})

test('chunk: 切点优先级 \n\n > \n > 空格 > 硬切', () => {
  const para = 'a'.repeat(30) + '\n\n' + 'b'.repeat(30)
  const [p1] = chunkText(para, 40)
  assert.equal(p1, 'a'.repeat(30) + '\n\n')
  const line = 'a'.repeat(30) + '\n' + 'b'.repeat(30)
  const [l1] = chunkText(line, 40)
  assert.equal(l1, 'a'.repeat(30) + '\n')
  const spaced = 'a'.repeat(30) + ' ' + 'b'.repeat(30)
  const [s1] = chunkText(spaced, 40)
  assert.equal(s1, 'a'.repeat(30) + ' ')
  const hard = chunkText('y'.repeat(90), 30)
  assert.deepEqual(hard, ['y'.repeat(30), 'y'.repeat(30), 'y'.repeat(30)])
})

test('chunk: 全部块可还原原文（拼接近似整条重发语义）', () => {
  const text = Array.from({ length: 40 }, (_, i) => `第${i}段：${'内容'.repeat(50)}\n\n`).join('')
  const chunks = chunkText(text, DINGTALK_TEXT_MAX_BYTES)
  assert.ok(chunks.length > 1)
  assert.equal(chunks.join(''), text)
  for (const c of chunks) assert.ok(Buffer.byteLength(c, 'utf8') <= DINGTALK_TEXT_MAX_BYTES)
})

test('chunk: maxBytes 非法直接拒绝', () => {
  assert.throws(() => chunkText('x', 0))
  assert.throws(() => chunkText('x', -1))
})

test('chunk: 单码点超限时保底推进不死循环', () => {
  const chunks = chunkText('😀'.repeat(3), 2)   // 一个 emoji 4 字节 > 2
  assert.equal(chunks.join(''), '😀'.repeat(3))
  assert.equal(chunks.length, 3)
})
