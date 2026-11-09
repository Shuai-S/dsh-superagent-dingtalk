/** 浏览器 client bundle：在 superagent 引擎原生面板（127.0.0.1:3082）的「源设置」共享页壳
 *  里注册钉钉 tab（P-C'，契约 §1/§4）。react 从宿主模块表 require（零 npm 依赖）。
 *  页面 JS 有意不用模板字面量。 */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}
const React = require('react') as ReactLike
import { installSourcesSettingsPage } from './shell/shell.ts'
import { DingtalkSourcesTab } from './shell/tab.ts'

/** 本包版本（「关于」tab 更新检查用；发版时与 package.json 同步改）。 */
const LOCAL_VERSION = '0.2.0'

export const inject: string[] = ['slots', 'locale']

interface ShellCtx {
  effect(fn: () => (() => void) | void, label: string): void
  slots: {
    inject(key: string, factory: () => (() => void) | void): () => void
    register(spec: Record<string, unknown>, component: unknown): () => void
  }
}

export function apply(ctx: ShellCtx): void {
  ctx.effect(() => installSourcesSettingsPage(ctx, {
    kind: 'dingtalk',
    order: 20,
    label: '钉钉',
    apiBase: '/dsh-dingtalk/api',
    packageName: 'dsh-superagent-dingtalk',
    localVersion: LOCAL_VERSION,
    React,
    renderTab: () => React.createElement(DingtalkSourcesTab, null),
  }), 'dsh-superagent-dingtalk: sources settings shell')
}
