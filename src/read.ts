/**
 * 正文读取（方案 §4.2 `memj_read`）。
 *
 * ── ⭐ 核心：按文档大小分流 ────────────────────────────────────────────────
 * ```
 * 不给 section / full：
 *   · size ≤ 3000 字符            ⇒ 返回全文
 *   · size > 3000 且文档有 ##/### ⇒ 返回【节名清单】+ 开头预览 + 提示用 section
 *   · 文档没有 ##/### 章节        ⇒ 返回全文，并 ⚠️ 警告"无法节选"
 * 给 section：
 *   · 命中   ⇒ 返回该节
 *   · 不命中 ⇒ ⭐ 返回【节名清单】让模型重挑（**不报错、不回空**）
 * 给 full: true：
 *   · 无条件返回全文（逃生口）
 * ```
 *
 * ── 🔴 为什么"节名清单"是关键 ──────────────────────────────────────────────
 * 模型想按节读，但**封面里没有章节信息**——形成死循环：
 * "想按节读 ⇒ 得知道节名 ⇒ 取节名只能先读全文 ⇒ 按节读就没意义了"。
 * 让 `memj_read` 在匹配不上时**顺手把节名清单给它**，这个循环就断了，
 * 且**不需要模型预先知道任何事**。清单本身只有几十行标题，比全文小两个数量级。
 *
 * @module dsh-memj/read
 */

import { charCount } from './parse.ts'

/** 一章（`##` 或 `###`）的位置与内容范围。 */
export interface DocSection {
  /** 标题文本（去掉 `#` 与首尾空白）。 */
  title: string
  /** 级别：2 = `##`，3 = `###`。 */
  level: 2 | 3
  /** 该节在行数组里的起始行下标（含标题行）。 */
  startLine: number
  /** 结束行下标（不含）。 */
  endLine: number
}

/**
 * 解析文档里的章节（`##` 与 `###` 都算，§4.2）。
 *
 * ⚠️ **`##` 也要能取到**——外部文档的层级不受我们控制。
 * @param body - 正文。
 * @returns 章节数组（按出现顺序）。
 */
export function parseSections(body: string): DocSection[] {
  const lines = body.split(/\r?\n/)
  const heads: Array<{ title: string; level: 2 | 3; line: number }> = []

  let inFence = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? ''
    // 代码围栏里的 `##` 是内容，不是标题。
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{2,3})\s+(.+?)\s*$/.exec(line)
    if (m !== null) {
      const hashes = m[1] ?? ''
      const title = m[2] ?? ''
      heads.push({ title, level: hashes.length === 2 ? 2 : 3, line: i })
    }
  }

  // ⭐⭐ **节的边界 = 下一个「级别 ≤ 本级」的标题**（决策 134 / 2026-09-20 修）。
  //
  // 🔴 **修前的缺陷（实测）**：这里原本取 `heads[idx + 1]`（**下一个任意级别**标题）
  //    ⇒ 一个"标题下全是 `###` 子节"的 `##` 节，**只拿到标题之后的第一段**，
  //    紧接着被第一个 `###` 截断。
  //    实测本项目：`section:"当前进度"` 只回 **3,766** 字符，而该节实际 **28,750**；
  //    ⚠️ 那 3,766 还是**碰巧**——某个子节标题里恰好含「当前进度」三字、
  //       被子串匹配捞进去了。换个标题就只回两行。
  //    ⇒ ⭐ 后果：长文档**读不出来**，而 `doc` 又要求整节重写 ⇒ **长文档 handoff 走不通**。
  //
  // ⭐ 判据一句话：**`##` 节要包含它下面所有的 `###` 子节**（`endLine` 只看级别 ≤ 本级）。
  return heads.map((h, idx) => {
    let end = lines.length
    for (let k = idx + 1; k < heads.length; k += 1) {
      const nxt = heads[k]
      if (nxt !== undefined && nxt.level <= h.level) {
        end = nxt.line
        break
      }
    }
    return {
      title: h.title,
      level: h.level,
      startLine: h.line,
      endLine: end,
    }
  })
}

/** 节名清单（去重，保持顺序）。 */
export function sectionTitles(sections: readonly DocSection[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const s of sections) {
    if (seen.has(s.title)) continue
    seen.add(s.title)
    out.push(s.title)
  }
  return out
}

/** 一级章节的**分组**（决策 134）：顶层节 + 它下面挂着的子节。 */
export interface SectionGroup {
  /** 顶层节（`##`）。 */
  top: DocSection
  /** 该顶层节下的子节（`###`，按出现顺序）。 */
  children: DocSection[]
  /** ⭐ 顶层节**含子节**的字符数（就是"写它要写多少"）。 */
  chars: number
}

