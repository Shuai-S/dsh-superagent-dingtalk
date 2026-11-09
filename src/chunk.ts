/** UTF-8-safe long-text chunking for DingTalk robot sends: a single text
 *  message has a length ceiling, so oversized replies are split into chunks
 *  that each survive a round trip without corrupting multi-byte characters or
 *  surrogate pairs. Cut-point priority: paragraph break (\n\n) > line break
 *  (\n) > space > hard cut; joining the chunks with '' reproduces the input
 *  byte-for-byte.
 *
 *  长文本切块：钉钉机器人单条文本有长度上限，超限回复按 UTF-8 安全边界切开。
 *  切点优先级 \n\n > \n > 空格 > 硬切；绝不劈多字节字符与代理对；
 *  各块按序拼接（join('')）与原文完全一致。 */

/** 钉钉机器人单条文本上限（字节）。unverified：官方文档在线核实失败（文档站为
 *  SPA 渲染抓不到正文，公开资料仅核实到自定义机器人 20 条/分钟的频率限制），
 *  取 2000 字节保守值——宁可多分一块，不可整条被拒。
 *  DingTalk robot text ceiling in bytes. UNVERIFIED: the official doc page is
 *  a client-rendered SPA that could not be scraped (only the 20 msg/min
 *  custom-robot rate limit was confirmable); 2000 is deliberately conservative. */
export const DINGTALK_TEXT_MAX_BYTES = 2000

/** 把 text 按安全边界切成每块 ≤ maxBytes 字节（UTF-8 计）的数组。
 *  空串返回 ['']（保证至少一块，调用方按单块发送）；单块放不下一个码点时
 *  允许该块超限（保底推进，避免死循环）。
 *  Split text into chunks of at most maxBytes UTF-8 bytes each. '' yields
 *  [''] (always at least one chunk); when even one code point exceeds
 *  maxBytes that chunk is emitted oversized to guarantee progress. */
export function chunkText(text: string, maxBytes: number): string[] {
  if (!Number.isFinite(maxBytes) || maxBytes < 1) throw new Error(`chunkText: maxBytes must be >= 1, got ${maxBytes}`)
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return [text]
  const chunks: string[] = []
  let rest = text
  while (Buffer.byteLength(rest, 'utf8') > maxBytes) {
    const cut = findCut(rest, maxBytes)
    chunks.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) chunks.push(rest)
  return chunks
}

/** 在 s 的前 maxBytes 字节内选切点（返回 UTF-16 码元下标，供 String.slice 使用；>0 保证推进）。
 *  字节计数做限长判据，码元下标做切割位置——两者只在 ASCII 重合，多字节字符必须分开记。
 *  优先「\n\n 空行段尾 > \n 行尾 > 空格后」，都没有则硬切到最后一个完整码点边界。
 *  Pick a cut point within the first maxBytes bytes and return its UTF-16 code
 *  unit index (what String.slice consumes); bytes drive the limit, units drive
 *  the cut — they only coincide for ASCII. Prefers a \n\n run end, then a \n
 *  line end, then a space; falls back to the last full code point boundary. */
function findCut(s: string, maxBytes: number): number {
  let bytes = 0             // 已纳入前缀的字节数 / bytes accumulated into the prefix
  let units = 0             // 前缀的码元长度 = slice 下标 / prefix length in code units = slice index
  let hard = 0, space = -1, nl = -1, par = -1
  const cps = [...s]        // 按码点遍历：代理对天然原子 / code points: surrogate pairs stay atomic
  for (let i = 0; i < cps.length; i++) {
    const cp = cps[i] as string
    const size = Buffer.byteLength(cp, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    units += cp.length
    hard = units
    const prev = i > 0 ? cps[i - 1] as string : ''
    if (cp === '\n') {
      if (prev === '\n') par = units     // 空行段以本码点收尾 / a \n\n run ends here
      else nl = units
    } else if (cp === ' ') {
      space = units
    }
  }
  const cut = par > 0 ? par : nl > 0 ? nl : space > 0 ? space : hard
  if (cut > 0) return cut
  // 连一个码点都放不下（maxBytes < 首码点字节数）：按首码点推进，该块允许超限。
  // Even one code point does not fit: advance by it; that chunk may exceed maxBytes.
  return (cps[0] ?? '').length || 1
}
