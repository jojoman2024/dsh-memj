/**
 * ⭐⭐ **热知识的判定与渲染**（热知识方案 §6 / §7）。
 *
 * ── 两件事，都刻意做成**纯函数**（除读库外无副作用）─────────────────────────
 * ① **判定**：这个会话在做哪个项目？（§7）
 * ② **渲染**：把该给的内容拼成一段注入文本（§6）
 *
 * 🔴 **为什么不和 `hot.ts` 合并**：那个模块只管"读写 `hot/` 下的文件"，
 * 这个模块管"**判断给谁、给什么**"——前者的调用方是网页 API，后者是 `pre-step` 钩子。
 * 混在一起会让"网页读设置"与"每步注入"两条路径互相牵连。
 *
 * 🔴 **为什么不和 `inject.ts`（取交接）合并**：那条是**人主动触发的一次性注入**
 * （`followup`，会唤醒模型，末尾要"停下等指令"）；本模块是**每步自动注入的背景知识**
 * （`pre-step` 追加，不唤醒，末尾要"继续当前任务"）。
 * ⚠️ **两者的收尾指令语义相反** ⇒ 共用渲染会写错措辞。
 *
 * @module dsh-memj/hot-inject
 */

import { loadProjectDoc, readDocReads, scanLibrary } from './store.ts'
// ⭐⭐⭐ 安全评审 F2/F6（2026-10-22）：行内消毒 + 不可信区块边界（与 `inject.ts` 同一份）。
import { oneLine, untrustedBlock } from './untrusted.ts'
// ⭐⭐⭐ 提示词运行期覆盖（本次新增）：两条收尾指令走 `promptText` 取值。
import { promptText, registerPromptDefault } from './prompts.ts'
// ⭐⭐⭐ 评分模式（决策 177）：读侧用"有效分前 N 名"替换项目/主题层。
import { topScored, lastRunTurn } from './hot-score.ts'
import { readProjectScore } from './hot-score-store.ts'
import {
  HOT_PROJECT_UNKNOWN,
  type Cover,
  type HotChannel,
  type HotEntrySetting,
  type HotPersonaItem,
  type HotShape,
} from './schema.ts'
import {
  loadEntrySettings,
  loadPersona,
  loadSelections,
  settingOf,
} from './hot.ts'

/**
 * ⭐ **收尾指令**（方案 §6.1）——措辞**逐字取自用户 2026-09-21 的要求**。
 *
 * 🔴 **必须存在**（本项目既有纪律，条目 `ee1034ef`）：注入类文本**不能以内容结尾**，
 * 否则模型会自己猜该干什么 ⇒ 自行动作（写库、改文档、调工具核对）。
 *
 * ⚠️ **与 `inject.ts` 的 `CLOSING_INSTRUCTION` 差别（三点，都别改回去）**：
 * 1. **"继续当前任务"** 而不是"停下等指令"——热知识是**每轮都在的背景**，
 *    注入完就该接着干原来的活；说"停下"会让模型误以为要等指令；
 * 2. ⭐ **"你本身寻求的信息"**（用户原话）——它给了模型一个**主动取正文**的正当理由；
 * 3. ⭐ **禁止客套寒暄**（用户原话）——针对"好的，我已了解背景……"这类纯噪音。
 */
export const HOT_CLOSING_INSTRUCTION: string = `---

⭐ **以上内容已注入完毕——这就够了。**

除非**用户的问题**、或**你本身正在寻求的信息**正好落在上面某条（\`meta\` 形态的）条目上
（那时用 \`memj_read\` 传 \`id\` 取正文），否则**继续当前任务**。

🔴 **禁止额外的客套、寒暄**，以及"我已了解上下文"这类确认性输出。`

/**
 * ⭐⭐ **「正文形态」那一段的收尾**（用户 2026-09-24 逐字给定）。
 *
 * 🔴 **为什么要与上面那条分开**（用户裁定）：
 *   正文形态（画像 + `full` 条目）的内容**已经在模型眼前**，
 *   上面那句"正文按需 `memj_read`"**对它不适用** ⇒ 不该混用同一段收尾。
 *   ⇒ **拆成两段消息、各带各的收尾**（补注时；首次全量仍合成一条，见 `renderHotText`）。
 *
 * ⭐ **措辞是用户原话，别改**：
 *   *"以上是用户要求或者背景知识，但不是任务；结合上述要求或知识继续当前工作。"*
 * ⚠️ 它同时承担两个作用：① 说明这些内容的**性质**（不是任务）；
 *   ② 给出**唯一动作**（继续当前工作）——符合本项目"注入类文本必须有收尾指令"的纪律。
 */
export const HOT_BODY_CLOSING_INSTRUCTION: string =
  '以上是用户要求或者背景知识，但不是任务；结合上述要求或知识继续当前工作。'

// ⭐⭐⭐ **热知识的段头与表头**（2026-10-12 抽成常量 + 走 `promptText`）。
//
// 🔴 **为什么它们也算提示词**：它们**逐字写在注入给模型的那段文本里** ——
//    · 消息头两行**告诉模型"这是什么"**（本次会话相关 / 补充）——
//      ⭐ 尤其"（补充）"这行**有实质语义**：模型据此知道"这不是新的一批、是补发的缺项"；
//    · "直接可用的内容"那行**告诉模型这批条目的形态**（画像 + 正文已在眼前，
//      不需要再去 `memj_read`）—— 与只用 meta 的那两行的语义**正好相反**。
//    ⭐ 判据同 `inject.ts`：**能改变模型怎么做的文本就是提示词**。
// ⚠️ 改它们**不改变注入哪些条目**（那是 `collectHotItems` / `wanted()` 的判据）。
export const HOT_HEAD_FIRST = '## memj 热知识（本次会话相关）'
export const HOT_HEAD_SUPPLEMENT = '## memj 热知识（补充）'
export const HOT_DIRECT_SECTION = '### 直接可用的内容（画像 + 正文形态的知识）'
export const HOT_META_HINT = '⭐ **以下只给标题与描述，正文按需读**——用 `memj_read` 传 `id` 取正文。'

// ⭐⭐⭐ **登记默认值**（本次新增；覆盖优先级与热更新机制见 `prompts.ts`）。
// ⚠️ **这两个收尾的措辞原本是用户逐字给的** —— 页面上允许改，属于用户自己的决定。
registerPromptDefault('hot:closing', HOT_CLOSING_INSTRUCTION)
registerPromptDefault('hot:body-closing', HOT_BODY_CLOSING_INSTRUCTION)
registerPromptDefault('hot:head-first', HOT_HEAD_FIRST)
registerPromptDefault('hot:head-supplement', HOT_HEAD_SUPPLEMENT)
registerPromptDefault('hot:direct-section', HOT_DIRECT_SECTION)
registerPromptDefault('hot:meta-hint', HOT_META_HINT)

/**
 * 一条待注入的条目（渲染层的输入单元）。
 *
 * ⚠️ **`type` 与 `layer` 不是一回事**（页面要分别显示）：
 * · `layer` = 它**从哪来**（全局表 / 本项目 / 所属主题），决定排在注入文本哪一段；
 * · `type`  = 页面上的**类型标签**（画像 / 全局知识 / 主题知识 / 项目知识）。
 * 现在两者一一对应，但画像**没有 cover** ⇒ 它只能是 `type`、没有 `layer`。
 */
export interface HotItem {
  cover: Cover
  /** 该条的设置（已补默认值）。 */
  setting: HotEntrySetting
  /** 它属于哪一层——决定它排在注入文本的哪一段。 */
  layer: 'global' | 'project' | 'theme'
  /**
   * ⭐ **最后置顶时间**（ISO）；**空串 = 未置顶**。
   *
   * 🔴 **为什么不在 `setting` 里**：`setting` 是 `entries.json` 的形状（只管全局知识），
   * 而**置顶是逐项目属性**（存 `selection.json`）⇒ 两者来源不同，硬塞进一个结构
   * 会让"全局层恒为空、项目层才有值"这件事看不出来。
   * ⚠️ 全局层的 `pinnedAt` **恒为空**（全局知识本来就每次都注入，没有排序问题）。
   */
  pinnedAt: string
}

