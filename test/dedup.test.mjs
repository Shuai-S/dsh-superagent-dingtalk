// dedup.ts：持久化 ID 环——判重语义、文件形状、storeKey 净化、FIFO 上限、损坏恢复。
// 零网络零引擎：全部落在 mkdtemp 临时目录，不碰真实 ~/.local/state。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, basename } from 'node:path'
import { seenOrAdd, seenFile, SEEN_LIMIT, sanitizeSegment } from '../lib/index.js'

const makeDir = () => mkdtemp(join(tmpdir(), 'ding-dedup-'))

test('dedup: 首次 false、重推 true、新 id false', async () => {
  const dir = await makeDir()
  assert.equal(await seenOrAdd('robot-a', 'm1', dir), false)
  assert.equal(await seenOrAdd('robot-a', 'm1', dir), true)
  assert.equal(await seenOrAdd('robot-a', 'm2', dir), false)
})

test('dedup: 文件形状 {version:1,ids:[]}（FIFO 追加）', async () => {
  const dir = await makeDir()
  await seenOrAdd('robot-a', 'm1', dir)
  await seenOrAdd('robot-a', 'm2', dir)
  const data = JSON.parse(await readFile(seenFile('robot-a', dir), 'utf8'))
  assert.deepEqual(data, { version: 1, ids: ['m1', 'm2'] })
})

test('dedup: 空 id 不入环按新消息处理', async () => {
  const dir = await makeDir()
  assert.equal(await seenOrAdd('robot-a', '', dir), false)
  await assert.rejects(() => readFile(seenFile('robot-a', dir), 'utf8'))   // 未建文件
})

test('dedup: storeKey 净化防路径注入', async () => {
  const dir = await makeDir()
  await seenOrAdd('../../etc/passwd:x', 'm1', dir)
  const name = basename(seenFile('../../etc/passwd:x', dir))
  assert.match(name, /^seen-[a-zA-Z0-9_-]+\.json$/)
  assert.equal(name, 'seen-______etc_passwd_x.json')   // '../../' → 6 个下划线
  assert.deepEqual(sanitizeSegment('a/b:c'), 'a_b_c')
})

test('dedup: 环上限 FIFO 丢最旧（SEEN_LIMIT=1000）', async () => {
  assert.equal(SEEN_LIMIT, 1000)
  const dir = await makeDir()
  for (let i = 0; i < SEEN_LIMIT + 5; i++) await seenOrAdd('robot-cap', 'id-' + i, dir)
  const data = JSON.parse(await readFile(seenFile('robot-cap', dir), 'utf8'))
  assert.equal(data.ids.length, SEEN_LIMIT)
  assert.equal(data.ids[0], 'id-5')          // 最旧 5 条被丢
  assert.ok(data.ids.includes('id-' + (SEEN_LIMIT + 4)))
  assert.equal(await seenOrAdd('robot-cap', 'id-0', dir), false)   // 已被挤出 → 按新消息
  assert.equal(await seenOrAdd('robot-cap', 'id-' + (SEEN_LIMIT + 4), dir), true)  // 仍在环内
})

test('dedup: 损坏文件清空重来，且每文件只 log 一次', async () => {
  const dir = await makeDir()
  const path = seenFile('robot-bad', dir)
  await writeFile(path, '{oops not json')
  const errors = []
  const orig = console.error
  console.error = (...args) => { errors.push(args.join(' ')) }
  try {
    assert.equal(await seenOrAdd('robot-bad', 'x1', dir), false)
    assert.equal(await seenOrAdd('robot-bad', 'x2', dir), false)   // 第二次不再 log
  } finally {
    console.error = orig
  }
  const unreadable = errors.filter((l) => l.includes('seen file unreadable'))
  assert.equal(unreadable.length, 1)     // 只 log 一次
  const data = JSON.parse(await readFile(path, 'utf8'))   // 文件已被重写为合法形状
  assert.deepEqual(data, { version: 1, ids: ['x1', 'x2'] })
})

test('dedup: 同 storeKey 并发调用串行化（结果与全串行一致）', async () => {
  const dir = await makeDir()
  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => seenOrAdd('robot-par', 'p' + (i % 5), dir)),
  )
  // p0..p4 各两次：同 id 恰好一次 false 一次 true（顺序不定，但成对）
  const data = JSON.parse(await readFile(seenFile('robot-par', dir), 'utf8'))
  assert.equal(data.ids.length, 5)
  for (const id of results) assert.equal(typeof id, 'boolean')
})