/**
 * 把章节**按顶层节分组**（决策 134）。
 *
 * 🔴 **为什么需要分组**：节清单必须**分两级**返回——
 *    · **顶层节**是**可写单位**（`memj_handoff` 的合并只按 `##` 对号入座）
 *      ⇒ 混在一起列，模型会**挑一个写不进去的节名**；
 *    · **子节**是"**分段读**"的单位——一个 28,750 字符的节，只有按子节读才拿得回来。
 *    ⭐ 两级的角色不同，所以**不能只给一个扁平清单**。
 * @param body - 正文。
 * @param sections - 已解析的章节。
 * @returns 分组数组（顶层节按出现顺序）。
 */
export function groupSections(
  body: string,
  sections: readonly DocSection[],
): SectionGroup[] {
  const lines = body.split(/\r?\n/)
  const out: SectionGroup[] = []
  for (const s of sections) {
    if (s.level === 2) {
      out.push({ top: s, children: [], chars: lines.slice(s.startLine, s.endLine).join('\n').trimEnd().length })
      continue
    }
    // `###` 归到**最近的那个顶层节**下（没有顶层节时丢弃——文档开头就是 `###` 的情况）。
    const last = out[out.length - 1]
    if (last !== undefined) last.children.push(s)
  }
  return out
}

/**
 * 取某一节**在全文行数组里的区间**（决策 134：供"节内分页"定位）。
 * @param sections - 已解析的章节。
 * @param title - 节名（**精确匹配**优先，否则子串匹配）。
 * @returns 命中节的区间；找不到返回 `undefined`。
 */
export function findSectionRange(
  sections: readonly DocSection[],
  title: string,
): DocSection | undefined {
  const exact = sections.find((s) => s.title === title)
  if (exact !== undefined) return exact
  const key = title.trim().toLowerCase()
  return sections.find((s) => s.title.toLowerCase().includes(key))
}

/**
 * 按 `section` 取节（§4.2 的匹配规则）。
 *
 * 规则：**大小写不敏感、去首尾空白、允许子串匹配**（`"四阶段"` 能命中 `"四阶段机制"`）；
 * 多个命中 ⇒ **都返回**。
 *
 * 🔴🔴 **嵌套要剔重**（决策 134 / 2026-09-20）：修了 `parseSections` 的 `endLine` 之后，
 *    `##` 节**包含**它下面的 `###` 子节 ⇒ 若两者都命中，**同一段内容会被返回两遍**。
 *    ⚠️ 实测触发场景：请求 `"当前进度"` 时，
 *    `## 当前进度` 与 `### 第三十八批（…回执每次报「当前进度」体量）`
 *    **两个都命中**（后者是子串巧合）⇒ 不去重就会把该子节输出两遍。
 *    ⭐ 判据：**命中项若被另一个命中项"区间包含"，就丢弃它**（保留外层那个，
 *       因为它才是调用方真正要的整节）。
 * @param body - 正文。
 * @param sections - 已解析的章节。
 * @param requested - 请求的节名。
 * @returns 命中的节文本（拼接）；无命中返回空串。
 */
export function extractSection(
  body: string,
  sections: readonly DocSection[],
  requested: string,
): { text: string; matched: boolean; matchedTitles: string[] } {
  const key = requested.trim().toLowerCase()
  if (key === '') return { text: '', matched: false, matchedTitles: [] }

  const raw = sections.filter((s) => s.title.toLowerCase().includes(key))
  if (raw.length === 0) return { text: '', matched: false, matchedTitles: [] }

  // ⭐ 剔掉"被别的命中项包含"的那些（区间包含判定）。
  const hits = raw.filter((h) =>
    !raw.some((o) => o !== h && o.startLine <= h.startLine && o.endLine >= h.endLine && !(o.startLine === h.startLine && o.endLine === h.endLine)),
  )
  // ⚠️ 完全同区间的重复（理论上不会有）保底：按起始行去重。
  const dedup: DocSection[] = []
  for (const h of hits) if (!dedup.some((d) => d.startLine === h.startLine && d.endLine === h.endLine)) dedup.push(h)

  const lines = body.split(/\r?\n/)
  const parts: string[] = []
  for (const h of dedup) {
    parts.push(lines.slice(h.startLine, h.endLine).join('\n').trimEnd())
  }
  return { text: parts.join('\n\n'), matched: true, matchedTitles: dedup.map((h) => h.title) }
}

/**
 * 取正文开头的预览（超阈时给模型一点上下文，便于判断要不要展开）。
 * @param body - 正文。
 * @param maxChars - 预览的字符上限。
 * @returns 预览文本。
 */