/** 渲染结果：两段分开（`full` 与画像同段，`meta` 各自成组）。 */
export interface HotRenderResult {
  /** 注入文本；**没有任何内容时为空串**（调用方据此决定要不要注入）。 */
  text: string
  /** 统计（供页面与预算用）。 */
  counts: {
    personaFull: number
    entryFull: number
    globalMeta: number
    projectMeta: number
    themeMeta: number
    /** `meta` 形态的总字符数（**只算渲染出来的行**）。 */
    metaChars: number
    /** `full` 形态的总字符数（正文原文）。 */
    fullChars: number
  }
  /**
   * ⭐⭐ **本次真正参与渲染的条目**（供「会话实时状态」页显示）。
   *
   * ⚠️ **这是"打算注入的"**（= 收集 + 过滤 + 渲染的结果），
   * **不是"模型窗口里真的还有的"**——后者要问 `hotState.windows` 的快照。
   * 页面必须把这两件事分开显示（本项目一贯：**不撒谎**）。
   */
  preview: HotPreviewItem[]
  /**
   * ⭐⭐ **补注模式下按形态拆开的两段文本**（用户 2026-09-24 裁定）。
   *
   * - `bodyText` = 画像 + `full` 条目（内容已在眼前）⇒ 收尾是
   *   `HOT_BODY_CLOSING_INSTRUCTION`（"…但不是任务…"）；
   * - `metaText` = 各 meta 组（只给标题描述）⇒ 收尾是 `HOT_CLOSING_INSTRUCTION`
   *   （含"正文按需 `memj_read`"）。
   *
   * ⚠️ **只在 `renderHotText({supplement: true})` 时才有值**；
   *    首次全量注入**不设**它们（那时合成一条 `text`，与改动前逐字一致）。
   * ⚠️ 调用方要**各 push 一条消息**（否则两段收尾又会混在一起，等于没拆）。
   */
  bodyText?: string
  metaText?: string
}

/**
 * ⭐⭐ **一条"本次参与注入"的条目 —— 供页面显示**（会话实时状态页的列表数据源）。
 *
 * 🔴 **为什么要有这个结构**（2026-09-22 用户报告后加）：
 * 原来看门狗只把**封面 id 数组**（`expected: string[]`）交给页面
 * ⇒ 页面列表里**只有一串裸 UUID**：没有标题、看不出类型、看不出形态，
 * 而且**画像根本没有 id** ⇒ 它在列表里**没有位置**（永远看不见）。
 * ⇒ 用户原话："*列表还是需要以可读的列表形式展现……应该要展示出标题、类型
 * （画像、全局知识、主题知识、项目知识），注入形式（正文形态、标题形态），
 * 注入状态（已注入、未注入）*"。
 *
 * ⚠️ **`id` 对画像为空串**：画像没有封面 id ⇒ 用 `fp`（指纹）当它的身份。
 */
export interface HotPreviewItem {
  /** 封面 id；⚠️ **画像为空串**（它没有封面）。 */
  id: string
  /**
   * ⭐ **页面上的类型标签**：`persona`（画像）/ `global`（全局知识）/
   * `project`（项目知识）/ `theme`（主题知识）。
   */
  type: 'persona' | 'global' | 'project' | 'theme'
  /** 标题；⚠️ 画像取正文首行（与「全局热知识」页的画像是同一显示口径）。 */
  title: string
  /** 注入形态：`full`（正文形态）｜ `meta`（标题形态）。 */
  shape: HotShape
  /** 这条的**判定指纹**（封面 id，或画像的文本指纹）——页面用不到，供服务端自己核。 */
  fp: string
}

/**
 * 渲染一行 `meta` 形态的条目（**与 `inject.ts` 的 `renderKnowledgeLine` 同形**）。
 *
 * ⚠️ **行里本来就带完整 id** ⇒ 看门狗**不需要额外字符成本**就能做指纹（方案 §6.2）。
 * @param c - 封面。
 * @returns markdown 行。
 */
export function renderMetaLine(c: Cover): string {
  // 🔴 **`oneLine()` 是边界，不是修饰**（安全评审 F2）：格式**按行**表达"一条知识"，
  //    标题/描述里一个 `\n` 就能伪造出一条完整合法的条目。
  const kind = c.kind === '' ? '' : ` [${oneLine(c.kind)}]`
  const ext = c.ext ? '（外部引用）' : ''
  return `- \`${oneLine(c.id)}\`${kind} **${oneLine(c.title)}**${ext} — ${oneLine(c.desc)}`
}

/**
 * ⭐⭐ **画像的"指纹"**——用来判断它在不在窗口里。
 *
 * 🔴🔴 **为什么画像需要它**：看门狗（`idsInWindow`）按**封面 id** 判定，
 * 而**画像没有封面 id**（它是 `persona.json` 里的人编内容，注入时**原样**拼接、
 * 不带任何 id 前缀）⇒ 它**永远检测不到**，在页面上永远显示"未注入"。
 *
 * 🔴 **还有一个更严重的连带后果**（本函数同时修掉它）：
 * `decideInjection` 算的是 `missing = expected − present`，而 `expected` **只有封面 id**
 * ⇒ **只有画像、没有封面条目时 `missing` 恒为空** ⇒ 判定成"一条不缺" ⇒
 * **一个字都不注入**（画像被静默丢掉）。
 * ⇒ 把画像指纹并入 `expected` / `present` 同一集合后，
 * "画像变了但封面条目都在"这种情况也能被正确补注。
 *
 * ⚠️ **取前 60 字符**：够长到不会偶然撞上，又短到不受后续编辑影响。
 *
 * 🔴🔴 **阈值是 8 而不是 20**（实测修正）：生产库里用户的画像是
 * **「思考过程和回答使用中文。」（13 字符）** —— 按 20 的阈值它**没有指纹**
 * ⇒ 它在列表里永远显示"未注入"（而它其实每轮都在注入）⇒ **界面在撒谎**。
 * ⭐ 判据：**阈值要按"真实用户会写多短"定，不是按"我觉得多长才安全"定**。
 * ⚠️ 8 字符的中文整句（如"思考过程和回答使用中文。"）在任何消息里偶然重现
 * 的概率极低 ⇒ 不会造成假绿；而**假红的代价只是多注入一次**（可接受）。
 *
 * ⚠️ **取舍的方向**：宁可口径偏"严"（判成未注入 ⇒ 多补一次），
 * 也不能偏"松"（判成已注入 ⇒ **该注入的没注入**，用户看不到任何提示）。
 * @param text - 画像正文。
 * @returns 指纹串（不参与判定时返回空串）。
 */
export function personaFingerprint(text: string): string {
  const t = text.trim()
  return t.length < 8 ? '' : t.slice(0, 60)
}

/**
 * ⭐⭐ 把"画像 + 正文形态条目 + 三组 meta 条目"拼成一段注入文本（方案 §6.1）。
 *
 * 🔴 **分段规则**（用户要求，别改）：
 * - **画像**与**`shape: 'full'` 的条目**合并成**第一段「直接可用的内容」——
 *   两者都是"**内容现在就在模型眼前、不需要 read**"；
 * - 其余按 **全局 → 项目 → 主题** 三组，每组带表头。
 *
 * ⚠️ **纯函数**：`full` 条目的正文由调用方通过 `bodies` 传入
 * （本函数**不做 I/O** ⇒ 可单测；读正文在 `buildHotInjection`）。
 * ⚠️ **空段不输出**（不写"（无）"占位——那只是噪音）。
 * @param persona - 全部画像条目（**本函数自己按 `on` 过滤**）。
 * @param items - 待注入的条目（已按层分组，见 `collectHotItems`）。
 * @param bodies - `entryId → 正文`；缺失的 `full` 条目**降级成 meta 行**
 *   （⚠️ **不静默丢弃**：宁可少给形态，也不能让模型以为它拿到了正文）。
 * @returns 渲染结果；**全空时 `text` 为空串**。
 */
