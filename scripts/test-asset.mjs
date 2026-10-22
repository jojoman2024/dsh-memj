/**
 * 正文图片的**读取接口**（`/asset`）与前端改写逻辑 —— 套件（2026-10-19）。
 *
 * ── 它守的是什么 ────────────────────────────────────────────────────────────
 * 在这条功能之前，知识正文里的 `![](x.png)` **百分之百取不到**：
 *   · `marked` 只负责生成 `<img src="x.png">`，**不做地址解析**；
 *   · 浏览器按**页面地址**（`/plugins/dsh-memj/`）解析相对路径
 *     ⇒ 请求打到静态目录 ⇒ 那里只有 app.js / index.html / style.css ⇒ **404**。
 * ⇒ 用户看到的是"图片全裂"（真机实测确认）。
 *
 * 修法要三件一起成立，本文件对每一件都有断言：
 *   ① `/entry` 回 `assetBase`（前端才知道基准在哪）；
 *   ② `/asset` 按**条目的 ref 所在目录**去磁盘取（`assetBaseDirOf` + `resolveAssetPath`）；
 *   ③ 前端把相对 `src` 改写成 `/asset?entry=…&path=…`（`localizeImages`）。
 *
 * 🔴🔴 **本文件里最要紧的是【安全边界】那一组** —— `/asset` 会读磁盘上的真实文件，
 *   写错一点就是"任意文件读取"。所以：
 *   · **每一条拒绝都配一条正例**（否则"全都 404"也能让这组断言全绿 —— 假绿）；
 *   · 拒绝的**理由**也要断言（"被拒"不够，要拒在对的地方）。
 *
 * ⚠️ 反证（本文件写完后跑过一次，见文件末尾的说明）：把 `resolveAssetPath` 里
 *   `..` 那道判据删掉 ⇒ 第【3】组会红；把扩展名白名单放宽到 `.js` ⇒ 第【3】组会红。
 */

import { createRequire } from 'node:module'
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
// ⚠️ 走**产物**（`lib/index.js`），不是源码 —— 与其它套件同一口径：
//    测的是"实际会被加载的那份"，源码层级的错误在这里也会暴露。
const mod = await import(`file:///${join(here, '..', 'lib', 'index.js').replace(/\\/g, '/')}`)

let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) {
    pass += 1
    return
  }
  fail += 1
  console.log(`  ❌ ${name}${detail === '' ? '' : ` —— ${detail}`}`)
}

// ══════════════════════════════════════════════════════════════════════════
// 0. 纯函数：`assetBaseDirOf`（基准目录的唯一判据）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n【0】assetBaseDirOf：基准目录 = dirname(正文文件绝对路径)')

check('内部条目：库内相对 ref ⇒ 库根/entries', (() => {
  const d = mod.assetBaseDirOf('entries/foo-12345678.md', false)
  return d !== undefined && d.replace(/\\/g, '/').endsWith('/entries')
})(), String(mod.assetBaseDirOf('entries/foo-12345678.md', false)))

// ⚠️ **断言在 2026-10-22 改过一次**（安全评审 F3）：
//    原来断言"任意绝对 ref ⇒ 它所在的目录"—— 那条与 `memj_read` 的任意读是**同一个洞**：
//    封面里的 `ref` 由内容决定 ⇒ 图片接口与正文读取都能被指到库外。
//    现在的契约：**只有落在 `MEMJ_EXT_ROOTS` 白名单内**才解析得出目录。
check('⭐⭐ 外部引用：绝对 ref **在白名单外** ⇒ undefined（不再任意解析）',
  mod.assetBaseDirOf('D:\\a\\b\\README.md', true) === undefined,
  String(mod.assetBaseDirOf('D:\\a\\b\\README.md', true)))

check('⭐⭐ 外部引用：**显式授权**该目录后 ⇒ 它所在的目录', (() => {
  process.env['MEMJ_EXT_ROOTS'] = 'D:\\a\\b'
  const d = mod.assetBaseDirOf('D:\\a\\b\\README.md', true)
  delete process.env['MEMJ_EXT_ROOTS']
  return d !== undefined && d.replace(/\\/g, '/') === 'D:/a/b'
})(), String(mod.assetBaseDirOf('D:\\a\\b\\README.md', true)))

