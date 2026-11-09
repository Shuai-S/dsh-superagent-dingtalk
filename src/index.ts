/**
 * dsh-superagent-dingtalk — direct DingTalk Source for dsh-superagent.
 *
 * Registers the 'dingtalk' Source kind through the same extension seam the
 * bundled watchers use (inject 'orchestrator'), then keeps one Stream-mode
 * connection per configured robot alive: robot messages arrive in real time,
 * become Triggers (each carrying the robot dimension), and replies go back
 * through the OpenAPI with the originating robot's credentials.
 *
 * @module dsh-superagent-dingtalk
 */
import type { Context } from '@deepseek-ai/cordis'
import type { OrchestratorLike } from './types.ts'
import { dingtalkKind, HEALTH_ENTRY } from './dingtalk-kind.ts'
import { watch } from './stream.ts'

export const name: string = 'dsh-superagent-dingtalk'
export const inject: string[] = ['orchestrator']

export function apply(ctx: Context): void {
  const orchestrator = (ctx as unknown as { orchestrator: OrchestratorLike }).orchestrator
  ctx.effect(() => orchestrator.sources.register(dingtalkKind), 'dingtalk: source kind')
  ctx.effect(() => {
    const source = orchestrator.context(dingtalkKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal).catch((error: unknown) => {
      source.report(HEALTH_ENTRY, { state: 'error', detail: String(error) })
    })
    return async () => { controller.abort(); await running }
  })
}
// 供测试（node --test test/，从 ../lib/index.js 导入）与下游复用的纯函数/常量：
// 零副作用，凭证类与网络类入口一律不导出。
export { dingtalkKind, DingConfigSchema, resolveRobots, idOf, robotOf, dingtalkImageKeys } from './dingtalk-kind.ts'
export { buildTrigger, connectRetry, type RealRobotMessage, type DownloadedMedia } from './stream.ts'
export { chunkText, DINGTALK_TEXT_MAX_BYTES } from './chunk.ts'
export { seenOrAdd, SEEN_LIMIT, seenFile, sanitizeSegment } from './dedup.ts'
export { logSendFailure, FAILURE_LOG_LIMIT, failureLogFile } from './failure-log.ts'
export { emptyLink, emotionKey, THINKING_EMOTION, type EmotionTarget, type RobotMessage } from './robot.ts'
