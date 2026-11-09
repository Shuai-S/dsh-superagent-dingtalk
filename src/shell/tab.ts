/** 钉钉渠道的「源设置」tab 内容（P-C'）：健康卡 + 投递目标管理 + deliver 测试。
 *  数据面：同源 fetch /dsh-dingtalk/api/*（sameOrigin 闸门由宿主面板同源保证）。
 *  目标 address：staffId（单聊直发）或 conversationId（已登记群）；未登记群 deliver
 *  受理但引擎 kind scope 判 filtered（UI 提示说明）。
 *  React 经宿主模块表 require（零 npm 依赖）；不用模板字面量。 */
interface ReactLike {
  createElement(type: unknown, props?: Record<string, unknown> | null, ...children: unknown[]): unknown
  useState<T>(initial: T): [T, (value: T | ((previous: T) => T)) => void]
  useEffect(effect: () => void | (() => void), deps?: unknown[]): void
}
const React = require('react') as ReactLike

const API = '/dsh-dingtalk/api'

interface HealthPayload { ok?: boolean; state?: string; detail?: string; counters?: Record<string, unknown>; failures?: unknown[] }
interface TargetRow { id: string; label: string; address: Record<string, string>; lastUsedAt: string }

function useFetch<T>(path: string, deps: unknown[]): T | undefined {
  const [data, setData] = React.useState<T | undefined>(undefined)
  React.useEffect(() => {
    let alive = true
    fetch(API + path).then((r) => r.json()).then((body: unknown) => { if (alive) setData((body as { ok?: boolean }).ok === true ? (body as T) : undefined) }).catch(() => { if (alive) setData(undefined) })
    return () => { alive = false }
  }, deps)
  return data
}

export function DingtalkSourcesTab(): unknown {
  const health = useFetch<HealthPayload>('/health', [])
  const [targets, setTargets] = React.useState<TargetRow[]>([])
  const [nonce, setNonce] = React.useState(0)
  const [msg, setMsg] = React.useState('')
  const [tid, setTid] = React.useState('')
  const [tlabel, setTlabel] = React.useState('')
  const [tstaff, setTstaff] = React.useState('')
  const [tconv, setTconv] = React.useState('')

  React.useEffect(() => {
    let alive = true
    fetch(API + '/targets').then((r) => r.json()).then((body: { ok?: boolean; targets?: TargetRow[] }) => { if (alive && body.ok) setTargets(body.targets ?? []) }).catch(() => { /* 静默 */ })
    return () => { alive = false }
  }, [nonce])

  function refresh(): void { setNonce((v) => v + 1) }
  function add(): void {
    const address: Record<string, string> = {}
    if (tconv.trim()) address.conversationId = tconv.trim(); else address.staffId = tstaff.trim()
    fetch(API + '/targets', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: tid.trim(), label: tlabel.trim(), address }) })
      .then((r) => r.json())
      .then((body: { ok?: boolean; detail?: string }) => {
        if (body.ok) { setMsg('已保存（未登记群目标在引擎侧会按 scope 过滤）'); setTid(''); setTlabel(''); setTstaff(''); setTconv(''); refresh() } else setMsg('保存失败：' + (body.detail ?? ''))
      })
      .catch((error: unknown) => setMsg('保存失败：' + String(error).slice(0, 120)))
  }
  function del(id: string): void {
    fetch(API + '/targets/' + encodeURIComponent(id), { method: 'DELETE' }).then(() => refresh()).catch(() => { /* 静默 */ })
  }
  function test(id: string): void {
    setMsg('测试发送中…')
    fetch(API + '/deliver/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetId: id }) })
      .then((r) => r.json())
      .then((body: { ok?: boolean; sent?: boolean; detail?: string }) => setMsg(body.ok && body.sent ? '测试文案已发送' : '测试未送达：' + (body.detail ?? '')))
      .catch((error: unknown) => setMsg('测试失败：' + String(error).slice(0, 120)))
  }

  const hc = health && health.state ? String(health.state) : '未知'
  const counts = (health && health.counters) || {}
  const failures = (health && health.failures) || []
  const rows = targets.map((t) => React.createElement('tr', { key: t.id },
    React.createElement('td', { style: TD }, t.id),
    React.createElement('td', { style: TD }, t.label || '-'),
    React.createElement('td', { style: TD }, String(t.address.staffId ?? t.address.conversationId ?? '')),
    React.createElement('td', { style: TD },
      React.createElement('button', { type: 'button', style: BTN, onClick: function () { test(t.id) } }, '测试'),
      React.createElement('button', { type: 'button', style: BTN_GHOST, onClick: function () { del(t.id) } }, '删除')),
  ))
  const fails = failures.map((f, i) => React.createElement('div', { key: i, style: { fontSize: 12, opacity: 0.8 } }, JSON.stringify(f)))
  return React.createElement('div', { style: { fontSize: 13 } },
    React.createElement('h3', { style: { margin: '4px 0 8px' } }, '运行状态'),
    React.createElement('div', { style: { opacity: 0.85, marginBottom: 10 } },
      '状态：' + hc + '　in=' + String(counts.in ?? '-') + ' out=' + String(counts.out ?? '-') +
      ' fail=' + String(counts.fail ?? '-') + ' deny=' + String(counts.deny ?? '-') +
      (health && health.detail ? '　' + String(health.detail).slice(0, 120) : '')),
    React.createElement('h3', { style: { margin: '4px 0 8px' } }, '投递目标'),
    React.createElement('table', { style: { borderCollapse: 'collapse', marginBottom: 8 } },
      React.createElement('tbody', null, rows)),
    React.createElement('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 6 } },
      React.createElement('input', { placeholder: 'targetId', value: tid, onChange: function (e: { target: { value: string } }) { setTid(e.target.value) }, style: INP }),
      React.createElement('input', { placeholder: '备注', value: tlabel, onChange: function (e: { target: { value: string } }) { setTlabel(e.target.value) }, style: INP }),
      React.createElement('input', { placeholder: 'staffId（单聊）', value: tstaff, onChange: function (e: { target: { value: string } }) { setTstaff(e.target.value) }, style: INP }),
      React.createElement('input', { placeholder: 'conversationId（群）', value: tconv, onChange: function (e: { target: { value: string } }) { setTconv(e.target.value) }, style: INP }),
      React.createElement('button', { type: 'button', style: BTN, onClick: function () { add() } }, '保存')),
    React.createElement('div', { style: { minHeight: 18, marginBottom: 8, color: '#b45309' } }, msg),
    React.createElement('h3', { style: { margin: '4px 0 8px' } }, '最近发送失败'),
    React.createElement('div', { style: { marginBottom: 8 } }, fails.length ? fails : React.createElement('div', { style: { opacity: 0.7 } }, '无')),
  )
}

const TD: Record<string, unknown> = { padding: '3px 10px 3px 0', borderBottom: '1px solid #eee', fontSize: 12 }
const BTN: Record<string, unknown> = { padding: '2px 10px', marginRight: 6, borderRadius: 4, border: '1px solid #4f7cf7', background: '#eef3ff', cursor: 'pointer' }
const BTN_GHOST: Record<string, unknown> = { padding: '2px 10px', borderRadius: 4, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }
const INP: Record<string, unknown> = { padding: '3px 6px', border: '1px solid #ddd', borderRadius: 4, fontSize: 12 }