check('⭐ 空 ref ⇒ undefined（不许回落成"当前目录"）',
  mod.assetBaseDirOf('', false) === undefined)

check('⭐ 内部 ref 试图逃出库根 ⇒ undefined（沿用 resolveInsideLibrary）',
  mod.assetBaseDirOf('../../etc/passwd', false) === undefined)

// ══════════════════════════════════════════════════════════════════════════
// 1. `resolveAssetPath` 的正例（临时目录里造真实文件）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n【1】resolveAssetPath：能取到的那些')

const tmp = await mkdtemp(join(tmpdir(), 'memj-asset-'))
const sub = join(tmp, 'docs', 'screenshots')
await mkdir(sub, { recursive: true })
await writeFile(join(sub, 'ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
await writeFile(join(sub, 'ok.JPG'), Buffer.from([0xff, 0xd8, 0xff, 0xe0]))
await writeFile(join(tmp, 'evil.js'), 'alert(1)')
await writeFile(join(tmp, 'evil.svg'), '<svg onload="alert(1)"/>')
await writeFile(join(tmp, 'big.png'), Buffer.alloc(5 * 1024 * 1024))
await mkdir(join(tmp, 'adir.png'), { recursive: true })

const okPng = await mod.resolveAssetPath(tmp, 'docs/screenshots/ok.png')
check('普通相对路径 ⇒ 解析成功且有 MIME', !('error' in okPng) && okPng.contentType === 'image/png',
  JSON.stringify(okPng))

const okJpg = await mod.resolveAssetPath(tmp, 'docs/screenshots/ok.JPG')
check('⭐⭐ .JPG（大写）也能取到，且 MIME 正确',
  !('error' in okJpg) && okJpg.contentType === 'image/jpeg', JSON.stringify(okJpg))

const okDot = await mod.resolveAssetPath(tmp, './docs/screenshots/ok.png')
check('./ 前缀被归一化（不是拒绝）', !('error' in okDot), JSON.stringify(okDot))

const okSlash = await mod.resolveAssetPath(tmp, 'docs//screenshots/ok.png')
check('重复斜杠被容忍（真实文档里常见）', !('error' in okSlash), JSON.stringify(okSlash))

// ⚠️ 关于 `..`：当前实现是"**出现就拒**"，比"净结果仍在 base 内"更严。
//    这是**有意的过度严格**（纵深防御，理由见 `resolveAssetPath` 的注释）。
//    ⇒ 所以这里断言的是"它确实被拒"，而不是"它应该被放行"。
const okUp = await mod.resolveAssetPath(tmp, 'docs/screenshots/../../../docs/screenshots/ok.png')
check('⭐⭐ 含 `..` 的路径一律被拒（有意从严，不赌"净结果恰好还在内"）',
  'error' in okUp, JSON.stringify(okUp))

// ══════════════════════════════════════════════════════════════════════════
// 2. `resolveAssetPath` 的拒绝（安全边界）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n【2】resolveAssetPath：必须拒绝的那些（并核对拒绝理由）')

const mustReject = [
  ['../../../etc/passwd', '越界'],
  ['..\\..\\package.json', '反斜杠形式的越界'],
  ['/etc/passwd', '绝对路径'],
  ['C:\\Windows\\win.ini', '带盘符的绝对路径'],
  ['file:app.js', 'scheme'],
  ['\\\\server\\share\\a.png', 'UNC 路径'],
  ['evil.js', '脚本扩展名'],
  ['evil.svg', '⭐ SVG（可内嵌脚本，刻意不放行）'],
  ['big.png', '超 4 MB'],
  ['adir.png', '是目录不是文件'],
  ['nope.png', '文件不存在'],
  ['', '空路径'],
  ['   ', '纯空白'],
]
for (const [p, why] of mustReject) {
  const r = await mod.resolveAssetPath(tmp, p)
  check(`拒绝 ${JSON.stringify(p)}（${why}）`, 'error' in r, JSON.stringify(r))
}

// ⭐ 拒绝理由要**分得开** —— 本项目记过"把多类原因压成一句会让排障靠猜"
const reasonOf = async (p) => {
  const r = await mod.resolveAssetPath(tmp, p)
  return 'error' in r ? r.error : 'OK'
}
const rUp = await reasonOf('../x.png')
const rAbs = await reasonOf('/etc/passwd')
const rExt = await reasonOf('evil.js')
const rMiss = await reasonOf('nope.png')
check('⭐ 越界 / 绝对路径 / 扩展名 / 不存在 四类理由互不相同',
  new Set([rUp, rAbs, rExt, rMiss]).size === 4,
  JSON.stringify([rUp, rAbs, rExt, rMiss]))

await rm(tmp, { recursive: true, force: true })

// ══════════════════════════════════════════════════════════════════════════
// 3. `/asset` 与 `/entry` 的接口契约（走真实 `handleApi`）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n【3】/asset 与 /entry 的接口契约')

const deps = { version: 'test', config: mod.DEFAULT_CONFIG, baseUrl: '', pluginId: 'memj' }
const BASE = '/plugins/dsh-memj/api'
const call = (route, qs = '') => mod.handleApi(deps, 'GET', `${BASE}${route}`, '', new URLSearchParams(qs))

// ⚠️ 用**真实库**里已知的 ext 条目（adapt-memj 的 README，15 张 docs/screenshots 图）。
//    它随插件仓一起走 ⇒ 在任何 checkout 里都在。
const README_ENTRY = 'c2f47e82-ef5f-49fe-adfe-9709728817c7'

const entry = await call('/entry', `id=${README_ENTRY}`)
if (entry.status !== 200) {
  console.log(`  ⚠️ 跳过【3】：库里没有 ${README_ENTRY}（status=${entry.status}）`)
} else {
  check('⭐ /entry 回了 assetBase（前端据此才知道基准）',
    typeof entry.body.assetBase === 'string' && entry.body.assetBase !== '',
    JSON.stringify(entry.body.assetBase))

  const img = await call('/asset', `entry=${README_ENTRY}&path=${encodeURIComponent('docs/screenshots/01-kb.jpg')}`)
  check('⭐⭐ /asset 取到真实图片，且**走 raw 而不是 JSON**', img.raw !== undefined,
    img.raw === undefined ? JSON.stringify(img.body) : '')
  check('⭐ Content-Type 是 image/jpeg', img.raw?.contentType === 'image/jpeg', String(img.raw?.contentType))
  check('⭐ 字节数与磁盘一致',
    img.raw !== undefined && img.raw.bytes.length === 164658, String(img.raw?.bytes.length))
  check('⭐⭐ JPEG 魔数正确（ffd8）—— 证明发出去的真的是图片字节',
    img.raw !== undefined && Buffer.from(img.raw.bytes.slice(0, 2)).toString('hex') === 'ffd8')
  check('⭐ 给了短缓存（不是 no-store —— 否则一屏 15 张每次都重拉）',
    typeof img.raw?.cacheControl === 'string' && !img.raw.cacheControl.includes('no-store'),
    String(img.raw?.cacheControl))

  // ⚠️ **反证**：这个 entry 上取一个 `.js` 必须被拒（证明白名单真的在起作用，
  //    而不是"反正这个条目的目录下没有 .js"）。
  const evil = await call('/asset', `entry=${README_ENTRY}&path=${encodeURIComponent('package.json')}`)
  check('⭐⭐ 同一目录下的 package.json 取不到（白名单真的在生效）',
    evil.raw === undefined && evil.status === 404, JSON.stringify(evil.body))
}

// 参数缺失与未知 id
const noEntry = await call('/asset', 'path=a.png')
check('缺 entry ⇒ 400', noEntry.status === 400, String(noEntry.status))
const badId = await call('/asset', 'entry=deadbeef-0000-4000-8000-000000000000&path=a.png')
check('不存在的 entry ⇒ 404（不是 500）', badId.status === 404, String(badId.status))

// ══════════════════════════════════════════════════════════════════════════
// 4. 前端 `localizeImages`（静态断言 + 行为断言）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n【4】前端 localizeImages')

const appSrc = await readFile(join(here, '..', 'src', 'web', 'app.js'), 'utf8')

check('⭐ renderBody 接受并透传 entryId', /function renderBody\(body, entryId\)/.test(appSrc))
check('⭐⭐ renderBody 在 innerHTML 之后调 localizeImages',
  /linkifyEntryIds\(wrap\)[\s\S]{0,600}localizeImages\(wrap, entryId\)/.test(appSrc))
check('⭐ 用 getAttribute 读原始 src（不能用 img.src —— 那是已解析的绝对 URL）',
  /img\.getAttribute\('src'\)/.test(appSrc))
check('⭐⭐ 绝对地址（含协议相对）必须原样保留',
  /[a-zA-Z]\[a-zA-Z0-9\+\.-\]\*:|\/\/\)/.test(appSrc) || /ABSOLUTE_RE/.test(appSrc))
check('⭐ 知识库详情传了 id', /renderBody\(data\.body \?\? '', id\)/.test(appSrc))
check('⭐ 审批详情传了 entryId', /renderBody\(data\.body \?\? '', n\.entryId\)/.test(appSrc))
check('⭐ 热知识页传了 id', /renderBody\(body, id\)/.test(appSrc))

// 🔴 负向：项目详情**故意不传**（它没有条目 id）—— 这条断言防的是"后人顺手补一个假 id"
check('⭐⭐ 项目详情**不传** entryId（没有条目 id，编一个只会 404）',
  /renderBody\(data\.narrative \?\? ''\)/.test(appSrc))

// 行为断言：剥出函数体，用最小 DOM 桩跑真逻辑
const fnMatch = appSrc.match(/function localizeImages\(root, entryId\) \{[\s\S]*?\n\}/)
check('能从源码里抽出 localizeImages 函数体', fnMatch !== null)
if (fnMatch !== null) {
  const API = `${BASE}`
  // eslint-disable-next-line no-new-func
  const fn = new Function('API', `${fnMatch[0]}; return localizeImages`)(API)
  const makeImg = (src, alt) => {
    const a = new Map()
    if (src !== null) a.set('src', src)
    if (alt !== null) a.set('alt', alt)
    return {
      getAttribute: (n) => (a.has(n) ? a.get(n) : null),
      setAttribute: (n, v) => a.set(n, String(v)),
      _a: a,
    }
  }
  const run = (src, alt, eid = 'EID') => {
    const img = makeImg(src, alt)
    fn({ querySelectorAll: () => [img] }, eid)
    return img
  }

  const rel = run('docs/x.png', '说明')
  check('⭐ 相对路径被改写成 /asset?entry=&path=',
    String(rel._a.get('src')).includes('/asset?entry=EID&path='), String(rel._a.get('src')))
  check('⭐ alt 被提到 title（图裂时悬停能看到原描述）', rel._a.get('title') === '说明')
  check('⭐ 原始 src 留在 data-asset-src（可排查）', rel._a.get('data-asset-src') === 'docs/x.png')

  for (const abs of ['https://cdn/x.png', 'http://a/b.png', 'data:image/png;base64,X', '//cdn/z.png']) {
    check(`绝对地址原样保留：${abs.slice(0, 24)}`, run(abs, '')._a.get('src') === abs)
  }
  check('⭐ entryId 为空 ⇒ 完全不动（不能改成 /asset?entry= 打一堆 400）',
    run('a.png', '', '')._a.get('src') === 'a.png')
}

// ══════════════════════════════════════════════════════════════════════════
// 5. 路由注册（⚠️ 与 test-web-api 的【0】互补：那条测"注册了没"，这条测"真的能走"）
// ══════════════════════════════════════════════════════════════════════════
console.log('\n【5】路由与响应管线')

const idxSrc = await readFile(join(here, '..', 'src', 'index.ts'), 'utf8')
check('⭐ index.ts 注册了 /asset',
  idxSrc.includes('${API_BASE}/asset'))
// 🔴 这一条是本功能独有的坑：raw 分支必须**早于** JSON 分支，
//    否则图片会被 JSON.stringify 成 {"type":"Buffer","data":[…]} —— 200 但打不开。
const rawIdx = idxSrc.indexOf('if (result.raw !== undefined)')
const jsonIdx = idxSrc.indexOf("JSON.stringify(result.body)")
check('⭐⭐ raw 分支排在 JSON 序列化之前（否则图片会变成 Buffer 的 JSON）',
  rawIdx !== -1 && jsonIdx !== -1 && rawIdx < jsonIdx, `raw@${rawIdx} json@${jsonIdx}`)

console.log(`\n═══ 结果：${pass} 通过 / ${fail} 失败 ═══`)
process.exit(fail === 0 ? 0 : 1)
