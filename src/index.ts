/**
 * dsh-superagent-dingtalk — direct DingTalk Source for dsh-superagent.
 *
 * Registers the 'dingtalk' Source kind through the same extension seam the
 * bundled watchers use (inject 'orchestrator'), then keeps a Stream-mode
 * connection to DingTalk alive: robot messages arrive in real time, become
 * Triggers, and replies go back through the OpenAPI.
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
export { dingtalkKind, DingConfigSchema } from './dingtalk-kind.ts'
