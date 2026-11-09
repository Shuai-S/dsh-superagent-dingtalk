/** Send-failure journal: one JSONL line per failed channel.send at
 *  ~/.local/state/dsh-superagent-dingtalk/send-failures.jsonl, entries
 *  {at, channelKey, kind, error} with error capped at 300 chars and no
 *  credentials or message text; the file keeps the newest FAILURE_LOG_LIMIT
 *  lines. Write failures are logged and swallowed — journaling must never
 *  affect the send path it observes.
 *
 *  发送失败日志：channel.send 失败追加一行 JSONL 到
 *  ~/.local/state/dsh-superagent-dingtalk/send-failures.jsonl，条目
 *  {at, channelKey, kind, error}（error 截 300 字；无凭据、无消息正文），
 *  滚动保留最新 FAILURE_LOG_LIMIT 行；写失败仅 log，绝不影响发送主流程。 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const FAILURE_LOG_LIMIT = 200

export interface FailureEntry { at: string; channelKey: string; kind: string; error: string }

export function failureLogFile(baseDir?: string): string {
  return join(baseDir ?? join(homedir(), '.local', 'state', 'dsh-superagent-dingtalk'), 'send-failures.jsonl')
}

function dirnameSafe(p: string): string {
  const idx = p.lastIndexOf('/')
  return idx > 0 ? p.slice(0, idx) : '.'
}

/** 追加一条失败记录（0600 原子写，超限滚动丢弃最旧；任何写错误只 log 不抛出）。 */
export async function logSendFailure(entry: FailureEntry, baseDir?: string): Promise<void> {
  try {
    const path = failureLogFile(baseDir)
    let lines: string[] = []
    try { lines = (await readFile(path, 'utf8')).split('\n').filter((l) => l.trim()) } catch { /* 首条 */ }
    lines.push(JSON.stringify({ at: entry.at, channelKey: entry.channelKey, kind: entry.kind, error: entry.error.slice(0, 300) }))
    if (lines.length > FAILURE_LOG_LIMIT) lines = lines.slice(lines.length - FAILURE_LOG_LIMIT)
    await mkdir(dirnameSafe(path), { recursive: true })
    const tmp = path + '.tmp'
    await writeFile(tmp, lines.join('\n') + '\n', { mode: 0o600 })
    await rename(tmp, path)
  } catch (error) {
    console.error(`[dingtalk] failure log write failed (ignored): ${String(error).slice(0, 160)}`)
  }
}