export function renderHotText(
  persona: readonly HotPersonaItem[],
  items: readonly HotItem[],
  bodies: ReadonlyMap<string, string> = new Map(),
  opts: {
    /**
     * ⭐⭐ **只渲染指纹在这个集合里的条目**（省略 = 全部）。
     *
     * 🔴 **为什么需要它**（用户 2026-09-24 报的 bug）：补注时**只该发缺的那几条**，
     *    而本函数原来**只有"渲染全部"一种模式** ⇒ `decideInjection` 算出了 `missing`
     *    却只能发全量 `text` ⇒ **每次补注都变成全量重注入**（实测：只缺 1 条也重发 4271 字符）。
     * ⚠️ **判据用指纹**（封面 id / 画像文本指纹），与看门狗、重建**同一套**（实现只留一份）。
     */
    only?: ReadonlySet<string>
    /**
     * ⭐ **补注模式**：标题用「补充」措辞、且**分形态返回两段**（各带各的收尾）。
     * 省略 = 首次全量注入（合并成一条，行为与改动前**逐字一致**）。
     */
    supplement?: boolean
  } = {},
): HotRenderResult {
  const only = opts.only
  /** ⚠️ 统一的"这条要不要渲染"判据（三处循环共用，避免各写一份）。 */
  const wanted = (fp: string): boolean => only === undefined || (fp !== '' && only.has(fp))
  const counts: HotRenderResult['counts'] = {
    personaFull: 0, entryFull: 0, globalMeta: 0, projectMeta: 0, themeMeta: 0,
    metaChars: 0, fullChars: 0,
  }
  /** ⭐ 本次**真正参与渲染**的条目（供页面显示；见 `HotPreviewItem`）。 */
  const preview: HotPreviewItem[] = []

  /** 第一段的行（画像正文 + `full` 条目的带 id 标题与正文）。 */
  const direct: string[] = []
  for (const p of persona) {
    if (!p.on || p.text.trim() === '') continue
    // ⚠️ 画像的身份是**它的文本指纹**（它没有封面 id）——子集过滤必须用它。
    if (!wanted(personaFingerprint(p.text))) continue
    counts.personaFull += 1
    counts.fullChars += p.text.length
    direct.push(p.text.trim())
    preview.push({
      // ⚠️ 画像没有封面 id ⇒ 用指纹当身份（`fp`）；`id` 留空。
      id: '',
      type: 'persona',
      title: firstLine(p.text),
      // ⚠️ 画像**恒为正文形态**（它整段原样注入）——与「全局热知识」页的口径一致。
      shape: 'full',
      fp: personaFingerprint(p.text),
    })
  }
  /** ⚠️ 正文缺失的 `full` 条目 ⇒ 退回 meta 组（见 `renderableItems`）。 */
  const fallbackMeta: HotItem[] = []
  for (const it of items) {
    if (it.setting.shape !== 'full') continue
    // ⚠️ **子集过滤要在"降级判断"之前**：不参与本次注入的条目连正文都不该被算进统计。
    if (!wanted(it.cover.id)) continue
    const body = bodies.get(it.cover.id)
    if (body === undefined || body.trim() === '') {
      fallbackMeta.push({ ...it, setting: { ...it.setting, shape: 'meta' } })
      continue
    }
    counts.entryFull += 1
    counts.fullChars += body.length
    // ⭐ **保留 id**——用户明确要求（看门狗要按 id 判断这条还在不在窗口）。
    direct.push(`#### \`${it.cover.id}\` ${it.cover.title}`, '', body.trim())
    preview.push({
      id: it.cover.id, type: it.layer, title: it.cover.title,
      shape: 'full', fp: it.cover.id,
    })
  }
  const all = fallbackMeta.length === 0 ? items : [...items, ...fallbackMeta]

  const groups: Array<{ title: string; layer: HotItem['layer']; key: keyof HotRenderResult['counts'] }> = [
    { title: '全局知识', layer: 'global', key: 'globalMeta' },
    { title: '项目知识', layer: 'project', key: 'projectMeta' },
    { title: '所属主题的知识', layer: 'theme', key: 'themeMeta' },
  ]

  const parts: string[] = []
  /** ⭐ meta 段的行（**单独攒**，好让补注时分成两条消息、各带各的收尾）。 */
  const metaParts: string[] = []
  if (direct.length > 0) {
    parts.push(promptText('hot:direct-section', HOT_DIRECT_SECTION), '')
    parts.push(...direct)
  }
  for (const g of groups) {
    // ⚠️ **子集过滤**：补注时只渲染缺的那些（`wanted` 与上面两处同一判据）。
    const rows = all.filter(
      (it) => it.setting.shape === 'meta' && it.layer === g.layer && wanted(it.cover.id),
    )
    if (rows.length === 0) continue
    counts[g.key] = rows.length
    metaParts.push('', `### ${g.title}（${rows.length} 条）`, '')
    metaParts.push(promptText('hot:meta-hint', HOT_META_HINT), '')
    for (const it of rows) {
      metaParts.push(renderMetaLine(it.cover))
      preview.push({
        id: it.cover.id, type: it.layer, title: it.cover.title,
        shape: 'meta', fp: it.cover.id,
      })
    }
  }

  // `meta` 字符数：只算行本身（不含表头），用于预算估算。
  // ⚠️ **必须按子集算**（用 `wanted` 过滤）—— 否则补注时的统计会把"没发出去的"也算进去。
  counts.metaChars = all
    .filter((it) => it.setting.shape === 'meta' && wanted(it.cover.id))
    .reduce((n, it) => n + renderMetaLine(it.cover).length, 0)

  // ⭐⭐⭐ **首次全量注入**：合成一条（**与改动前逐字一致** —— 不动已验证过的路径）。
  if (opts.supplement !== true) {
    const both = metaParts.length === 0 ? parts : [...parts, ...metaParts]
    if (both.length === 0) return { text: '', counts, preview }
    // ⭐⭐⭐ **安全评审 F6**：条目行与画像/正文都来自库 ⇒ 整段包进不可信区块。
    //     ⚠️ 我们自己写的表头与收尾指令**留在区块外** —— 它们是"怎么对待这批数据"的说明，
    //        不是数据本身（放进去会读成"数据在命令模型"）。
    const text = [promptText('hot:head-first', HOT_HEAD_FIRST), '', ...untrustedBlock(both), '', promptText('hot:closing', HOT_CLOSING_INSTRUCTION)].join('\n')
    return { text, counts, preview }
  }

  // ⭐⭐⭐ **补注**：**分形态两段，各带各的收尾**（用户 2026-09-24 裁定）。
  //
  // 🔴 **为什么要分两条**：两种形态的收尾语义不同 ——
  //    · 正文形态（画像 + full）内容**已在眼前** ⇒ 用 `HOT_BODY_CLOSING_INSTRUCTION`；
  //    · meta 形态只给标题描述 ⇒ 才需要"正文按需 `memj_read`"那句。
  //    原来两者拼在**同一条消息**、只有**一段收尾** ⇒ 分不开。
  // ⚠️ **标题也要区分**（用户裁定）：补注用「（补充）」，
  //    免得模型以为"又来了一整批新的"（首次那行**一个字不动**）。
  const head = promptText('hot:head-supplement', HOT_HEAD_SUPPLEMENT)
  const bodyText = parts.length === 0
    ? ''
    : [head, '', ...untrustedBlock(parts), '', promptText('hot:body-closing', HOT_BODY_CLOSING_INSTRUCTION)].join('\n')
  const metaText = metaParts.length === 0
    ? ''
    : [head, '', ...untrustedBlock(metaParts), '', promptText('hot:closing', HOT_CLOSING_INSTRUCTION)].join('\n')
  return { text: bodyText === '' ? metaText : bodyText, counts, preview, bodyText, metaText }
}

/** 取一段文本的**首行**（画像的显示标题；空文本返回 `(空)`）。 */
function firstLine(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? ''
  return line === '' ? '(空)' : line.slice(0, 80)
}

