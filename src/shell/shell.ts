/**
 * 「源设置」共享页壳（canonical：/Users/zs/MyCode/dsh-plugin/tools/sources-settings-shell/shell.ts）
 *
 *  各源包 vendored 本文件副本（契约 docs/rpc-contract.md §4；包间零 npm 依赖）。
 *  依据：docs/spike-slots-findings.md（S1 同 id 竞争分支 / S2 全局 SlotCore 单例）+ E4/E5 注册形状。
 *
 *  收敛模型（对契约 §4 slots-children 方案的实现化，README 有记录）：
 *  - tab 聚合用同域 window 注册表 window.__DSH_SOURCES_SETTINGS_TABS__：全部 client bundle
 *    由同一 Loader 装进同一页面 JS realm（findings E6），共享对象天然跨包；不依赖未实证的
 *    page children spec 形状（E3 只证 Host 层声明）。
 *  - 页面竞争：slots.inject('main', factory)，工厂内 register({name:'main', key: PAGE_ID})——
 *    静态路径同 id 同 priority 同步 throw（S1/E1-L163-190），catch 即退为纯贡献方；runner 路径
 *    shadow 无害（壳同构，渲染 window 注册表全量 tab）。
 *  - 侧栏行「源设置」：仅页面赢家注册（sidebar.panellist list 同 id 同 priority 亦 throw）——恒一行。
 *  - 卸载：ctx.effect 清理把本包 tab 移出注册表并通知壳重渲染（fiber 级联回收语义）。
 *  - React 经宿主模块表 require('react')（与各包 client.ts 同款，零 npm 依赖）。
 *
 *  页面 JS 纪律：不用模板字面量（与 src/bind-page.ts 同款，字符串拼接）。
 */

type AnyRecord = Record<string, any>

interface ReactLike {
  createElement(type: unknown, props?: AnyRecord | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}
interface SlotsLike {
  inject(key: string, factory: () => (() => void) | void): () => void
  register(spec: AnyRecord, component: unknown): () => void
}
interface ShellCtx {
  effect(fn: () => (() => void) | void, label: string): void
  slots: SlotsLike
}

export interface ShellTabEntry {
  id: string
  order: number
  label: string
  apiBase: string
  /** 本渠道 tab 的 React 内容组件（零参工厂，内部自行 fetch apiBase）。 */
  component: () => unknown
}

interface TabRegistry {
  version: 1
  tabs: ShellTabEntry[]
  listeners: Set<() => void>
}

export const SHELL_PAGE_ID = 'dsh-superagent-sources-settings'
export const SHELL_TAB_SLOT = 'dsh.sources.settings.tabs'

const TAB_TITLE = '源设置'

function registry(): TabRegistry {
  const w = window as unknown as AnyRecord
  if (!w.__DSH_SOURCES_SETTINGS_TABS__) {
    w.__DSH_SOURCES_SETTINGS_TABS__ = { version: 1, tabs: [], listeners: new Set() } as TabRegistry
  }
  return w.__DSH_SOURCES_SETTINGS_TABS__ as TabRegistry
}

function sortedTabs(): ShellTabEntry[] {
  return registry().tabs.slice().sort((a, b) => a.order - b.order || (a.id < b.id ? -1 : 1))
}

function notify(): void {
  registry().listeners.forEach((fn) => { try { fn() } catch { /* 单家监听器坏不拖垮壳 */ } })
}

export function registerShellTab(entry: ShellTabEntry): () => void {
  const reg = registry()
  const idx = reg.tabs.findIndex((t) => t.id === entry.id)
  if (idx >= 0) reg.tabs[idx] = entry; else reg.tabs.push(entry)
  notify()
  return () => {
    const reg2 = registry()
    const at = reg2.tabs.findIndex((t) => t.id === entry.id)
    if (at >= 0) reg2.tabs.splice(at, 1)
    notify()
  }
}

let warned = false
function warnOnce(msg: string): void {
  if (warned) return
  warned = true
  console.error('[sources-shell] ' + msg)
}

function svgIcon(): unknown {
  const React = (globalThis as AnyRecord).__SOURCES_SHELL_REACT__ as ReactLike
  return React.createElement('svg', {
    viewBox: '0 0 16 16', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
    strokeWidth: 1, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
  },
    React.createElement('path', { d: 'M8 1.5 14 4.5v7L8 14.5 2 11.5v-7z' }),
    React.createElement('path', { d: 'M2 4.5 8 7.5l6-3M8 7.5v7' }))
}

/** 关于 tab：六个包的 npm latest 与本地版本比对。LOCAL_VERSIONS 由壳 owner 注入（window）。 */
function AboutTab(): unknown {
  const React = (globalThis as AnyRecord).__SOURCES_SHELL_REACT__ as ReactLike
  const versions = ((window as unknown as AnyRecord).__DSH_SOURCES_LOCAL_VERSIONS__ ?? {}) as AnyRecord
  const [state, setState] = React.useState<{ pkg: string; local: string; latest: string; error?: string }[]>([])
  React.useEffect(() => {
    let alive = true
    const pkgs = Object.keys(versions)
    Promise.all(pkgs.map((pkg) => fetch('https://registry.npmjs.org/' + pkg + '/latest')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error('HTTP ' + r.status))))
      .then((meta: AnyRecord) => ({ pkg, local: String(versions[pkg]), latest: String(meta.version) }))
      .catch((error: unknown) => ({ pkg, local: String(versions[pkg]), latest: '', error: String(error).slice(0, 80) })),
    )).then((rows) => { if (alive) setState(rows) })
    return () => { alive = false }
  }, [])
  return React.createElement('div', { style: { fontSize: 13 } },
    React.createElement('div', { style: { fontWeight: 600, marginBottom: 6 } }, '关于 · 更新检查'),
    state.length === 0
      ? React.createElement('div', { style: { opacity: 0.7 } }, '检查中…')
      : React.createElement('table', { style: { borderCollapse: 'collapse' } },
        React.createElement('tbody', null, state.map((row) => React.createElement('tr', { key: row.pkg },
          React.createElement('td', { style: { padding: '2px 10px 2px 0' } }, row.pkg),
          React.createElement('td', { style: { padding: '2px 10px' } }, row.local),
          React.createElement('td', { style: { padding: '2px 10px' } }, row.error ? '查询失败' : row.latest),
          React.createElement('td', { style: { padding: '2px 0', color: !row.error && row.latest !== row.local ? '#b45309' : '#16a34a' } },
            row.error ? row.error : (row.latest !== row.local ? '有更新' : '已是最新'))))),
      ),
    React.createElement('div', { style: { marginTop: 10, opacity: 0.7 } },
      '更新安装走官方路径（插件市场 / dsh plugin install），本页只做检查。'))
}

