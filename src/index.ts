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
import { registerDeliverRoutes, type WebServerLike } from './deliver.ts'

export const name: string = 'dsh-superagent-dingtalk'
// webServer = 引擎面板 webserver（同源 /dsh-dingtalk/api 路由 seam，先例 wechat/dws 面板路由）。
export const inject: string[] = ['orchestrator', 'webServer']

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
  // 主动投递路由（契约 §2，P-B）：dingtalk 首次引入 webServer seam——seam 不在时
  // log 一次并跳过路由注册（不影响 Source 本体），注册异常同样吞掉不崩启动。
  const webServer = (ctx as unknown as { webServer?: WebServerLike }).webServer
  if (webServer) {
    try {
      ctx.effect(() => registerDeliverRoutes(webServer, { source: () => orchestrator.context(dingtalkKind) }), 'dingtalk: deliver routes')
    } catch (error) {
      console.error('[dingtalk] deliver routes unavailable (webServer seam failed): ' + String(error).slice(0, 200))
    }
  } else {
    console.error('[dingtalk] webServer seam absent; /dsh-dingtalk/api deliver routes skipped')
  }
}
// 供测试（node --test test/，从 ../lib/index.js 导入）与下游复用的纯函数/常量：
// 零副作用，凭证类与网络类入口一律不导出。
export { dingtalkKind, DingConfigSchema, resolveRobots, idOf, robotOf, dingtalkImageKeys, channelConfig } from './dingtalk-kind.ts'
export { buildTrigger, connectRetry, type RealRobotMessage, type DownloadedMedia } from './stream.ts'
export { chunkText, DINGTALK_TEXT_MAX_BYTES } from './chunk.ts'
export { seenOrAdd, SEEN_LIMIT, seenFile, sanitizeSegment } from './dedup.ts'
export { logSendFailure, FAILURE_LOG_LIMIT, failureLogFile } from './failure-log.ts'
export { emptyLink, emotionKey, THINKING_EMOTION, type EmotionTarget, type RobotMessage } from './robot.ts'
// ACL 访问模式（契约 §3，vendored tools/acl/acl.ts）与主动投递目标表/路由（契约 §2）
export { evaluateAcl, aclDenyNoticeText } from './acl.ts'
export type { AclDenyText, AclInput, AclPolicy, AclVerdict } from './acl.ts'
export { targetsFile, readTargets, writeTargets, findTarget, touchTarget, validTargetId, TARGET_ID_MAX, TARGET_ID_RE, TARGETS_VERSION, type TargetRecord, type TargetsFile } from './targets.ts'
export { ROUTE_PREFIX, buildDeliverTrigger, createDeliverHandler, deliverTestSend, registerDeliverRoutes, sameOrigin, type DeliverDeps, type WebServerLike } from './deliver.ts'
export { bumpDeny, counterTotals } from './counters.ts'
