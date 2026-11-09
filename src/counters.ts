/** In-process channel health counters keyed by robot rowId: the stream
 *  receive path records in/last, the channel.send path records out/fail, the
 *  ACL gate records deny, and the watch loop folds a compact
 *  "in=/out=/fail=/deny=/last=" snapshot into the health detail. Nothing here
 *  touches disk — counters restart with the process, which is exactly the
 *  window the health panel observes.
 *
 *  渠道健康计数器（进程内，不落盘）：stream 收包侧记 in/last，channel.send 侧记
 *  out/fail，ACL 闸门记 deny；watch 循环把「in=/out=/fail=/deny=/last=」紧凑快照
 *  拼进健康上报 detail。key 为机器人 rowId，各机器人各记各的；随进程重启清零，
 *  正好对应面板观察窗口。 */
interface Counter { inCount: number; outCount: number; failCount: number; denyCount: number; lastAt: number }

const counters = new Map<string, Counter>()

function slot(key: string): Counter {
  let c = counters.get(key)
  if (!c) { c = { inCount: 0, outCount: 0, failCount: 0, denyCount: 0, lastAt: 0 }; counters.set(key, c) }
  return c
}

/** 收到一条去重后的有效消息（重推被 dedup 挡掉的不计，同时刷新 last）。 */
export function bumpIn(key: string): void {
  const c = slot(key)
  c.inCount += 1
  c.lastAt = Date.now()
}

/** 一条回复完整送达（全部块成功）。 */
export function bumpOut(key: string): void { slot(key).outCount += 1 }

/** 一次回复发送失败（首块失败整条重试、后续块失败部分送达都算一次）。 */
export function bumpFail(key: string): void { slot(key).failCount += 1 }

/** 一次 ACL 拒绝（契约 §3：派发前拒绝，不进 in/out/fail，failure-log 不记）。 */
export function bumpDeny(key: string): void { slot(key).denyCount += 1 }

/** 全机器人合计（deliver /health 用）：跨 rowId 求和，无事件全 0。 */
export function counterTotals(): { in: number; out: number; fail: number; deny: number } {
  let inCount = 0
  let outCount = 0
  let failCount = 0
  let denyCount = 0
  for (const c of counters.values()) {
    inCount += c.inCount
    outCount += c.outCount
    failCount += c.failCount
    denyCount += c.denyCount
  }
  return { in: inCount, out: outCount, fail: failCount, deny: denyCount }
}

const two = (n: number): string => String(n).padStart(2, '0')

function formatClock(ts: number): string {
  const d = new Date(ts)
  return `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`
}

/** 紧凑计数串：如 "in=12 out=11 fail=0 deny=0 last=17:32:05"；从未收包时 last=-。
 *  供 stream.ts 健康上报 detail 拼接，键控与 bump* 一致（机器人 rowId）。 */
export function counterDetail(key: string): string {
  const c = counters.get(key)
  const last = c && c.lastAt > 0 ? formatClock(c.lastAt) : '-'
  return `in=${c?.inCount ?? 0} out=${c?.outCount ?? 0} fail=${c?.failCount ?? 0} deny=${c?.denyCount ?? 0} last=${last}`
}