/** 安装入口：每包 client 入口 apply() 调用一次。renderTab 由各包提供（渠道特化内容）。 */
export function installSourcesSettingsPage(ctx: ShellCtx, opts: {
  kind: string
  order: number
  label: string
  apiBase: string
  packageName: string
  localVersion: string
  React: ReactLike
  renderTab: () => unknown
}): () => void {
  const React = opts.React
  ;(globalThis as AnyRecord).__SOURCES_SHELL_REACT__ = React
  const removeTab = registerShellTab({
    id: 'tab.' + opts.kind,
    order: opts.order,
    label: opts.label,
    apiBase: opts.apiBase,
    component: opts.renderTab,
  })

  let stopPage: (() => void) | undefined
  let stopRow: (() => void) | undefined
  ctx.slots.inject('main', () => {
    try {
      stopPage = ctx.slots.register(
        { name: 'main', key: SHELL_PAGE_ID, id: SHELL_PAGE_ID, tabsSlot: SHELL_TAB_SLOT, inject: () => ({}) },
        () => {
          const [active, setActive] = React.useState('')
          const [tick, setTick] = React.useState(0)
          React.useEffect(() => {
            const listener = () => setTick((v) => v + 1)
            registry().listeners.add(listener)
            return () => { registry().listeners.delete(listener) }
          }, [])
          void tick
          const tabs = sortedTabs()
          const current = tabs.find((t) => t.id === active) ?? tabs[0]
          const rows = tabs.map((t) => React.createElement('button', {
            key: t.id,
            'data-sources-tab': t.id,
            onClick: () => setActive(t.id),
            style: {
              padding: '4px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
              border: '1px solid ' + (t.id === (current && current.id) ? '#4f7cf7' : '#ddd'),
              background: t.id === (current && current.id) ? '#eef3ff' : '#fff',
            },
          }, t.label))
          const children: unknown[] = [
            React.createElement('h2', { key: 'title', style: { fontSize: 16, margin: '8px 0' } }, TAB_TITLE),
            React.createElement('div', { key: 'bar', style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } }, rows),
            React.createElement('div', { key: 'pane' }, current ? current.component() : React.createElement('div', { style: { opacity: 0.7 } }, '尚无已安装渠道')),
            React.createElement('div', { key: 'about', style: { marginTop: 16 } }, AboutTab()),
          ]
          return React.createElement('div', { 'data-sources-settings': '1', style: { padding: 16 } }, children)
        },
      )
    } catch (error) {
      warnOnce('page id occupied, acting as tab contributor only: ' + String(error).slice(0, 160))
      return
    }
    try {
      stopRow = ctx.slots.register(
        { name: 'sidebar.panellist', id: SHELL_PAGE_ID, order: opts.order, label: () => TAB_TITLE, locale: 'dshSourcesShell' },
        () => svgIcon(),
      )
    } catch (error) {
      warnOnce('sidebar row occupied: ' + String(error).slice(0, 160))
    }
    return () => { try { stopRow?.() } catch { /* ignore */ } try { stopPage?.() } catch { /* ignore */ } }
  })
  return () => { removeTab(); try { stopRow?.() } catch { /* ignore */ } try { stopPage?.() } catch { /* ignore */ } }
}