/**
 * ⭐ **收集"本次该注入哪些条目"**（判定 → 取条目 → 过滤 → 排序）。
 *
 * 分层规则（方案 §3.1，**累加**）：
 * - **全局**：封面 `global === true`（已批准）；
 * - **项目**：封面 `project === 该项目` **且在项目清单里**；
 * - **主题**：该项目文档 `themes:` 下**其它项目**的封面 **且在项目清单里**
 *   ⚠️ **要去重**（同一张可能既属本项目又挂本项目主题 ⇒ 只出一次）。
 *
 * 🔴🔴 **2026-09-22 改（用户裁定）—— 三层的"开关"不再一样**：
 *
 * | 层 | 纳入判据 | 形态 / 置顶从哪来 |
 * |---|---|---|
 * | **全局** | `entries.json` 的 `on`（**缺省纳入**） | 同一个 `entries.json`（全局只有一份，合理） |
 * | **项目 / 主题** | ⭐ **在项目清单里 = 纳入**（**没有第二道 `on`**） | ⭐ **`selection.json` 的 `entries[i]`**（逐项目） |
 *
 * ⚠️ **为什么项目/主题层不再看 `entries.json`**：旧设计里它们是"在清单里 ∧ `on`"
 * 两道**串行**开关，而 `on` 缺省 `false` ⇒ 实测**选中 11 条、注入 0 条**；
 * 且 `on` 的入口在**另一个子页**（「全局热知识」）还叫"纳入" ⇒ 用户**无从察觉**。
 * ⇒ 现在"在清单里 = 会注入"，**界面上所见即所得**。
 *
 * ⚠️ **还有一道过滤**：必须**不是** `kind: 'history'`
 * （它不参与任何面向模型的展示）—— `scanLibrary()` 默认已排除，天然成立。
 *
 * ⚠️⚠️ **2026-10-13 起多第二道：不是 `kind: 'chat'`** —— ⭐ 但它与 `history`
 * **走的路不同，别混**：
 *   · `history` ⇒ `scanLibrary()` 默认排除（**列表也不要它**）；
 *   · `chat`   ⇒ **列表要它**（用户裁定「chat 出现在知识库列表里」）
 *     ⇒ `scanLibrary()` **不能**排除 ⇒ 只能由**本函数在入口过滤**（`snapshotForModel`）。
 * 🔴 判据：**"进列表"与"进模型上下文"是两条路** ——
 *    想排除某类条目时，先问"列表要不要它"，再决定改哪一处；
 *    改错一处 ⇒ 要么列表点不开（改 `scanLibrary`），要么模型看到会话流水（不改这里）。
 *
 * ⚠️ **排序**：置顶优先（按 `pinnedAt` 倒序），其余保持清单原顺序。
 * @param projectId - 该会话判定的项目（`未知` 时只收全局层）。
 * @returns 待注入条目（未渲染）。
 */
/**
 * ⭐⭐ **评分模式的读取选项**（决策 177 / 182）。
 *
 * 🔴 **为什么做成一个具名类型、四处共用**：它在 `buildHotInjection` /
 *    `decideInjection` / `previewForSession` / `api.ts` **四处**出现 ——
 *    ⚠️ 各写一份必然漂移（本项目已因"同一份判据多份实现"出过多次事故，
 *    最近一次就是这四处**忘了传 `score`**，见决策 181）。
 * @property on - 是否启用评分模式（`true` ⇒ 项目/主题层换成"有效分前 N 名"）。
 * @property windowHours - 滚动窗口小时数。
 * @property topN - 取前几名。
 * @property gate - ⭐ 是否启用入围门槛（决策 182）；省略 = 不设门槛。
 * @property gateMinScore - 分数门槛。
 * @property gateLastTurn - 是否放行"上一轮刚加入的"（`false` ⇒ 纯分数门槛）。
 */
export interface ScoreReadOpts {
  on: boolean
  windowHours: number
  topN: number
  gate?: boolean
  gateMinScore?: number
  gateLastTurn?: boolean
}

/**
 * ⭐ **本项目声明的主题集合**（用于评分模式的归属校验）。
 *
 * ⚠️ 与 `collectHotItems` 里主题层用的是**同一个来源**（`loadProjectDoc` 的 `themes:`），
 *    不另读一份 —— 否则两处判据会漂移。
 * @param projectId - 项目 id。
 * @returns 主题 id 集合（读不到时为空集）。
 */
async function projectThemeSet(projectId: string): Promise<Set<string>> {
  try {
    const doc = await loadProjectDoc(projectId)
    return new Set((doc?.frontmatter.themes ?? []).filter((t) => t !== ''))
  } catch {
    return new Set()
  }
}

export async function collectHotItems(
  projectId: string,
  /**
   * ⭐ 评分模式的配置（决策 177）。
   *
   * ⚠️ **可选**：不传 ⇒ 走**原清单路径**（保持所有既有调用点/测试不变）。
   *    ⭐ 这与本项目"新增可选项不要改所有调用点"的做法一致；
   *    而 `pre-step` 那条真实路径**会传**（见 `hot-watch.ts`）。
   */
  scoreOpts?: ScoreReadOpts,
): Promise<HotItem[]> {
  // ⚠️ `scanLibrary()` 默认**不含 history、不含归档** ⇒ 正合要求。
  //
  // ⭐⭐ **2026-10-13（「文档内提问」）：注入侧排除 `chat`。**
  //
  //    🔴 **为什么在这里做、而不是改 `scanLibrary` 的默认值**：
  //       `chat` **要出现在知识库列表里**（用户裁定）⇒ 它必须过 `scanLibrary`；
  //       而它是**会话流水**，不是可供复用的知识 ⇒ **不能进模型上下文**。
  //       ⇒ ⭐ 判据：**列表/读侧含它，检索/注入侧排除它** ——
  //         两条路各改一处，别互相下手（改 `scanLibrary` 会让列表点不开那些条目）。
  //    ⚠️ 在**入口**一次过滤 ⇒ 全局层 / 项目层 / 主题层 / 评分层**四条路径全覆盖**，
  //       不会漏掉评分模式那条（它另有一个 `byId` 查表路径）。
  const snapshot = await scanLibrary()
  const snapshotForModel = {
    ...snapshot,
    covers: snapshot.covers.filter((c) => c.cover.kind !== 'chat'),
  }
  const settings = await loadEntrySettings()
  const selections = await loadSelections()
  const known = projectId !== HOT_PROJECT_UNKNOWN && projectId !== ''

  /** 本项目清单：`封面 id → 该条在清单里的设置`（形状 `shape` / `pinnedAt`）。 */
  const selEntries = new Map<string, { shape: HotShape; pinnedAt: string }>()
  if (known) {
    for (const e of selections[projectId]?.entries ?? []) {
      selEntries.set(e.id, { shape: e.shape, pinnedAt: e.pinnedAt })
    }
  }
  const out: HotItem[] = []

  // ── 全局层（**不需要被选中**：它天然对所有会话生效）──
  //    ⚠️ **缺省纳入**（用户原话："global 为 true 的知识条目，应该是所有主题都会注入的"）。
  for (const { cover } of snapshotForModel.covers) {
    if (!cover.global) continue
    const st = settingOf(settings, cover.id, 'global')
    if (!st.on) continue
    // ⚠️ 全局层**用 `entries.json` 的 shape**（它本来就是全局的，只有一个值是对的）；
    //    `pinnedAt` 恒为空——置顶只对项目热知识有意义（全局本来就都注入）。
    out.push({ cover, setting: st, layer: 'global', pinnedAt: '' })
  }

  if (known) {
    // ⭐⭐⭐ **评分模式：用"有效分前 N 名"替换【项目层 + 主题层】**（决策 177）
    //
    // 用户裁定（原话）：*"打开开关时替换（不替换全局知识，如果这个所选的清单里有全局知识，记得去重）"*
    //   · ✅ **全局层不动**（上面已经收完）；
    //   · ✅ **项目层与主题层** ⇒ 换成"该项目的有效分前 N 名"；
    //   · 🔴 **去重**：评分层**并入同一个 `shown`**（下面第 2 步用它），
    //        而不是另写一份去重 —— 那正是决策 147/148 那个坑的形态。
    //
    // ⚠️ **替换后项目热知识可能"突然变空"**（分数还没积累）—— 用户明确裁定
    //    *"不用过渡"* ⇒ 这是**设计内行为**，不是 bug。
    if (scoreOpts?.on === true) {
      const proj = await readProjectScore(projectId)
      const rankings = topScored(
        proj,
        Date.now(),
        scoreOpts.windowHours,
        scoreOpts.topN,
        // ⭐⭐⭐ **入围门槛**（决策 182）：**分数 ≥ N 或 上一轮刚加入的**。
        //    🔴 生成门槛**必须在调用处算好 `lastRunTurn`**（它是项目级的，
        //       `topScored` 只看单条的事件，推不出来 —— 见 `lastRunTurn` 的注释）。
        //    ⚠️ `gate` 为 `undefined` ⇒ 退回旧行为（纯按分数取前 N）。
        scoreOpts.gate === true
          ? {
            gate: {
              minScore: scoreOpts.gateMinScore ?? 1,
              // ⚠️ `gateLastTurn === false` ⇒ 传 `-1` ⇒ 那道门**不生效**（`topScored`
              //    只在 `lastTurn >= 0` 时才用它）⇒ 退回"纯分数门槛"。
              lastTurn: scoreOpts.gateLastTurn === false ? -1 : lastRunTurn(proj),
            },
          }
          : undefined,
      )
      // ⭐ 用 `id → cover` 查表（`rankings` 已按分数降序 ⇒ 注入顺序也可读）。
      const shownScored = new Set(out.map((it) => it.cover.id))
      // ⚠️ 查表也用**已排除 chat 的那份**——否则"chat 条目分数很高"时会被这里收进去。
      const byId = new Map(snapshotForModel.covers.map((c) => [c.cover.id, c.cover]))
      // ⭐ 本项目主题（用于归属校验；为空时不必查）。
      const themeAllows = await projectThemeSet(projectId)
      for (const r of rankings) {
        // 🔴 **去重**：跳过已被全局层收过的（这正是用户特别点出的那条）。
        if (shownScored.has(r.id)) continue
        const cover = byId.get(r.id)
        // ⚠️ 条目可能已被删/归档 ⇒ 打分表里还留着它 ⇒ **静默跳过**
        //    （`scanLibrary()` 已排除删掉/归档的，所以查不到就是那个原因）。
        if (cover === undefined) continue
        // ⚠️ 归属校验：只收**本项目**或**本项目主题下**的条目 ——
        //    分数表按项目存，理论上不会串，但读时再核一次比"信任写入"便宜。
        if (cover.project !== projectId && !cover.theme.some((t) => themeAllows.has(t))) continue
        shownScored.add(r.id)
        out.push({
          cover,
          // ⭐ 形态用**该条在清单里的设置**（若在）；不在清单里的用 `meta` ——
          //    ⚠️ 评分模式的意义正是"注入**不在清单里但很该给**的知识"，
          //       所以"不在清单里"是**常态**，不能因此跳过。
          //    ⭐ `meta` = 只给标题+描述（不带正文）—— **默认形态**，
          //       因为评分只证明"这条对项目有用"，**没证明"该读全文"**。
          setting: {
            on: true,
            channel: 'inbox',
            shape: selEntries.get(r.id)?.shape ?? 'meta',
          },
          layer: 'project',
          // ⚠️ 评分模式**不继承置顶**（置顶是"手选清单"的语义；这一档是"算出来的"）。
          pinnedAt: '',
        })
      }
      // ⭐ **评分模式到此为止**：项目层与主题层都被替换掉了 ⇒ 不再走下面的清单收集。
      return out
    }

    // ── 项目层（⭐ **在清单里 = 纳入**，没有第二道开关）──
    //
    // 🔴🔴 **必须排除"已被全局层收过的"**（2026-09-24 用户实测发现的重复注入）：
    //    一条 `global: true` 的知识**也可能出现在项目清单里**（用户手工加过、或历史残留），
    //    而全局层是**无条件**收的 ⇒ 不去重就会**被收两次**
    //    （一次作 `global`、一次作 `project`）。
    //    ⚠️ **危害不只是"左栏显示重复"**：实测**渲染出的注入文本里同一行出现两遍**
    //      （`### 全局知识` 与 `### 项目知识` 各一次）⇒ 模型每轮都看到两遍同一条，
    //      **白烧 token**，且看起来像两件不同的事。
    //    ⭐ 用户的原话点出了判据：*"全局知识是不应该在项目热知识的可选列表里的（左栏）。
    //      因为他一定已经在本来就要注入的全局热知识里了。"*
    //    ⚠️ **顺序很重要**：`shown` 必须在**全局层收完之后**建 —— 全局层优先，
    //      项目/主题层让位（全局的形态由 `entries.json` 决定，那是它对全局层的正当来源）。
    const shown = new Set(out.map((it) => it.cover.id))
    for (const { cover } of snapshotForModel.covers) {
      if (cover.project !== projectId) continue
      if (shown.has(cover.id)) continue
      const sel = selEntries.get(cover.id)
      if (sel === undefined) continue
      out.push({
        cover,
        setting: {
          on: true,
          // ⚠️ `channel` 恒 `inbox`：项目/主题层**不允许 `section`**（方案 §3.2 的机制约束）。
          channel: 'inbox',
          shape: sel.shape,
        },
        layer: 'project',
        pinnedAt: sel.pinnedAt,
      })
    }
    // ── 主题层（去重：排除已在项目层出现过的）──
    const doc = await loadProjectDoc(projectId)
    const themeIds = [...new Set(doc?.frontmatter.themes ?? [])].filter((t) => t !== '')
    if (themeIds.length > 0) {
      // ⚠️ 重建 `shown`：它要包含**前两层**已收的全部（全局 + 项目）。
      const shown2 = new Set(out.map((it) => it.cover.id))
      for (const { cover } of snapshotForModel.covers) {
        if (cover.theme.some((t) => themeIds.includes(t)) && !shown2.has(cover.id)) {
          const sel = selEntries.get(cover.id)
          if (sel === undefined) continue
          out.push({
            cover,
            setting: { on: true, channel: 'inbox', shape: sel.shape },
            layer: 'theme',
            pinnedAt: sel.pinnedAt,
          })
          shown.add(cover.id)
        }
      }
    }
  }

  // ── 排序：置顶优先（`pinnedAt` 倒序），其余保持原顺序 ──
  //    ⚠️ `pinnedAt` 在 `HotItem` 上（不是 `setting` 里）——它是逐项目属性，见那里的注释。
  const pinned = out.filter((it) => it.pinnedAt !== '')
    .sort((a, b) => b.pinnedAt.localeCompare(a.pinnedAt))
  const rest = out.filter((it) => it.pinnedAt === '')
  return [...pinned, ...rest]
}