export function preview(body: string, maxChars: number): string {
  const chars = [...body]
  if (chars.length <= maxChars) return body
  return `${chars.slice(0, maxChars).join('')}…`
}

/** `memj_read` 的决策结果。 */
export interface ReadDecision {
  /** 实际返回给模型的正文（可能为空——如"只给节名清单"时）。 */
  content: string
  /** 内容形态，供工具渲染与探针断言。 */
  mode: 'full' | 'preview' | 'section-list' | 'section' | 'section-miss' | 'lines'
  /** 文档全部节名（`section-list` / `section-miss` 时非空）。 */
  availableSections: string[]
  /**
   * ⭐⭐ **分两级的节清单**（决策 134）——**顶层节可写、子节只读定位**。
   *
   * 🔴 为什么要两级：`memj_handoff` 的合并**只按 `##` 对号入座**
   *    ⇒ 把 `###` 和 `##` 混在一个扁平清单里，模型会**挑一个写不进去的节名**。
   * ⚠️ 与 `availableSections` 并存（后者保持原样，供既有消费者/探针用）。
   */
  sectionGroups: Array<{
    /** 顶层节名（可作 `docSection`）。 */
    title: string
    /** 该节**含子节**的字符数（= 写它要写多少）。 */
    chars: number
    /** 子节：`{ title, chars }`（只读定位，可单独 `section` 取）。 */
    children: Array<{ title: string; chars: number }>
  }>
  /** 请求的节名（`section*` 时非空）。 */
  sectionRequested: string
  /** 节是否命中。 */
  sectionMatched: boolean
  /** 正文字符数（始终给出，便于模型感知代价）。 */
  size: number
  /** 给模型的提示语（"怎么拿全文"这类），无则空串。 */
  notice: string
}

/**
 * 决定本次读取返回什么（§4.2 的全部分流规则）。
 *
 * @param body - 全文正文。
 * @param opts - 读取参数。
 * @returns 决策结果。
 */
