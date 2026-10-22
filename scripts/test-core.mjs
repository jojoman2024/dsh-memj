// 离线验证核心逻辑（不依赖 DSH 运行时）。
// 用**临时库根**（MEMJ_DATA_DIR）跑通：封面往返、硬校验、读快照、派生层重建。
// 目的：在接工具之前先把"确定性解析 + 落盘 + 聚合"这条链跑实。
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const lib = mkdtempSync(join(tmpdir(), 'memj-test-'))
process.env['MEMJ_DATA_DIR'] = lib

const { DEFAULT_CONFIG } = await import('../lib/offline-bundle.js')
const {
  parseCovers, renderCover, validateCoverShape, isSimilarId, findSimilarIds,
  editDistance, charCount, yamlScalar, splitFrontmatter, stripCovers,
  renderFrontmatter, renderYamlArray,
} = await import('../lib/offline-bundle.js')
const { decideRead, parseSections, extractSection } = await import('../lib/offline-bundle.js')
const { scoreCover, normalizeQuery, filterByContext } = await import('../lib/offline-bundle.js')
const store = await import('../lib/offline-bundle.js')

let pass = 0
let fail = 0
const check = (name, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`) }
  else { fail += 1; console.log(`  ❌ ${name} ${extra}`) }
}

console.log(`库根: ${lib}\n`)

// ─────────────────────────────────────────────────────────────
console.log('【1】封面渲染 ↔ 解析 往返')
const uuid = '3502af2f-797a-435b-933d-8ab873978ee1'
const cover = {
  id: uuid, project: 'dsh-memj', theme: ['thm-a'],
  global: false, kind: '',
  tags: ['构建', '陷阱'],
  // ⭐ `title` 是封面字段（决策 98）——往返测试必须带上它。
  title: 'lib/ 才是真源码',
  desc: '构建或调研 DSH 插件时，关于仓库里 src/ 与 lib/ 两个目录的真实产物关系与陷阱；当要改动旧插件源码时读它。',
  ref: 'entries/lib-is-real-source-3502af2f.md', ext: false,
  // ⭐ 时间（决策 119）——往返测试必须带上，否则解析出来是空串、对不上。
  createdAt: '2026-09-18T00:00:00.000Z',
  updatedAt: '2026-09-18T01:00:00.000Z',
  // ⭐⭐ 归档时间（决策 133）——**空串 = 活跃**；同样是封面字段，往返也必须带上。
  archivedAt: '',
}
const block = renderCover(cover)
const doc = `# HANDOFF — dsh-memj\n\n## 目标\n\nfoo\n\n## 沉淀知识\n\n${block}\n`
const parsed = parseCovers(doc, 'HANDOFF-dsh-memj.md')

// 🔴 **健壮性回归**：调用方若**根本没给 kind 键**（undefined），
//    不能把 `kind: undefined` 写进文档——那会变成一个"非法的 kind 值"。
const noKindKey = { ...cover }
delete noKindKey.kind
check('⭐ 缺 kind 键 ⇒ 不写 kind 行', !renderCover(noKindKey).includes('kind:'))
check('⭐ 缺 kind 键 ⇒ 解析无 issue',
  parseCovers(`x\n${renderCover(noKindKey)}\n`, 'f.md').issues.length === 0,
  JSON.stringify(parseCovers(`x\n${renderCover(noKindKey)}\n`, 'f.md').issues))
check('往返：解析出 1 张封面', parsed.covers.length === 1, JSON.stringify(parsed.issues))
check('往返：字段完全一致', JSON.stringify(parsed.covers[0]?.cover) === JSON.stringify(cover),
  JSON.stringify(parsed.covers[0]?.cover))
check('往返：无 issue', parsed.issues.length === 0, JSON.stringify(parsed.issues))

// ⭐⭐ 决策 133：`archivedAt` **非空**时的往返——空串那条上面已经覆盖了，
//    但"归档"依赖**真值**能写进文档、并被解析回来（只测空串等于没测这个字段）。
{
  const archived = { ...cover, archivedAt: '2026-09-21T03:04:05.000Z' }
  const back = parseCovers(`x\n${renderCover(archived)}\n`, 'f.md').covers[0]?.cover
  check('⭐⭐ 归档时间非空 ⇒ 往返一致', back?.archivedAt === '2026-09-21T03:04:05.000Z',
    JSON.stringify(back?.archivedAt))
  // 🔴 非法值必须在**硬校验**里被拦下（用户要求"仍要硬校验，保持一致"）。
  //    ⚠️ 注入方式：往**合法块**的收尾 `-->` 之前插一行——因为 `renderCover`
  //       对空值**不写 `archivedAt:` 行**（空串 = 活跃），替换空行是找不到东西的。
  const bad = `x\n${renderCover(cover).replace('\n-->', '\narchivedAt: 昨天\n-->')}\n`
  check('⭐ 非法归档时间 ⇒ 记进 issues（不静默吞掉）',
    parseCovers(bad, 'f.md').issues.length > 0,
    JSON.stringify(parseCovers(bad, 'f.md').issues))
}

// ─────────────────────────────────────────────────────────────
console.log('\n【2】desc 里的「: 」不得破坏 YAML（真实场景：Why: xxx）')
const tricky = { ...cover, desc: 'Why: 因为它会坏；How to apply: 总是' }
const p2 = parseCovers(`x\n${renderCover(tricky)}\n`, 'f.md')
check('含 ": " 的 desc 往返正确', p2.covers[0]?.cover.desc === tricky.desc,
  JSON.stringify(p2.covers[0]?.cover.desc))

console.log('\n【3】desc 含行首连字符 / 井号 / 引号')
for (const d of ['- 开头是连字符；当 X 时读它。', '# 井号开头；当 X 时读它。', '含"双引号"与\'单引号\'；当 X 时读它。']) {
  const p = parseCovers(`x\n${renderCover({ ...cover, desc: d })}\n`, 'f.md')
  check(`desc 往返：${d.slice(0, 12)}…`, p.covers[0]?.cover.desc === d, JSON.stringify(p.covers[0]?.cover.desc))
}

// ─────────────────────────────────────────────────────────────
console.log('\n【4】硬校验清单（§3.9.2）')
// ⚠️ 第二个参数是**原始 kind 字符串**——`validateCoverShape` 靠它才能报出
//    "填了非法值"（因为 cover.kind 里非法值已被解析层落成空串，与"没填"无法区分）。
//    这里模拟 `parseCovers` 的调用方式：把传入的 kind 原样当 rawKind。
const bad = (over) => validateCoverShape({ ...cover, ...over }, over.kind ?? '')
check('缺 id ⇒ 报错', bad({ id: '' }).some((s) => s.includes('缺 id')))
check('id 非 UUID ⇒ 报错', bad({ id: 'K-01' }).some((s) => s.includes('UUID')))
check('缺 desc ⇒ 报错', bad({ desc: '' }).some((s) => s.includes('缺 desc')))
check('desc 超 200 ⇒ 报错', bad({ desc: 'x'.repeat(201) }).some((s) => s.includes('超长')))
check('desc 恰 200 ⇒ 通过', bad({ desc: 'x'.repeat(200) }).length === 0)
check('缺 ref ⇒ 报错', bad({ ref: '' }).some((s) => s.includes('缺 ref')))
check('tags 空 ⇒ 报错', bad({ tags: [] }).some((s) => s.includes('tags')))

// ── ⭐ title：封面的必填字段（决策 98）
console.log('\n【4a】⭐ title 必填（决策 98）')
check('缺 title ⇒ 报错', bad({ title: '' }).some((s) => s.includes('缺 title')))
check('title 仅空白 ⇒ 报错', bad({ title: '   ' }).some((s) => s.includes('缺 title')))
check('title 1 字符 ⇒ 报错（过短）', bad({ title: 'x' }).some((s) => s.includes('过短')))
check('title 恰 2 字符 ⇒ 通过', bad({ title: 'ab' }).length === 0)
check('title 恰 48 字符 ⇒ 通过', bad({ title: 'x'.repeat(48) }).length === 0)
check('title 49 字符 ⇒ 报错（超长）', bad({ title: 'x'.repeat(49) }).some((s) => s.includes('超长')))
check('⭐ 中文按字符算（不是字节）：24 个中文字 ⇒ 通过',
  bad({ title: '标题'.repeat(12) }).length === 0, JSON.stringify(bad({ title: '标题'.repeat(12) })))
// ⭐ 往返：title 必须能无损穿过「渲染 → 解析」
const tRound = parseCovers(`x\n${renderCover({ ...cover, title: '带: 冒号 与"引号"的标题' })}\n`, 'f.md')
check('⭐ title 往返正确（含特殊字符）',
  tRound.covers[0]?.cover.title === '带: 冒号 与"引号"的标题',
  JSON.stringify(tRound.covers[0]?.cover.title))
check('title 往返无 issue', tRound.issues.length === 0, JSON.stringify(tRound.issues))
check('⭐ title 出现在渲染出的封面文本里', renderCover(cover).includes('title: lib/ 才是真源码'))

check('三空 ⇒ 报错', bad({ project: '', theme: [], global: false }).some((s) => s.includes('三空')))
check('三空但 global=true ⇒ 通过', bad({ project: '', theme: [], global: true }).length === 0)
check('ext 但 ref 非绝对 ⇒ 报错', bad({ ext: true, ref: 'rel/x.md' }).some((s) => s.includes('绝对路径')))
check('ext 且 ref 绝对 ⇒ 通过', bad({ ext: true, ref: 'D:\\a\\b.md' }).length === 0)

// ── ⭐ kind：受控四值（决策 81）
console.log('\n【4b】kind 受控词表')
check('4 个合法值都通过', ['fact', 'trap', 'howto', 'decision'].every((k) => bad({ kind: k }).length === 0))
check('留空合法（未分类）', bad({ kind: '' }).length === 0)
check('非法值 ⇒ 报错', bad({ kind: 'bug' }).some((s) => s.includes('kind')))
check('非法值报错里列出合法值', bad({ kind: 'bug' }).some((s) => s.includes('fact') && s.includes('decision')))
// YAML 往返：kind 必须能无损穿过「渲染 → 解析」
const kRound = parseCovers(`x\n${renderCover({ ...cover, kind: 'howto' })}\n`, 'f.md')
check('kind 往返正确', kRound.covers[0]?.cover.kind === 'howto', JSON.stringify(kRound.covers[0]?.cover.kind))
check('kind 留空 ⇒ 不写该行', !renderCover({ ...cover, kind: '' }).includes('kind:'))
const kNone = parseCovers(`x\n${renderCover({ ...cover, kind: '' })}\n`, 'f.md')
check('kind 留空 ⇒ 解析为空串', kNone.covers[0]?.cover.kind === '')
// ⚠️ 非法 kind 必须**报错**，而不是被解析层静默落成空串
const badKindDoc = `x\n${renderCover(cover).replace('global:', 'kind: bug\nglobal:')}\n`
const kBad = parseCovers(badKindDoc, 'f.md')
check('⭐ 非法 kind 被报出（不被静默吃掉）', kBad.issues.some((i) => i.reason.includes('kind')),
  JSON.stringify(kBad.issues))

// ─────────────────────────────────────────────────────────────
console.log('\n【5】围栏异常')
const noClose = parseCovers('x\n<!-- memj:entry\nid: a\n', 'f.md')
check('围栏未闭合 ⇒ 报错', noClose.issues.some((i) => i.reason.includes('未闭合')))
const noPair = parseCovers(`x\n<!-- memj:entry\nid: ${uuid}\nproject: p\ntheme: []\nglobal: false\ntags: a\ndesc: d\nref: r\n-->\n`, 'f.md')
check('缺 /memj:entry ⇒ 报错', noPair.issues.some((i) => i.reason.includes('配对')))

// ─────────────────────────────────────────────────────────────
console.log('\n【6】近义 id 判定')
check('互为子串 ⇒ 近义', isSimilarId('dsh-memj', 'dsh_memj', 2))
check('编辑距离 ≤2 ⇒ 近义', isSimilarId('dsh-memj', 'dsh-memji', 2))
check('差异大 ⇒ 不近义', !isSimilarId('dsh-memj', 'power-control', 2))
check('findSimilarIds 命中', findSimilarIds('dsh_memj', ['dsh-memj', 'other'], 2).includes('dsh-memj'))

// ─────────────────────────────────────────────────────────────
console.log('\n【7】读取分流（§4.2）')
const small = '### 标题\n\n**规则**：x\n'
check('短文档 ⇒ full', decideRead(small, { maxChars: 3000 }).mode === 'full')
const big = '### A\n' + 'x'.repeat(4000) + '\n### B\n' + 'y'.repeat(4000)
const dB = decideRead(big, { maxChars: 3000 })
check('超阈且有节 ⇒ section-list', dB.mode === 'section-list')
check('节名清单正确', JSON.stringify(dB.availableSections) === JSON.stringify(['A', 'B']),
  JSON.stringify(dB.availableSections))
const dS = decideRead(big, { section: 'B', maxChars: 3000 })
check('section 命中 ⇒ 返回该节', dS.mode === 'section' && dS.content.includes('yyyy'))
const dMiss = decideRead(big, { section: '不存在', maxChars: 3000 })
check('section 未命中 ⇒ 回节名清单（不报错不回空）',
  dMiss.mode === 'section-miss' && dMiss.availableSections.length === 2)
check('full:true 逃生口 ⇒ 全文', decideRead(big, { full: true, maxChars: 3000 }).content === big)
const noSec = 'x'.repeat(4000)
const dNo = decideRead(noSec, { maxChars: 3000 })
// ⚠️ **断言在 2026-10-22 改过一次**（安全评审 F4）：原来断言的是
//    `mode === 'full'`（即**整篇返回**）—— 那正是缺陷本身：
//    `readFullMaxChars` 对"没有 ## / ### 的正文"完全失效（实测 2,097,161 字符整篇进上下文）。
//    现在的契约是：**只给阈值内的一屏**，并明确指路 `offset`/`limit` 或 `full: true`。
check('超阈但无章节 ⇒ 只给一屏 + 指路（不再是整篇）',
  dNo.mode === 'preview' &&
    dNo.content.length <= 3000 &&
    dNo.notice.includes('无法按节节选') &&
    dNo.notice.includes('offset') &&
    dNo.notice.includes('full: true'))

// ─────────────────────────────────────────────────────────────
console.log('\n【8】检索打分（整词命中）')
const c1 = { ...cover, desc: '构建插件时的陷阱；当构建时读它。', tags: ['构建'] }
const s1 = scoreCover(c1, ['构建'], '构建指南', '')
check('标题+desc+tags 命中累加', s1.score === 5 + 3 + 3, `score=${s1.score}`)
const s2 = scoreCover(c1, ['入缓'], '', '')
check('无意义子串不命中', s2.score === 0)
const s3 = scoreCover(c1, ['构建', '陷阱'], '', '')
// title 传空串：'构建' 命中 desc(+3)+tags(+3)=6；'陷阱' 只命中 desc(+3) ⇒ 共 9
check('多词累加（无标题）', s3.score === 9, `score=${s3.score}`)
const s4 = scoreCover(c1, ['构建', '陷阱'], '构建指南', '')
// 有标题时：'构建' 再 +5 ⇒ 14
check('多词累加（含标题）', s4.score === 14, `score=${s4.score}`)
check('normalizeQuery 去重', JSON.stringify(normalizeQuery(['a', 'a', 'b'])) === JSON.stringify(['a', 'b']))

// ─────────────────────────────────────────────────────────────
console.log('\n【9】落盘 + 派生层重建（真实文件系统）')
await store.ensureLibraryDirs()
const cA0 = { ...cover, id: '11111111-1111-1111-1111-111111111111', project: 'proj-a', theme: ['thm-x'] }
const cB0 = { ...cover, id: '22222222-2222-2222-2222-222222222222', project: 'proj-b', theme: ['thm-x'], global: true }
// ⚠️ 封面上的 `ref` **必须取自 `writeEntryDoc` 的返回值**——那是唯一权威。
// 手写一个 ref 会导致封面指向不存在的文件（本测试先前正是这么错的）。
const cA = { ...cA0, ref: await store.writeEntryDoc(cA0, 'entry-a', '### A\n正文A', { sessionId: 's1' }) }
const cB = { ...cB0, ref: await store.writeEntryDoc(cB0, 'entry-b', '### B\n正文B', { sessionId: 's1' }) }
// ⚠️ `title` 是决策 115 新增的必填字段——夹具必须跟上，
//    否则（在存储层容错之前）会在 `yamlScalar(undefined)` 上崩。
await store.writeProjectDoc('proj-a', { project: 'proj-a', title: '', desc: '项目A描述；当 A 时读它。', themes: [] }, '## 目标\n\nA', [cA])
await store.writeProjectDoc('proj-b', { project: 'proj-b', title: '', desc: '项目B描述；当 B 时读它。', themes: [] }, '## 目标\n\nB', [cB])

const snap = await store.scanLibrary()
check('扫描到 2 个项目', snap.projects.length === 2, JSON.stringify(snap.projects.map((p) => p.id)))
check('扫描到 2 张封面', snap.covers.length === 2, String(snap.covers.length))
check('扫描到主题 thm-x', snap.themeIds.includes('thm-x'), JSON.stringify(snap.themeIds))

const rebuilt = await store.rebuildDerivedLayers()
check('重建：1 个主题', rebuilt.themes === 1, String(rebuilt.themes))
check('THEME 文档已生成', existsSync(join(lib, 'themes', 'THEME-thm-x.md')))
check('GLOBAL 文档已生成', existsSync(join(lib, 'GLOBAL.md')))

const themeText = readFileSync(join(lib, 'themes', 'THEME-thm-x.md'), 'utf8')
check('THEME 列出两个项目（覆盖的项目）',
  themeText.includes('proj-a') && themeText.includes('proj-b'))

const globalText = readFileSync(join(lib, 'GLOBAL.md'), 'utf8')
check('GLOBAL 收录 global:true 的封面', globalText.includes(cB.id))
check('GLOBAL 不含非 global 封面', !globalText.includes(cA.id))

const projA = readFileSync(join(lib, 'projects', 'HANDOFF-proj-a.md'), 'utf8')
check('项目 frontmatter 汇总了 themes:', /themes: \[thm-x\]/.test(projA), projA.split('\n').slice(0, 8).join(' | '))

// ─────────────────────────────────────────────────────────────
console.log('\n【10】读快照（按会话分文件 / 消费 / 只删已消费）')
const snapRec = {
  entryId: cA.id, title: 'A', desc: 'd', theme: ['thm-x'], project: 'proj-a',
  owner: { title: '项目A', desc: '项目A描述' }, readAt: new Date().toISOString(), consumedAt: null,
}
await store.appendReadSnapshot('sess-1', snapRec)
await store.appendReadSnapshot('sess-1', snapRec) // 不去重（决策 66）
const all = await store.readSnapshots('sess-1')
check('不去重：2 条', all.length === 2, String(all.length))
const unconsumed = await store.readUnconsumedSnapshots('sess-1')
check('未消费 = 2 条', unconsumed.length === 2)
const removed = await store.consumeSnapshots('sess-1', 50, 25)
check('未超上限 ⇒ 不删除', removed === 0, String(removed))
const after = await store.readSnapshots('sess-1')
check('消费后 consumedAt 已置', after.every((s) => s.consumedAt !== null))
check('快照文件按会话命名', existsSync(join(lib, 'reads', 'session-sess-1.jsonl')))

// 清理：超上限时只删已消费
for (let i = 0; i < 55; i += 1) await store.appendReadSnapshot('sess-2', snapRec)
const removed2 = await store.consumeSnapshots('sess-2', 50, 25)
check('超上限 ⇒ 删 25 条', removed2 === 25, String(removed2))
check('清理后剩 30 条', (await store.readSnapshots('sess-2')).length === 30,
  String((await store.readSnapshots('sess-2')).length))

// ─────────────────────────────────────────────────────────────
console.log('\n【11】提名：只登记不落位（⭐ 方案 A：提名**不置位**、批准才置位）')
// ⭐⭐ **夹具为什么改成 cA**（2026-09-18，方案 A）：
//    旧夹具用 `cB`（它 `global: true`，模拟"已批准"）去走提名流程，
//    而旧判据是 `global && 不在提名表` ⇒ 加个提名就能让它"变回待批"。
//    **方案 A 下这条路不存在**：`global` 只看事实，提名**不置位**，
//    所以"待批"必须由一条**本来 `global: false`** 的封面来表达。
//    ⇒ 用 `cA`（`global: false`），给它登记提名。
//    ⚠️ 这不是"为了过测试而放宽断言"——恰恰相反：旧的 cB 走法在新语义下
//    **根本表达不出"待批"这个状态**，夹具必须换成能表达它的那条。
await store.writeNominations([])
await store.addNomination({ entryId: cA.id, title: 'A', desc: 'd', project: 'proj-a', nominatedAt: new Date().toISOString() })
const noms = await store.readNominations()
check('提名已登记', noms.length === 1 && noms[0].entryId === cA.id)
// ⭐ 关键新断言：**提名不会把封面上的 global 置位**。
const afterNom = (await store.scanLibrary()).covers.find((c) => c.cover.id === cA.id)?.cover
check('⭐⭐ 提名后封面 `global` 仍为 false（提名不置位）', afterNom?.global === false, String(afterNom?.global))
await store.rebuildDerivedLayers()
const g2 = readFileSync(join(lib, 'GLOBAL.md'), 'utf8')
// 待批的封面不进派生层（它还没生效）。
check('待批提名不进 GLOBAL', !g2.includes(cA.id), '竟然进去了')
// 🔴 派生层只列封面索引，**不掺人侧信息**（决策 42）。
check('GLOBAL 不含"待批准"这类人侧字样', !g2.includes('待批'), '混进了人侧信息')
const okApprove = await store.approveNomination(cA.id)
check('批准成功', okApprove === true)
// ⭐ 关键新断言：**批准的那一刻才置位**。
const afterApprove = (await store.scanLibrary()).covers.find((c) => c.cover.id === cA.id)?.cover
check('⭐⭐ 批准后封面 `global` 已置 true（批准才置位）', afterApprove?.global === true, String(afterApprove?.global))
// ⭐ 且条目正文 frontmatter 也同步了（"两处都写"）。
check('  批准后正文 frontmatter 也同步',
  readFileSync(join(lib, 'entries', `entry-a-${cA.id.slice(0, 8)}.md`), 'utf8').includes('global: true'))
await store.rebuildDerivedLayers()
const g3 = readFileSync(join(lib, 'GLOBAL.md'), 'utf8')
check('批准后进入 GLOBAL', g3.includes(cA.id))

// ─────────────────────────────────────────────────────────────
console.log('\n【12】entry frontmatter 与封面同值（两处都写）')
const entryText = readFileSync(join(lib, 'entries', `entry-a-${cA.id.slice(0, 8)}.md`), 'utf8')
check('frontmatter 含 id', entryText.includes(cA.id))
check('frontmatter 含 theme 数组', /theme: \[thm-x\]/.test(entryText))
check('frontmatter 含 source.sessionId', entryText.includes('sessionId'))

// 就地同步（不改路径）
const before = readdirSync(join(lib, 'entries')).length
await store.syncEntryFrontmatter({ ...cA, desc: '改过的描述' })
const afterSync = readdirSync(join(lib, 'entries')).length
check('syncEntryFrontmatter 不新增文件', before === afterSync, `${before} -> ${afterSync}`)
check('syncEntryFrontmatter 改了 desc',
  readFileSync(join(lib, 'entries', `entry-a-${cA.id.slice(0, 8)}.md`), 'utf8').includes('改过的描述'))

// ─────────────────────────────────────────────────────────────
console.log('\n【12b】frontmatter 嵌套块（source）必须能往返')
// 🔴 回归：曾因 `renderFrontmatter` 一律拼 `${key}: ${value}`，
//    把块头渲染成 `source:: ` ⇒ YAML 解析成字符串 `":"`，
//    于是 sessionId/from **写入成功却读不回来**（静默丢数据）。
const fmText = `${renderFrontmatter([
  ['id', yamlScalar(uuid)],
  ['slug', yamlScalar('x')],
  ['global', 'false'],
  ['source:', ''],
  ['  sessionId', yamlScalar('sess-abc')],
  // ⚠️ 值里含 ` #`（YAML 的注释起始）⇒ `yamlScalar` 必须给它加引号，
  //    否则会被截断。这正是实际写 frontmatter 时的调用方式。
  ['  from', yamlScalar('失败/踩坑 #1')],
])}\n### T\n正文`
check('块头不产生双冒号', !fmText.includes('::'), fmText.split('\n').slice(0, 8).join(' | '))
const fmParsed = splitFrontmatter(fmText)
check('frontmatter 解析无错', fmParsed.error === undefined, String(fmParsed.error))
check('⭐ source 解析成对象', typeof fmParsed.data?.source === 'object' && fmParsed.data?.source !== null,
  JSON.stringify(fmParsed.data?.source))
check('⭐ source.sessionId 读得回来', fmParsed.data?.source?.sessionId === 'sess-abc',
  JSON.stringify(fmParsed.data?.source))
check('source.from 读得回来', fmParsed.data?.source?.from === '失败/踩坑 #1')

// ─────────────────────────────────────────────────────────────
console.log(`\n═══ 结果：通过 ${pass} / 失败 ${fail} ═══`)
rmSync(lib, { recursive: true, force: true })
process.exit(fail === 0 ? 0 : 1)