/**
 * ⭐⭐ **判定"这个会话在做哪个项目"**（方案 §7.2）。
 *
 * 🔴 **只用 `doc-reads`，绝不用 `reads`**（用户明确要求，且机制上更正确）：
 * `reads` 记的是"读过某条**知识**"，而知识**可以跨项目复用**（那正是主题存在的理由）
 * ⇒ 用它判定会把"A 读了 B 的知识"**误判成"在做 B"**。
 * `doc-reads` 记的是"读过某个**项目文档**"，**没有跨项目复用这一说** ⇒ 信号干净。
 *
 * ⚠️ **"最新一条"是刻意的**（不是"最多数"）：用户会中途换项目，
 * **最近读的最能代表"现在在做什么"**。
 * @param sessionId - 会话 id。
 * @param knownProjects - 当前库里的活跃项目 id（用来排除已删/已归档的）。
 * @returns 项目 id；判不出时返回 `HOT_PROJECT_UNKNOWN`（**一等公民**，不抛错）。
 */
export async function detectProjectByDocReads(
  sessionId: string,
  knownProjects: readonly string[],
): Promise<{ project: string; at: string }> {
  const reads = await readDocReads(sessionId)
  if (reads.length === 0) return { project: HOT_PROJECT_UNKNOWN, at: '' }
  // ⚠️ 按 `readAt` 倒序取最新（**不假设文件本身有序**——它是追加写的，但可能被手改）。
  const sorted = [...reads].sort((a, b) => (b.readAt ?? '').localeCompare(a.readAt ?? ''))
  for (const r of sorted) {
    const pid = r.project ?? ''
    if (pid === '') continue
    // ⚠️ 项目可能已被删/归档 ⇒ **视为判不出**（不要注入一个不存在的项目）。
    if (!knownProjects.includes(pid)) continue
    return { project: pid, at: r.readAt ?? '' }
  }
  return { project: HOT_PROJECT_UNKNOWN, at: '' }
}

/**
 * ⭐⭐ **从会话事件里解析"取过哪个项目的交接"**（2026-09-22 新增，用户要求）。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────────────────
 * 用户实测报告：某个会话**做过 `/memj-get-handoff-project dsh-memj`**，
 * 但自动判定**判不出项目** —— 因为那条命令**当时不写任何记录**。
 * 用户原话："这个也应该能够从历史 session 里读出 …… 这个方式也应该加到
 * doc-reads 开启后的判定方法里。"
 *
 * ── 判据是什么（实测确认的形态）──────────────────────────────────────────────
 * 会话日志里的 `command/run` 事件**带着 `args`**，形如：
 * ```json
 * {"type":"command/run","seq":46,"time":1790040880001,
 *  "data":{"commandId":"…","name":"memj-get-handoff-project","args":" dsh-memj 档1","source":{"kind":"user"}}}
 * ```
 * ⇒ ⭐ **命令名 + `args` 的第一个词**就是项目 id（与 `commands.ts:372` 的解析**同一规则**）。
 *
 * ⚠️ **只认这两个命令**（项目级）：`memj-get-handoff-project`。
 *    主题级的 `memj-get-handoff-theme` **不算项目判据**（它给的是主题 id，不是项目）。
 *
 * 🔴 **纯函数**（不碰 I/O）⇒ 可单测；日志读取在 `detectProjectByGetHandoff`。
 * @param events - 会话事件（`SessionEvent[]`，含 `data`）。
 * @param knownProjects - 当前活跃项目 id（排除已删/已归档）。
 * @returns 项目 id + 该命令发生的时刻（epoch ms）；判不出时 `project` 为 `未知`。
 */
