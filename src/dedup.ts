/** Persistent inbound-ID ring for the DingTalk Stream path: the SDK delivers
 *  at-least-once (reconnects/timeouts re-push the same msgId) and the engine's
 *  in-memory trigger dedup does not survive restarts, so redeliveries are
 *  caught here against a small on-disk ring. One file per robot
 *  (~/.local/state/dsh-superagent-dingtalk/seen-<storeKey>.json, shape
 *  {version:1,ids:[]}, FIFO cap SEEN_LIMIT), serialized write queue per file,
 *  tmp+rename atomic writes, no credentials — message IDs only.
 *
 *  持久化去重环：钉钉 Stream 是 at-least-once 投递，重连/超时会重推同 msgId，
 *  引擎内存去重（trigger id）跨重启失效，这里用磁盘环形 ID 表兜底。
 *  每 robot 一个文件（seen-<storeKey>.json，{version:1,ids:[]}，FIFO 上限
 *  SEEN_LIMIT），同文件串行写队列 + tmp+rename 原子写；零凭据，只存消息 ID。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const SEEN_LIMIT = 1000

interface SeenFile { version: 1; ids: string[] }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dingtalk')
}

/** 文件名/目录段净化：只留安全字符，防 storeKey 注入路径（约定同 wechat 仓 util.ts）。 */
export function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80) || 'unknown'
}

export function seenFile(storeKey: string, baseDir?: string): string {
  return join(stateBase(baseDir), 'seen-' + sanitizeSegment(storeKey) + '.json')
}

/** 读失败（无文件/损坏/版本不符）按空表重来；每文件只 log 一次防刷屏。 */
const warnedFiles = new Set<string>()

async function readSeen(path: string): Promise<SeenFile> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('bad shape')
    const rec = parsed as { version?: unknown; ids?: unknown }
    if (rec.version !== 1 || !Array.isArray(rec.ids)) throw new Error('bad version/ids')
    return { version: 1, ids: rec.ids.filter((x): x is string => typeof x === 'string') }
  } catch (error) {
    if (!warnedFiles.has(path)) {
      warnedFiles.add(path)
      console.error(`[dingtalk] dedup: seen file unreadable, starting fresh: ${path} (${String(error).slice(0, 120)})`)
    }
    return { version: 1, ids: [] }
  }
}

async function writeSeen(path: string, data: SeenFile): Promise<void> {
  const idx = path.lastIndexOf('/')
  await mkdir(idx > 0 ? path.slice(0, idx) : '.', { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
  await rename(tmp, path)
}

// 同文件的读写串行化：并发回调共享一个队列，防 read-modify-write 互相踩踏。
const writeQueues = new Map<string, Promise<boolean>>()

/** 判重并入环：返回 true = 之前见过（重推，应跳过）；false = 新 id（已记录）。
 *  空 id 不入环直接按新消息处理。读失败清空重来（只 log 一次）；写失败按新消息
 *  放行并 log（最坏情况是重复处理，绝不吞消息）。
 *  Returns true when id was seen before (redelivery, caller skips); false when
 *  new (recorded now). Empty ids bypass the ring. Read failures restart fresh
 *  (logged once per file); write failures pass the message through (logged). */
export async function seenOrAdd(storeKey: string, id: string, baseDir?: string): Promise<boolean> {
  if (!id) return false
  const path = seenFile(storeKey, baseDir)
  const prev = writeQueues.get(path) ?? Promise.resolve(false)
  const task = prev.catch(() => false).then(async (): Promise<boolean> => {
    try {
      const data = await readSeen(path)
      if (data.ids.includes(id)) return true
      data.ids.push(id)
      if (data.ids.length > SEEN_LIMIT) data.ids.splice(0, data.ids.length - SEEN_LIMIT)   // FIFO 丢最旧
      await writeSeen(path, data)
      return false
    } catch (error) {
      console.error(`[dingtalk] dedup: seen update failed (passing through): ${String(error).slice(0, 160)}`)
      return false
    }
  })
  writeQueues.set(path, task)
  try {
    return await task
  } finally {
    if (writeQueues.get(path) === task) writeQueues.delete(path)
  }
}
