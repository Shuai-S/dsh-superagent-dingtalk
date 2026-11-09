// failure-log.ts：send 失败 JSONL——字段形状、error 截断、行数上限、写失败不影响主流程。
// 零网络零引擎：全部落在 mkdtemp 临时目录。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { logSendFailure, failureLogFile, FAILURE_LOG_LIMIT } from '../lib/index.js'

const makeDir = () => mkdtemp(join(tmpdir(), 'ding-faillog-'))
const readLines = async (dir) => (await readFile(failureLogFile(dir), 'utf8')).split('\n').filter((l) => l.trim())

test('failure-log: 追加一条，字段恰为 {at,channelKey,kind,error} 无凭据', async () => {
  const dir = await makeDir()
  await logSendFailure({ at: '2026-11-09T00:00:00Z', channelKey: 'rc-1:cidX', kind: 'reply', error: 'HTTP 500 oops' }, dir)
  const lines = await readLines(dir)
  assert.equal(lines.length, 1)
  const entry = JSON.parse(lines[0])
  assert.deepEqual(Object.keys(entry).sort(), ['at', 'channelKey', 'error', 'kind'])
  assert.equal(entry.channelKey, 'rc-1:cidX')
  assert.equal(entry.kind, 'reply')
  assert.equal(entry.error, 'HTTP 500 oops')
})

test('failure-log: error 截断到 300 字', async () => {
  const dir = await makeDir()
  const long = 'HTTP 400 ' + 'e'.repeat(400)
  await logSendFailure({ at: 'T', channelKey: 'k', kind: 'notice', error: long }, dir)
  const entry = JSON.parse((await readLines(dir))[0])
  assert.equal(entry.error.length, 300)
})

test('failure-log: 上限 200 行滚动保留最新', async () => {
  assert.equal(FAILURE_LOG_LIMIT, 200)
  const dir = await makeDir()
  for (let i = 0; i < FAILURE_LOG_LIMIT + 5; i++) {
    await logSendFailure({ at: 'T' + i, channelKey: 'k', kind: 'reply', error: 'e' + i }, dir)
  }
  const lines = await readLines(dir)
  assert.equal(lines.length, FAILURE_LOG_LIMIT)
  const first = JSON.parse(lines[0])
  const last = JSON.parse(lines[lines.length - 1])
  assert.equal(first.error, 'e5')                          // 最旧 5 条被丢
  assert.equal(last.error, 'e' + (FAILURE_LOG_LIMIT + 4))  // 最新保留
})

test('failure-log: 写失败不影响主流程（doesNotReject）', async () => {
  const dir = await makeDir()
  const notDir = join(dir, 'afile')
  await writeFile(notDir, 'x')   // 把普通文件当目录父级 → mkdir 必失败
  await assert.doesNotReject(logSendFailure({ at: 'T', channelKey: 'k', kind: 'reply', error: 'boom' }, join(notDir, 'sub')))
})

test('failure-log: 多条按 JSONL 每行一条（含非 ASCII 安全）', async () => {
  const dir = await makeDir()
  await logSendFailure({ at: 'T1', channelKey: 'rc:cid群', kind: 'acknowledgement', error: '中文错误' }, dir)
  await logSendFailure({ at: 'T2', channelKey: 'rc:cid群', kind: 'reply', error: '第二条' }, dir)
  const lines = await readLines(dir)
  assert.equal(lines.length, 2)
  assert.equal(JSON.parse(lines[1]).error, '第二条')
})