export function decideRead(
  body: string,
  opts: {
    section?: string | undefined
    full?: boolean | undefined
    offset?: number | undefined
    limit?: number | undefined
    maxChars: number
  },
): ReadDecision {
  const size = charCount(body)
  const sections = parseSections(body)
  const titles = sectionTitles(sections)
  // ⭐⭐ **分两级的节清单**（决策 134）——每个返回分支都要带上它。
  const sectionGroups = groupSections(body, sections).map((g) => ({
    title: g.top.title,
    chars: g.chars,
    children: g.children.map((c) => ({
      title: c.title,
      chars: body.split(/\r?\n/).slice(c.startLine, c.endLine).join('\n').trimEnd().length,
    })),
  }))
  const linesAll = body.split(/\r?\n/)

  // ── 行区间 ──
  //
  // ⭐⭐ **给了 `section` ⇒ 按「节内行号」算**（决策 134 / 2026-09-20）。
  //    🔴 为什么必须这样：一个顶层节可能几万字符（实测「当前进度」28,750），
  //       而 `offset` 原本按**全文行号**算 ⇒ 想读那一节的第 2 段，
  //       得先知道它在全文里的**绝对行号**——调用方根本无从知道。
  //    ⚠️ 没给 `section` 时**保持原行为**（全文行号），不破坏既有用法。
  if (opts.offset !== undefined || opts.limit !== undefined) {
    const sec = opts.section !== undefined && opts.section.trim() !== ''
      ? findSectionRange(sections, opts.section)
      : undefined
    // 节内基准行（含标题行）；没命中节时退回全文（并如实说明）。
    const base = sec === undefined ? 0 : sec.startLine
    const total = sec === undefined ? linesAll.length : sec.endLine - sec.startLine
    const start = base + Math.max(0, (opts.offset ?? 1) - 1)
    const end = opts.limit === undefined
      ? (sec === undefined ? linesAll.length : sec.endLine)
      : Math.min(start + Math.max(0, opts.limit), sec === undefined ? linesAll.length : sec.endLine)
    const slice = linesAll.slice(start, end)
    const where = sec === undefined
      ? `全文第 ${start + 1}–${Math.min(end, linesAll.length)} 行（共 ${linesAll.length} 行）`
      : `节「${sec.title}」内第 ${start - base + 1}–${Math.min(end, sec.endLine) - base} 行（本节共 ${total} 行）`
    return {
      content: slice.join('\n'),
      mode: 'lines',
      availableSections: titles,
      sectionGroups,
      sectionRequested: opts.section ?? '',
      sectionMatched: sec !== undefined,
      size,
      notice: `已按行区间返回：${where}。` +
        (sec === undefined && opts.section !== undefined && opts.section.trim() !== ''
          ? `\n⚠️ 未找到名为「${opts.section}」的节 ⇒ **按全文行号**返回，请核对节名。`
          : ''),
    }
  }

  // ── 指定了 section ──
  if (opts.section !== undefined && opts.section.trim() !== '') {
    const hit = extractSection(body, sections, opts.section)
    if (hit.matched) {
      return {
        content: hit.text,
        mode: 'section',
        availableSections: titles,
        sectionGroups,
        sectionRequested: opts.section,
        sectionMatched: true,
        size,
        notice:
          `已返回节：${hit.matchedTitles.join('、')}（${hit.text.length} 字符）。` +
          (hit.text.length > opts.maxChars
            ? `\n⚠️ 该节 **${hit.text.length} 字符**，超过直出阈值 ${opts.maxChars}。` +
              '若只需要其中一部分，可配合 `offset`/`limit`（**按节内行号**）分段读回。'
            : '') +
          '需要整篇时传 full: true。',
      }
    }
    // ⭐ 匹配不上 ⇒ 回节名清单，**不报错、不回空**（决策 57）。
    return {
      content: '',
      mode: 'section-miss',
      availableSections: titles,
      sectionGroups,
      sectionRequested: opts.section,
      sectionMatched: false,
      size,
      notice:
        titles.length > 0
          ? `未找到名为「${opts.section}」的节。本文可选的节名见 availableSections，请从中重挑一个再调。`
          : '未找到该节，且本文没有 ## / ### 章节，无法按节读取。',
    }
  }

  // ── full: true 逃生口 ⇒ 无条件全文（决策 56）──
  if (opts.full === true) {
    return {
      content: body,
      mode: 'full',
      availableSections: titles,
      sectionGroups,
      sectionRequested: '',
      sectionMatched: false,
      size,
      notice: '',
    }
  }

  // ── 默认：按大小分流 ──
  if (size <= opts.maxChars) {
    return {
      content: body,
      mode: 'full',
      availableSections: titles,
      sectionGroups,
      sectionRequested: '',
      sectionMatched: false,
      size,
      notice: '',
    }
  }

  // 超阈且**没有章节** ⇒ **只给阈值内的一屏**，并**明说怎么继续取**（§11.12 的缓解措施）。
  //
  // 🔴 **2026-10-22 修正（安全评审 F4）**：原先这里 **无条件返回全文** ⇒
  //    `readFullMaxChars`（默认 3000）对"没有 ## / ### 的正文"**完全失效**。
  //    实测：一份 2,097,161 字符的无节正文被**整篇**塞进模型上下文（≈ 60 万 token），
  //    一次读取就能把整个会话的预算打穿 —— 而这个阈值存在的**唯一目的**就是防这件事。
  //    ⚠️ 它还有一层连带影响：无节正文的**来源通常是外部文件引用**（`ext`），
  //    于是"读一个外部大文件"= "一次烧掉几十万 token"，且**没有任何提示**。
  // ⇒ 现在：按行累计到阈值为止，剩下的**按其本来该走的路**取
  //    （`offset`/`limit` 按全文行号 —— 无节也能用；真要通读就显式 `full: true`）。
  if (titles.length === 0) {
    const budget = Math.max(1, opts.maxChars)
    let used = 0
    let end = 0
    for (const line of linesAll) {
      const cost = line.length + 1 // +1 = 换行符
      if (used + cost > budget) break
      used += cost
      end += 1
    }
    // ⚠️ 极端情况：**整篇一行**（没有换行符）⇒ 上面会切出 0 行 ⇒ 退回按字符硬截。
    const content = end === 0
      ? preview(body, Math.max(0, budget - 1))
      : linesAll.slice(0, end).join('\n')
    const what = end === 0
      ? `前 ${content.length} 字符`
      : `前 ${end}/${linesAll.length} 行（${content.length} 字符）`
    return {
      content,
      mode: 'preview',
      availableSections: [],
      sectionGroups: [],
      sectionRequested: '',
      sectionMatched: false,
      size,
      notice:
        `⚠️ 本文 ${size} 字符且没有 ## / ### 章节，**无法按节节选**：本次只返回${what}。` +
        '继续读用 `offset`/`limit`（**按全文行号**）；确实要通读整篇时传 `full: true`。',
    }
  }

  // 超阈且有章节 ⇒ 只给节名清单 + 预览。
  return {
    content: '',
    mode: 'section-list',
    availableSections: titles,
    sectionGroups,
    sectionRequested: '',
    sectionMatched: false,
    size,
    notice:
      `本文 ${size} 字符，超过直出阈值 ${opts.maxChars}，未整篇返回。` +
      '请用 section 指定要哪一节（见 availableSections）；确实要通读整篇时传 full: true。',
  }
}
