/** 主动投递目标表（契约 docs/rpc-contract.md §2，P-B）：~/.local/state/
 *  dsh-superagent-dingtalk/targets.json，形状 {version:1,targets:[{id,address,
 *  label,createdAt,lastUsedAt}]}。targetId 是平台 ID 的别名（1–128 字符
 *  [A-Za-z0-9._@:-]，创建后不可改；改路由字段可以），address 是平台原生路由
 *  字段（dingtalk=staffId 或 conversationId）。读写纪律与 dedup/failure-log
 *  同款：tmp+rename 原子写、0600、模块级串行队列、容错读（损坏按空表重来，
 *  每路径只 log 一次）。目标管理 UI 属 P-C'；本模块只承载运行时读写。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const TARGETS_VERSION = 1
/** targetId 长度上限（契约 §2）。 */
export const TARGET_ID_MAX = 128
/** targetId 字符集（契约 §2）：1–128 字符 [A-Za-z0-9._@:-]。 */
export const TARGET_ID_RE = /^[A-Za-z0-9._@:-]{1,128}$/

export interface TargetRecord {
  id: string
  /** 平台原生路由字段（dingtalk：staffId 或 conversationId，可选 account 指定机器人）。 */
  address: Record<string, string>
  label: string
  createdAt: string
  lastUsedAt: string
}

export interface TargetsFile { version: 1; targets: TargetRecord[] }

function stateBase(baseDir?: string): string {
  return baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dingtalk')
}

export function targetsFile(baseDir?: string): string {
  return join(stateBase(baseDir), 'targets.json')
}

/** targetId 校验（契约：1–128 字符 [A-Za-z0-9._@:-]）。 */
export function validTargetId(id: unknown): id is string {
  return typeof id === 'string' && TARGET_ID_RE.test(id)
}

function dirnameSafe(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : '.'
}

const warnedReads = new Set<string>()

function parseTargets(raw: string): TargetRecord[] {
  const parsed = JSON.parse(raw) as Partial<TargetsFile> | null
  if (!parsed || parsed.version !== TARGETS_VERSION || !Array.isArray(parsed.targets)) throw new Error('unexpected shape')
  return parsed.targets.filter((t): t is TargetRecord =>
    !!t && typeof t === 'object' && validTargetId(t.id) && !!t.address && typeof t.address === 'object')
}

/** 读目标表（不抛出）：缺失=空表；损坏/形状不符=按空表重来，每路径只 log 一次。 */
export async function readTargets(baseDir?: string): Promise<TargetRecord[]> {
  const path = targetsFile(baseDir)
  try {
    return parseTargets(await readFile(path, 'utf8'))
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    if (code === 'ENOENT') return []
    if (!warnedReads.has(path)) {
      warnedReads.add(path)
      console.error('[dingtalk] targets: unreadable targets file, starting empty (' + String(error).slice(0, 200) + ')')
    }
    return []
  }
}

// 单文件整写串行化：并发写/touch 共享一个队列，不互踩 tmp（failure-log 同款）。
let writeTail: Promise<unknown> = Promise.resolve()

function enqueueWrite(path: string, task: () => Promise<void>): Promise<void> {
  const run = writeTail.then(task, task)
  writeTail = run.then(() => undefined, () => undefined)
  return run
}

async function writeAtomic(path: string, payload: string): Promise<void> {
  await mkdir(dirnameSafe(path), { recursive: true })
  const tmp = path + '.tmp'
  await writeFile(tmp, payload, { mode: 0o600 })
  await rename(tmp, path)
}

const serialize = (targets: TargetRecord[]): string => JSON.stringify({ version: TARGETS_VERSION, targets } satisfies TargetsFile)

/** 原子写目标表（tmp+rename，0600，串行队列）。 */
export async function writeTargets(targets: TargetRecord[], baseDir?: string): Promise<void> {
  const path = targetsFile(baseDir)
  await enqueueWrite(path, () => writeAtomic(path, serialize(targets)))
}

export async function findTarget(id: string, baseDir?: string): Promise<TargetRecord | undefined> {
  return (await readTargets(baseDir)).find((t) => t.id === id)
}

/** 更新 lastUsedAt（读改写全程入队防丢更新；目标不存在或写失败只 log，绝不抛出）。 */
export async function touchTarget(id: string, baseDir?: string): Promise<void> {
  const path = targetsFile(baseDir)
  try {
    await enqueueWrite(path, async () => {
      const targets = await readTargets(baseDir)
      const row = targets.find((t) => t.id === id)
      if (!row) return
      row.lastUsedAt = new Date().toISOString()
      await writeAtomic(path, serialize(targets))
    })
  } catch (error) {
    console.error('[dingtalk] targets: touch failed (' + String(error).slice(0, 160) + ')')
  }
}
