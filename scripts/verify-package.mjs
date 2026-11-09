#!/usr/bin/env node
/** Packaging integrity probe (zero-dependency): verifies what npm pack would
 *  ship before release — files[] entries exist, the built lib carries the
 *  source-registration seam and the kind name (bare substring probes, immune
 *  to quote-style churn), cordis.patch.yml mounts this package, locale files
 *  parse with identical top-level key sets, the icon and the dsh
 *  compatibility declaration exist. Prints every failure, exits 1 if any;
 *  prints "verify-package: OK" when clean. Run after pnpm check (needs lib/).
 *
 *  打包完整性探针（零依赖）：发布前核验 npm pack 会带上的东西——files[] 都存在、
 *  构建产物含注册接缝与 kind 名（不带引号子串探针，防引号风格变化造成假阴性）、
 *  cordis.patch.yml 挂载本包、locale 两份可解析且顶层 key 集合一致、icon.svg 与
 *  dsh.compatibility 存在。失败逐条打印并 exit 1；全过打印 verify-package: OK。
 *  用法：node scripts/verify-package.mjs（需先 pnpm check 产出 lib/）。 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const failures = []
const check = (name, ok, detail = '') => {
  if (!ok) failures.push(`${name}${detail ? ' — ' + detail : ''}`)
  return ok
}
const readIf = (rel) => {
  const path = join(root, rel)
  return existsSync(path) ? readFileSync(path, 'utf8') : null
}
const stripQuotes = (s) => s.replace(/^['"]|['"]$/g, '')

// 1) package.json files[] 全部存在（npm pack 白名单逐项核对）。
const pkgText = readIf('package.json')
check('package.json readable', pkgText !== null)
if (pkgText) {
  const pkg = JSON.parse(pkgText)
  for (const f of pkg.files ?? []) {
    check(`files[] entry exists: ${f}`, existsSync(join(root, f)))
  }

  // 2) 构建产物探针：sources.register( 接缝与 kind 名（不带引号子串）。
  const lib = readIf('lib/index.js')
  if (check('lib/index.js exists (run pnpm check first)', lib !== null)) {
    check('lib/index.js contains sources.register(', lib.includes('sources.register('))
    const kind = String(pkg.name ?? '').replace(/^dsh-superagent-/, '')
    check(`lib/index.js contains kind name "${kind}"`, kind === '' || lib.includes(kind))
    // P-B 路由契约探针：webServer seam 路由名防漂移（client bundle 探针 N/A：本包
    // 无 client bundle，「源设置」页壳属 P-C'）。
    check("lib/index.js contains '/dsh-dingtalk/api'", lib.includes('/dsh-dingtalk/api'), 'deliver route prefix drifted')
// P-C'：client bundle 探针（壳注册标识，防 tree-shaking 假阴性）
if (pkg.exports && pkg.exports['./client']) {
  const fsp = await import('node:fs/promises')
  const client = await fsp.readFile(resolve(root, 'lib', 'client.js'), 'utf8')
  for (const probe of [
    { label: 'sources shell page id', patterns: ['dsh-superagent-sources-settings'] },
    { label: 'sources tab slot', patterns: ['dsh.sources.settings.tabs'] },
    { label: 'panel id', patterns: ['dsh-superagent-dingtalk'] },
  ]) {
    check('client probe [' + probe.label + ']', probe.patterns.some((p) => client.includes(p)), 'missing from lib/client.js')
  }
}
    check("lib/index.js contains '/deliver'", lib.includes('/deliver'), 'deliver route literal drifted')
  }

  // 3) cordis.patch.yml 的 - id: 与包名一致（patch 真挂载本包）。
  const patch = readIf('cordis.patch.yml')
  if (check('cordis.patch.yml readable', patch !== null)) {
    const ids = [...patch.matchAll(/-\s*id:\s*(\S+)/g)].map((m) => stripQuotes(m[1] ?? ''))
    check('cordis.patch.yml - id: matches package name', ids.includes(pkg.name), `found ${JSON.stringify(ids)}`)
  }

  // 4) locale 两份可解析且顶层 key 集合一致。
  const localeKeys = {}
  for (const rel of ['locale/zh.json', 'locale/en.json']) {
    const text = readIf(rel)
    if (check(`${rel} readable`, text !== null)) {
      try {
        localeKeys[rel] = Object.keys(JSON.parse(text)).sort().join(',')
      } catch (error) {
        check(`${rel} parses as JSON`, false, String(error).slice(0, 120))
      }
    }
  }
  if (localeKeys['locale/zh.json'] !== undefined && localeKeys['locale/en.json'] !== undefined) {
    check('locale zh/en top-level key sets match',
      localeKeys['locale/zh.json'] === localeKeys['locale/en.json'],
      `zh=[${localeKeys['locale/zh.json']}] en=[${localeKeys['locale/en.json']}]`)
  }

  // 5) icon.svg 存在；6) dsh.compatibility 存在。
  check('icon.svg exists', existsSync(join(root, 'icon.svg')))
  check('dsh.compatibility exists', !!pkg.dsh?.compatibility, 'add {"dsh":{"compatibility":{...}}} to package.json')
}

if (failures.length > 0) {
  console.error(`verify-package: ${failures.length} failure(s):`)
  for (const f of failures) console.error('  ✗ ' + f)
  process.exit(1)
}
console.log('verify-package: OK')
