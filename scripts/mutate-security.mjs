/**
 * ⭐⭐⭐ **安全评审 F1–F6 的变异自检**（2026-10-22）。
 *
 * ── 它解决的问题：守卫全绿 ≠ 守卫有判别力 ────────────────────────────────────
 * test-security.mjs 的 67 条断言改前是红的、改后是绿的 —— 这只能说明"断言与实现
 * 一致"。**如果断言写歪了**（恒真、只测到一半、把 ok === true 写成 ok !== undefined），
 * 它照样全绿。本项目对这件事的既有口径：**打正确修法必须刚好点红那几条**。
 *
 * ⇒ 本脚本对六条修法各造一个**变异**（把修法退回缺陷形态），逐个：
 *     改源码 → node scripts/build.mjs → node scripts/test-security.mjs → 必须**变红**，
 *     且报红的那几条**正是**该变异对应的断言（不是别处崩了）。
 *     跑完恢复源码 + 重建。
 *
 * ⚠️ 它会**改 src/ 并重建 lib/**，但每一步都成对恢复；硬杀进程时需 git checkout -- src lib。
 *
 * 用法：node scripts/mutate-security.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')

/** 六个变异：find → replace 就是把该条修法**退回 0.1.5 的形态**。 */
const MUTANTS = [
  {
    id: 'M1', fix: 'F1', file: 'src/http-guard.ts',
    what: '去掉 Origin 同源判据（回到"谁的请求都收"）',
    find: "    if (self === '' || originHost !== self) {",
    replace: '    if (false) {',
    mustFail: '跨源',
  },
  {
    id: 'M2', fix: 'F2', file: 'src/inject.ts',
    what: '知识行不做单行消毒（标题里的换行又变成一条假条目）',
    find: '**${oneLine(c.title)}**',
    replace: '**${c.title}**',
    mustFail: '条目行只有 1 条',
  },
  {
    id: 'M3', fix: 'F3', file: 'src/paths.ts',
    what: 'ext 回到"原样使用"（任意绝对路径可读）',
    find: '  return extRoots().some((root) => isInsidePath(raw, root)) ? raw : undefined',
    replace: '  return raw',
    mustFail: '库外',
  },
  {
    id: 'M4', fix: 'F4', file: 'src/read.ts',
    what: '无节超阈回到"整篇返回"（阈值失效）',
    find: "    const content = end === 0\n      ? preview(body, Math.max(0, budget - 1))\n      : linesAll.slice(0, end).join('\\n')",
    replace: '    const content = body // 变异：退回整篇返回',
    mustFail: '不再整篇返回',
  },
  {
    id: 'M5', fix: 'F5', file: 'src/templates.ts',
    what: '删除回到 rm 带 force（不存在的文件也算删成功）',
    find: '      await rm(p)\n',
    replace: '      await rm(p, { force: true })\n',
    mustFail: '不存在',
  },
  {
    id: 'M6', fix: 'F6', file: 'src/untrusted.ts',
    what: '区块边界退化成"只有数据"（没有说明与标记）',
    find: '  return [UNTRUSTED_RULE, UNTRUSTED_BEGIN, ...lines, UNTRUSTED_END]',
    replace: '  return [...lines]',
    mustFail: '边界',
  },
]

/** 跑一条 node 脚本，返回 { code, out }。 */
function run(script, args) {
  const r = spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

/** 把 file 里 find 换成 replace（要求恰好一处，否则当场报错）。 */
function patch(file, find, replace) {
  const p = join(root, file)
  const s = readFileSync(p, 'utf8')
  const n = s.split(find).length - 1
  if (n !== 1) throw new Error('[' + file + '] 期望恰好 1 处命中，实际 ' + n)
  writeFileSync(p, s.replace(find, replace), 'utf8')
  return s
}

let survived = 0
const rows = []
// ⚠️ 备份放在 try 外面：中途抛错时 finally 也要能把它们都恢复回去。
const backups = new Map()

try {
  for (const m of MUTANTS) {
    process.stdout.write('【' + m.id + ' / ' + m.fix + '】' + m.what + ' … ')
    backups.set(m.file, patch(m.file, m.find, m.replace))
    const b = run('scripts/build.mjs', [])
    if (b.code !== 0) throw new Error(m.id + ' 构建失败：' + b.out.slice(-400))
    const t = run('scripts/test-security.mjs', [])
    const mr = t.out.match(/结果：(\d+) 通过 \/ (\d+) 失败/)
    const passed = mr === null ? -1 : Number(mr[1])
    const failed = mr === null ? -1 : Number(mr[2])
    const caught = t.code !== 0 && failed > 0
    const hitExpected = t.out.includes(m.mustFail)
    if (!caught || !hitExpected) survived += 1
    rows.push({ id: m.id, fix: m.fix, caught, hitExpected, passed, failed })
    console.log(caught ? (hitExpected ? '✅ 被抓到（' + failed + ' 条红）' : '⚠️ 红了但不是预期那几条') : '❌ 存活（守卫无判别力）')
    if (!hitExpected) {
      console.log('    期望报红应含「' + m.mustFail + '」，实际红行：')
      console.log(t.out.split('\n').filter((l) => l.includes('❌')).slice(0, 6).map((l) => '      ' + l.trim()).join('\n'))
    }
    // 立刻恢复，下一步的构建才只含"下一个变异"。
    writeFileSync(join(root, m.file), backups.get(m.file), 'utf8')
    backups.delete(m.file)
  }
} finally {
  // 兜底：任何提前退出都把源码恢复原样，并重建一次干净的 lib/。
  for (const [f, s] of backups) writeFileSync(join(root, f), s, 'utf8')
  const b = run('scripts/build.mjs', [])
  console.log('\n（恢复源码并重建 lib/：' + (b.code === 0 ? '成功' : '失败') + '）')
}

console.log('\n═══ 变异自检：' + (MUTANTS.length - survived) + '/' + MUTANTS.length + ' 被抓到 ═══')
for (const r of rows) {
  console.log('  ' + (r.caught ? (r.hitExpected ? '✅' : '⚠️') : '❌') + ' ' + r.id + ' ' + r.fix +
    '　红 ' + r.failed + ' / 绿 ' + r.passed + (r.hitExpected ? '' : '　（未命中预期断言）'))
}
if (survived > 0) process.exitCode = 1