export function parseGetHandoffFromEvents(
  events: readonly unknown[],
  knownProjects: readonly string[],
): { project: string; atMs: number } {
  let best: { project: string; atMs: number } | undefined
  for (const raw of events) {
    const e = raw as { type?: unknown; time?: unknown; data?: unknown }
    if (e?.type !== 'command/run') continue
    const d = e.data as { name?: unknown; args?: unknown } | undefined
    const name = typeof d?.name === 'string' ? d.name : ''
    if (name !== 'memj-get-handoff-project') continue
    const args = typeof d?.args === 'string' ? d.args : ''
    // ⚠️ 与 `commands.ts` **同一解析规则**：第一个词是项目 id，其余是档位描述。
    const pid = args.trim().split(/\s+/)[0] ?? ''
    if (pid === '') continue
    // ⚠️ 项目可能已被删/归档 ⇒ 跳过它（**不要注入一个不存在的项目**），
    //    但**继续往前找**更早的记录（也许有别的项目）。
    if (!knownProjects.includes(pid)) continue
    const atMs = typeof e.time === 'number' ? e.time : 0
    // ⭐ 取**最新**一次（用户裁定：与 doc-reads 同等强度，取两者中较新的）。
    if (best === undefined || atMs > best.atMs) best = { project: pid, atMs }
  }
  return best ?? { project: HOT_PROJECT_UNKNOWN, atMs: 0 }
}

/**
 * ⭐⭐ **读会话日志，按"会话里留下的痕迹"判定项目**（2026-09-22）。
 *
 * 🔴 **一次读日志、跑两个解析器**（**别读两遍** —— 会话日志可能很大）：
 * - ⭐⭐⭐ `parseHandoffFromEvents`（**`memj_handoff` 的 `tool/call`，最强**）；
 * - ⭐ `parseGetHandoffFromEvents`（`/memj-get-handoff-project` 的 `command/run`）。
 *
 * ⭐ **优先级**（用户 2026-09-22 裁定）：**`handoff` 高于 `get-handoff`**
 * —— 前者是**模型自己声明并真的写了文档**，后者只是"人要了上下文"。
 * ⚠️ 但两者**都在 `detectDocReads` 开关之下**（开关关着时压根不调本函数）。
 *
 * 🔴 **为什么优先 `observeSession` 而不是 `readSession`**（本项目既有实测结论，
 * 见 `dsh-history-rewind/lib/index.js:124-153` 的注释）：
 * `readSession()` 用 `Session.create` 的快照模式构造日志，**要求
 * `inheritedEventCount === log.length`** ⇒ **任何 fork 后又有追加的会话
 * （grown fork）它都必然抛错**（原文："for every grown fork, deterministically"）。
 * 而 `observeSession()` 走 restore（detached）路径，**能吃 grown fork**
 * ⇒ **优先它，把 `readSession` 留作回退**（给没有该方法的旧核）。
 *
 * ⚠️ **三重容错**（任一失败都返回"未知"，**绝不抛**）：
 * ① 服务不存在（非 web 组装）；② `observeSession` 抛错且回退也失败；③ 事件里没有痕迹。
 * @param ctx - 插件上下文（要能取到 `sessionQuery`）。
 * @param sessionId - 会话 id。
 * @param knownProjects - 当前活跃项目 id。
 * @returns 项目 id + 来源（`handoff` / `get-handoff`）+ 时刻（ISO）；
 *   判不出时 `未知` + 空来源 + 空串。
 */
export async function detectProjectBySessionLog(
  ctx: { get: (name: string) => unknown },
  sessionId: string,
  knownProjects: readonly string[],
): Promise<{ project: string; source: 'handoff' | 'get-handoff' | ''; at: string }> {
  try {
    const q = ctx.get('sessionQuery') as
      | {
        observeSession?: (id: string, o?: { projectionMode?: string }) => Promise<unknown>
        readSession?: (id: string) => Promise<unknown>
      }
      | undefined
    if (q === undefined) return { project: HOT_PROJECT_UNKNOWN, source: '', at: '' }

    let events: unknown[] | undefined
    if (typeof q.observeSession === 'function') {
      let obs: unknown
      try {
        obs = await q.observeSession(sessionId, { projectionMode: 'none' })
        const ev = (obs as { events?: unknown })?.events
        if (Array.isArray(ev)) events = ev
      } catch {
        // ⚠️ 观察不可用**不直接判失败** ⇒ 落到 readSession 回退（见上方注释）。
      } finally {
        try {
          (obs as { [Symbol.dispose]?: () => void } | undefined)?.[Symbol.dispose]?.()
        } catch { /* 释放失败不影响结论 */ }
      }
    }
    if (events === undefined && typeof q.readSession === 'function') {
      const snap = await q.readSession(sessionId)
      const ev = (snap as { events?: unknown })?.events
      if (Array.isArray(ev)) events = ev
    }
    if (events === undefined) return { project: HOT_PROJECT_UNKNOWN, source: '', at: '' }

    // ⭐⭐ **一次读、两个解析器**（`handoff` 优先 —— 用户裁定）。
    const byHandoff = parseHandoffFromEvents(events, knownProjects)
    if (byHandoff.project !== HOT_PROJECT_UNKNOWN) {
      return {
        project: byHandoff.project,
        source: 'handoff',
        at: byHandoff.atMs > 0 ? new Date(byHandoff.atMs).toISOString() : '',
      }
    }
    const byGet = parseGetHandoffFromEvents(events, knownProjects)
    if (byGet.project !== HOT_PROJECT_UNKNOWN) {
      return {
        project: byGet.project,
        source: 'get-handoff',
        at: byGet.atMs > 0 ? new Date(byGet.atMs).toISOString() : '',
      }
    }
    return { project: HOT_PROJECT_UNKNOWN, source: '', at: '' }
  } catch {
    return { project: HOT_PROJECT_UNKNOWN, source: '', at: '' }   // ⚠️ 读日志失败绝不影响判定链的其他环节
  }
}

/**
 * ⭐⭐⭐ **从会话事件里解析"这个会话 handoff 过哪个项目"**（2026-09-22 用户要求）。
 *
 * ── 为什么它是最强的判据 ────────────────────────────────────────────────────
 * 用户实测报告：某会话**做过 5 次 `memj_handoff`**（含一次"建立项目"的交接），
 * 但自动判定**判不出项目** —— 因为那条路径**以前不写任何记录**。
 * 用户原话："这个会话最后一轮是一次建立项目的交接。"
 *
 * ── 判据是什么 ──────────────────────────────────────────────────────────────
 * `tool/call` 事件的 `data.name === 'memj_handoff'`，而它的**入参里明写着 `project`**：
 * ```json
 * {"type":"tool/call","data":{"name":"memj_handoff",
 *   "arguments":{"project":"dsh-016-upgrade","projectDesc":"…","doc":"…","entries":[…]}}}
 * ```
 * ⇒ ⭐ **模型自己声明的项目**，而且它**真的写了那个项目的文档**
 *    ⇒ 比 `doc-reads`（读了文档）与 `get-handoff`（人要了上下文）**都直接**。
 *
 * ⚠️ **`step: 'knowledge'` 的那几次也算**（同样声明了 `project`，只是没写叙事）
 *    —— 用户裁定"取最新一次"。
 * ⚠️ **参数可能是字符串**（工具调用参数在流里是 JSON 字符串）⇒ 两种形态都要吃。
 * 🔴 **纯函数**（不碰 I/O）⇒ 可单测。
 * @param events - 会话事件（`SessionEvent[]`，含 `data`）。
 * @param knownProjects - 当前活跃项目 id（排除已删/已归档）。
 * @returns 项目 id + 该调用发生的时刻（epoch ms）；判不出时 `project` 为 `未知`。
 */
export function parseHandoffFromEvents(
  events: readonly unknown[],
  knownProjects: readonly string[],
): { project: string; atMs: number } {
  let best: { project: string; atMs: number } | undefined
  for (const raw of events) {
    const e = raw as { type?: unknown; time?: unknown; data?: unknown }
    if (e?.type !== 'tool/call') continue
    const d = e.data as { name?: unknown; arguments?: unknown; args?: unknown } | undefined
    if (d?.name !== 'memj_handoff') continue
    // ⚠️ 参数有两形态：对象（已解析）或 JSON 字符串（流里的原样）。
    let obj: { project?: unknown } | undefined
    const a = d.arguments ?? d.args
    if (typeof a === 'string') {
      try { obj = JSON.parse(a) as { project?: unknown } } catch { continue }
    } else if (a !== null && typeof a === 'object') {
      obj = a as { project?: unknown }
    }
    const pid = typeof obj?.project === 'string' ? obj.project.trim() : ''
    if (pid === '') continue
    // ⚠️ 项目可能已被删/归档 ⇒ 跳过，但**继续往前找**更早的记录。
    if (!knownProjects.includes(pid)) continue
    const atMs = typeof e.time === 'number' ? e.time : 0
    // ⭐ 取**最新**一次（用户裁定："会话中途换项目 ⇒ 认最近那个"）。
    if (best === undefined || atMs > best.atMs) best = { project: pid, atMs }
  }
  return best ?? { project: HOT_PROJECT_UNKNOWN, atMs: 0 }
}

/**
 * ⚠️ 通道归一化：**项目/主题层不允许 `section`**（方案 §3.2）。
 *
 * 🔴 `systemPrompt.section()` 在 root scope 注册 ⇒ 它的 `text()` 对**所有 agent**
 * 返回同一份内容 ⇒ "按项目区分"的东西**物理上装不进去**。
 * ⇒ 即便用户写了 `section`，项目/主题层也**一律按 `inbox` 处理**，
 *   并在页面上**明确提示**（**不静默降级**——本项目一贯）。
 * @param channel - 用户设置的通道。
 * @param layer - 该条属于哪一层。
 * @returns 实际生效的通道 + 是否发生了降级。
 */
export function effectiveChannel(
  channel: HotChannel,
  layer: HotItem['layer'],
): { channel: HotChannel; downgraded: boolean } {
  if (channel === 'section' && layer !== 'global') return { channel: 'inbox', downgraded: true }
  return { channel, downgraded: false }
}

/**
 * ⭐⭐ **从一段文本里认出"这批指纹里出现过的那些"**（两处共用同一实现）。
 *
 * 🔴 **为什么要有这个共享函数**：同一判据（"这段注入文本里有没有这条"）有**两个调用方**——
 *    · 看门狗 `idsInWindow`（`hot-watch.ts`，**每次出网都跑**）；
 *    · 重建 `fingerprintsFromInjectionEvents`（`/hot` 的冷路径）。
 *    本项目铁律：**实现只留一份**——否则两处迟早漂移（已发生过多次）。
 *
 * ── ⭐ 两条路径（2026-09-24 按用户要求改，**先量后定**）────────────────────────
 * | 指纹形态 | 走哪条 | 成本 |
 * |---|---|---|
 * | **uuid 形状**（封面 id，绝大多数） | **一次正则扫出文本里所有 uuid + 求交** | **与指纹数无关**（只扫一遍文本） |
 * | **非 uuid**（画像的文本指纹，现实里 1~几条） | 逐条 `includes` | 与条数成正比，但条数极少 |
 *
 * 🔴🔴 **为什么按指纹数分两路**（实测拐点，不是拍脑袋）：
 *    · `includes` 是 **SIMD 优化的子串搜索**，**指纹少时完胜**正则
 *      （实测 1142KB 语料 / 19 条指纹：**逐条 7.2ms vs 正则 13.7ms**）；
 *    · 但它的成本 = `指纹数 × 全文扫描` ⇒ **线性增长**（200 条时 85.8ms、1000 条时 403ms）；
 *    · 正则的成本**基本恒定**（11~15ms，只扫一遍文本）。
 *    ⇒ **实测拐点在 20~50 条之间**；本项目当前 19 条（3 画像 + 16 封面）。
 *    ⚠️ 但**清单会长大**（「批量加入」一次可加 149 条）⇒ 现在按"与指纹数无关"的写法做，
 *      以后不会随清单增长而恶化。
 *    ⭐ 判据：**性能结论必须量出来**，别凭"正则看着更高级"或"逐条看着更土"下判断。
 *
 * ⚠️ **非 uuid 指纹不能漏**：画像**没有封面 id**，它的身份就是**正文前 60 字符的文本指纹**
 *    （见 `personaFingerprint`）⇒ 它**不可能**被 uuid 正则扫到 ⇒ 必须单独用 `includes` 兜。
 *    🔴 这是本函数最容易写错的一处：只写正则 ⇒ **画像永远显示「未注入」**。
 *
 * @param text - 要扫描的文本（注入文本 / 出网消息拼接的全文）。
 * @param wanted - 待认的全部指纹（封面 id + 画像指纹）；空串会被忽略。
 * @returns 其中出现的那些（新集合；调用方自行合并）。
 */
export function fingerprintsInText(text: string, wanted: readonly string[]): Set<string> {
  const found = new Set<string>()
  if (text === '' || wanted.length === 0) return found
  /** uuid 形状的（走正则 + 求交）。 */
  const uuidWanted = new Set<string>()
  /** 非 uuid 的（画像文本指纹；走逐条 includes）。 */
  const textWanted: string[] = []
  for (const fp of wanted) {
    if (fp === '') continue
    if (UUID_SHAPE.test(fp)) uuidWanted.add(fp)
    else textWanted.push(fp)
  }
  if (uuidWanted.size > 0) {
    // ⚠️ `matchAll` 内部会**克隆**正则（不改本模块那个实例的 `lastIndex`）⇒ 可安全复用。
    for (const m of text.matchAll(UUID_SCAN)) {
      if (uuidWanted.has(m[0])) found.add(m[0])
    }
  }
  // 🔴 **画像（非 uuid 指纹）在这里兜底** —— 漏了它，画像就永远判不出来。
  for (const fp of textWanted) if (text.includes(fp)) found.add(fp)
  return found
}

/** 封面 id 的形状（**全小写** 8-4-4-4-12）。⚠️ 只用于**判定形状**，不带 `/g`（避免 `lastIndex` 状态）。 */
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * 从文本里**扫出所有 uuid 形状的串**（`/g` + `matchAll`；见 `fingerprintsInText` 的注释）。
 *
 * ⭐ **导出它**，是为了让主动注入的"窗口快照"能**共用同一份形状定义**：
 *    那边要扫的是"**所有**出现过的封面 id"（不预设待找列表），用法不同、
 *    但**什么算一个 id** 必须只有一处定义 —— 否则两个判据会各认各的
 *    （本项目铁律：同一判据只能有一份实现）。
 */
export const UUID_SCAN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * ⭐⭐⭐ **从会话事件里读出"最近一次热知识注入包含哪些指纹"**（2026-09-23 用户要求）。
 *
 * ── 为什么需要它（真实缺陷，用户实测报告）────────────────────────────────────
 * 用户原话：*"隔了一整夜，此会话之前已经注入的内容，现在显示未注入了。
 * 我怀疑，只要重新启动之后，已注入的内容就会显示未注入，那这是不对的哇？"*
 *
 * 🔴 **用户说得对，而且根因是"界面在撒谎"**：
 * 看门狗的窗口快照 `hotState.windows` 是**纯内存**的（代码原文"**进程重启即失**"）
 * ⇒ 重启后为空 ⇒ `/hot` 回 `window: null` ⇒ 页面把**每一条**都显示成"未注入"。
 * ⚠️ 而**注入的内容其实好好地躺在会话里**（实测：本会话日志里有 3 个
 * `user/message` 事件、`source={kind: 'plugin:dsh-memj'}`，最近一次含 **14 个封面 id**）
 * ⇒ 那是**假话**：模型眼前明明有，界面却说"未注入"。
 *
 * ── 判据与看门狗【完全一致】─────────────────────────────────────────────────
 * 注入文本就是**当初真发出去的那段**，里面**本来就带每条封面的完整 id**
 * （`meta` 行 `- \`<id>\` …`、`full` 段标题 `#### \`<id>\` 标题`）
 * ⇒ 在它里面 `includes(id)` ＝ 当时那条在不在窗口里，**与 `idsInWindow` 同一判据**。
 * ⭐ 所以重建出来的快照**与平时的结论对得上**（不会出现"重启前说已注入、重启后说没有"）。
 *
 * 🔴🔴 **"最近一次 memj 注入" ≠ "最近一次【热知识】注入"**（2026-09-24 实测修）：
 *    `plugin: 'dsh-memj'` 这个标记**命令注入也在用** ——
 *    例如 `/memj-handoff` 的提示词走的是**同一条** `source: {kind: 'plugin:dsh-memj'}`。
 *    ⚠️ 实例：本会话日志里 `11:41:37` 有一条 **979 字符、命中 0/19** 的注入
 *    （内容是"请做一次记忆 handoff"），它排在真正的热知识注入**之后**。
 *    ⇒ 旧实现取到它 ⇒ 一条指纹都对不上 ⇒ 下面的 `present.size === 0` 守卫
 *      判成"这个会话从没注入过热知识" ⇒ `/hot` 回 `windowSource: null`
 *      ⇒ **页面把每一条都显示成「未注入」**（而在下一次真实出网后又会自己变好，
 *        所以这种"撒谎"极难复现、极难排查）。
 *
 * 🔴🔴 **为什么不是"取最近一条【含指纹的】注入"，而是"每条指纹各自找"**（2026-09-24 用户当场质疑后改）：
 *    我第一版修法是"跳过不含指纹的事件、取最近那一条含指纹的" ——
 *    ⚠️ **用户指出它不成立**：*"如果补了单条，那其他的不就被判断成未注入了？"*
 *    ⭐ **他说的对，而且根因是那条判据的【前提】被打破了**：
 *    · 「只取最近一次」成立的**前提是"每次注入都是全量的"** ——
 *      那样最近一次的文本 = 模型眼前的热知识全集；
 *    · 而**补注方案（缺哪条补哪条）恰恰是增量的** ⇒ 最近一次可能**只含 1 条**
 *      ⇒ 取它当全集 ⇒ **其余 18 条全被判成「未注入」**（页面在撒谎，且是常态性的）。
 *    ⇒ ⭐ **正确判据**：**对每条指纹独立判定"它在任何一次注入里出现过没有"** ——
 *      全量注入与增量补注**都能对**（本次全量给的 + 历次补的 = 模型眼前真实持有）。
 *    ⚠️ **它同时免掉了"命令注入"那类问题**：那种文本一条指纹都不含 ⇒ 天然不贡献任何 present。
 *
 * ⚠️ **纯函数**（不碰 I/O）⇒ 可单测；读日志在 `hot-watch.ts`。
 * @param events - 会话事件（含 `user/message`）。
 * @param fps - 本次应注入的全部指纹（封面 id + 画像指纹）。
 * @returns 其中"在**任何一次** memj 注入文本里出现过的" + **最后一次含指纹的注入**时刻（ISO）；
 *   找不到含指纹的注入事件时 `present` 为空集、`at` 为空串。
 */
export function fingerprintsFromInjectionEvents(
  events: readonly unknown[],
  fps: readonly string[],
): { present: Set<string>; at: string } {
  // ⚠️ 空指纹不参与（`personaFingerprint` 对过短文本返回空串）——它会让
  //    "命中 0 条" 与 "本来就没有可命中的内容" 混在一起。
  const wanted = fps.filter((fp) => fp !== '')
  const present = new Set<string>()
  if (wanted.length === 0) return { present, at: '' }
  /** 最后一次**含指纹**的 memj 注入时刻（命令注入不参与 ⇒ 不会被它带偏）。 */
  let lastAt = ''
  for (const raw of events) {
    const e = raw as { type?: unknown; time?: unknown; data?: unknown }
    if (e?.type !== 'user/message') continue
    const d = e.data as { source?: unknown; message?: unknown; content?: unknown } | undefined
    // ⭐ **只认 memj 自己注入的那条**（`source.kind === 'plugin:dsh-memj'）。
    //    ⚠️ 判据与 `index.ts` 注入时写的 `source` 同源 ⇒ 不要用"文本里有某个词"来认。
    //    🔴 0.2.0 起 kind 是 `plugin:dsh-memj`：V4 会话日志拒绝旧的 catch-all
    //       `kind: 'plugin'`，插件必须用自己的 kind（见 `dsh-llm` 的 MessageSourceMap）。
    const src = d?.source as { kind?: unknown } | undefined
    if (src?.kind !== 'plugin:dsh-memj') continue
    // ⚠️ 正文可能在 `message.content`（标准形态）或 `content`（扁平形态）。
    const msg = d?.message as { content?: unknown } | undefined
    const content = Array.isArray(msg?.content) ? msg.content : d?.content
    if (!Array.isArray(content)) continue
    const text = content
      .map((b) => {
        const t = (b as { text?: unknown })?.text
        return typeof t === 'string' ? t : ''
      })
      .join('\n')
    if (text === '') continue
    // 🔴 **核心**：把这次注入里出现的指纹**累积**进 `present`（不覆盖、不清空）——
    //    这样"先全量、后补注"两次注入的内容会**合并**，而不是被后一次顶掉。
    //    命令注入（不含任何指纹）自然什么都不贡献。
    // ⭐ **比对走共享实现**（与看门狗同一份，见 `fingerprintsInText`）。
    const hits = fingerprintsInText(text, wanted)
    if (hits.size === 0) continue
    for (const fp of hits) present.add(fp)
    lastAt = typeof e.time === 'number' && e.time > 0 ? new Date(e.time).toISOString() : ''
  }
  return { present, at: lastAt }
}

/**
 * ⭐ 某条是否该走 `section` 通道（**画像与全局层才可能**）。
 *
 * @deprecated 🔴 **本函数全项目零调用，且名字与实现对不上**
 * （它叫 `isSection`，判的却是 `shape`）——两个问题都在，留着会误导。
 * 真要判"走不走 section"，用 `effectiveChannel(setting.channel, layer)`。
 * ⚠️ **暂不删**：`test-hot.mjs` 可能引用它；等二期做 `section` 通道时一并清理。
 */
export function isSectionShape(shape: HotShape): boolean {
  return shape === 'full'
}

/**
 * ⭐⭐ **一次完整的注入组装**（判定 → 收集 → 读正文 → 渲染）。
 *
 * 🔴 **这是唯一做 I/O 的入口**（读库 + 读正文）；上面三个都是纯函数。
 * 拆开是为了：**规则可单测**、**I/O 只在一处**、`pre-step` 里能一眼看清顺序。
 *
 * ⚠️ **性能**：`collectHotItems` 每次都要 `scanLibrary()`（扫全部项目文档）。
 * 本方案接受这一点——因为**只在有热知识要注入时才跑**，
 * 且 `pre-step` 本身一轮才一次（方案 §7.2 已确认不需要节流）。
 * @param sessionId - 会话 id（用于告警定位；本函数不读它）。
 * @param projectId - 已判定的项目（`未知` = 只注入全局 + 画像）。
 * @param opts - ⭐ 透传给 `renderHotText` 的渲染选项（`only` 子集 / `supplement` 补注模式）。
 *   ⚠️ **`only` 还会顺带省掉读正文**：不参与本次注入的 `full` 条目**根本不读盘**
 *     （补注常常只缺一两条，没必要把整批正文都读出来）。
 * @returns 注入文本 + 统计 + 参与注入的条目（供看门狗做指纹）。
 */
export async function buildHotInjection(
  sessionId: string,
  projectId: string,
  opts: {
    only?: ReadonlySet<string>
    supplement?: boolean
    /**
     * ⭐ 评分模式（决策 177）：给了且 `on` ⇒ 项目/主题层换成"有效分前 N 名"。
     * ⚠️ 不传 ⇒ 原清单路径（既有调用点与测试不受影响）。
     */
    score?: ScoreReadOpts
  } = {},
): Promise<HotRenderResult & { items: HotItem[] }> {
  void sessionId
  const [persona, items] = await Promise.all([loadPersona(), collectHotItems(projectId, opts.score)])

  // ── 只给 `full` 形态的条目读正文（`meta` 不需要 ⇒ 不白读磁盘）──
  // ⚠️ **子集模式下再加一道**：本次不注入的条目连正文都不读（省磁盘 I/O）。
  const bodies = new Map<string, string>()
  const needBody = items.filter(
    (it) => it.setting.shape === 'full'
      && (opts.only === undefined || opts.only.has(it.cover.id)),
  )
  if (needBody.length > 0) {
    const { loadEntryDoc } = await import('./store.ts')
    for (const it of needBody) {
      try {
        const doc = await loadEntryDoc(it.cover.ref, it.cover.ext)
        if (doc?.body !== undefined && doc.body !== null) bodies.set(it.cover.id, doc.body)
      } catch {
        // ⚠️ 读不到正文**不是错误**（外链可能断）⇒ 渲染层会把它退回 meta 行。
      }
    }
  }

  const rendered = renderHotText(persona, items, bodies, opts)
  return { ...rendered, items }
}
