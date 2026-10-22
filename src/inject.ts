/**
 * ⭐ **「取交接」的注入内容构造**（决策 110）。
 *
 * 两个命令的**共同职责**：把一个项目/主题的上下文**渲染成模型可见的文本**。
 * 它只**构造文本**，不碰会话——送进会话由 `commands.ts` 负责。
 *
 * ── 为什么单独一个模块 ──────────────────────────────────────────────────────
 * ① 纯函数（除读库外无副作用）⇒ **可单测**、不必起会话；
 * ② 档位逻辑（三档 + 去重）是**最容易出错的语义**，需独立可测；
 * ③ 与命令注册解耦 ⇒ 将来别的入口（工具、网页）也能复用同一份渲染。
 *
 * ── ⚠️ 对模型的措辞要求（全部来自实际需要，不是客套）──────────────────────
 * 🔴 **知识只给「标题 + desc + id + 阅读方式」，正文按需读**——
 *    否则一次注入可能几万字，把上下文挤爆，而其中大半这次用不上。
 * 🔴 **必须告知"本次针对哪个项目/主题"**——否则模型后续 handoff 时
 *    还得调 `memj_info` 去判断归属（用户明确指出的痛点）。
 * ⚠️ 但措辞要**弱**：说「**本次交接的目标项目是 X**」，
 *    而**不说**「本会话属于 X」——后者会让模型把后续无关工作也记到 X 上。
 *
 * @module dsh-memj/inject
 */

import { loadEntryDoc, loadProjectDoc, scanLibrary } from './store.ts'
import { loadThemeFrontmatter } from './store.ts'
import type { Cover } from './schema.ts'
// ⭐⭐⭐ 提示词运行期覆盖（本次新增）：收尾指令 + 各段表头都走 `promptText` 取值。
import { promptText, registerPromptDefault } from './prompts.ts'
// ⭐⭐⭐ 安全评审 F2/F6（2026-10-22）：行内消毒 + 不可信区块边界。
import { oneLine, untrustedBlock } from './untrusted.ts'

/** 交接档位（**从小到大**，2 是默认）。 */
export const HANDOFF_LEVELS = [1, 2, 3] as const

/** 档位类型。 */
export type HandoffLevel = (typeof HANDOFF_LEVELS)[number]

/** 默认档位：文档 + 项目知识（第 2 档）。 */
export const DEFAULT_LEVEL: HandoffLevel = 2

/** 档位说明（同时用于提示词与回执）。 */
export const LEVEL_LABELS: Record<HandoffLevel, string> = {
  1: '只交接文档',
  2: '连带项目知识',
  3: '全部（文档 + 项目知识 + 所属主题知识）',
}

/**
 * ⭐ **从用户补充的话里解析档位**（"语义选择模式"）。
 *
 * 🔴 **设计原则**：**认不出就用默认档，并在回执里明说**——
 *    绝不猜。用户说了"只看文档"却给了三档（或反之）比"没识别出来"更糟。
 *
 * ⚠️ 匹配**宁可窄**：只在出现明确的档位词时才认定；含糊的表述（如"整理一下"）
 *    一律当没说 ⇒ 走默认档 + 回执告知。
 * @param note - 用户补充的话（已 trim）。
 * @returns 识别出的档位；**没识别出来时 `undefined`**（调用方用默认档）。
 */
export function parseLevel(note: string): HandoffLevel | undefined {
  const t = note.trim()
  if (t === '') return undefined
  // 第 3 档：**最强的信号优先**（"全部"里也含"文档"，不先判会被 1 档截走）。
  if (/全部|都要|所有|连同主题|带主题|加主题|三档|档\s*3|level\s*3/i.test(t)) return 3
  // 第 1 档：只要文档。
  // ⚠️ **不能只写"只看文档"**——实测漏掉了"只要交接文档"这类变体（`只要` + `文档` 分开出现）。
  //    ⇒ 判据放宽成「含"只要/只看/仅"且含"文档"」或「明确说不要知识」。
  if (/不要知识|不带知识|别带知识|不含知识/.test(t)) return 1
  if (/(只看|只要|仅看|仅要|只是|只交接|仅交接)/.test(t) && /文档/.test(t)) return 1
  if (/一档|档\s*1|level\s*1/i.test(t)) return 1
  // 第 2 档：文档 + 项目知识。
  if (/连带|加上知识|带知识|项目知识|二档|档\s*2|level\s*2/i.test(t)) return 2
  return undefined
}

/**
 * ⭐⭐ 「取交接」注入文本的**收尾指令**（决策 110 补充，用户拍板 2026-09-19）。
 *
 * 🔴 **为什么必须有**：命令用 `followup`（**会唤醒驱动器**，见 `commands.ts`）——
 *    模型收到注入后**必然会开始一轮**。而在加这段之前，注入文本**以内容结尾、
 *    没有任何收尾**，模型只能自己猜"我该干什么"⇒ 极易**自行动作**
 *    （去写库、去改文档、去调工具核对），而用户**只是想让模型知道上下文**。
 *
 * ⭐ **两个命令共用这一份**（项目 vs 主题）——同一件事写两遍必然漂移。
 *
 * ── 措辞为什么这么硬 ──────────────────────────────────────────────────────
 * 本项目惯例是「**回执/提示词要"给动作"，不能只说"确认一下"**」：
 * 所以这里不是"请谨慎"，而是**明确的禁止项 + 唯一的允许项**：
 * - 禁止：写库 / 改交接文档 / 调工具核对或补全；
 * - 允许（且仅允许）：**告诉用户下一步能做什么**；
 * - 收尾：**停下等指令，不要自行开始那件事**。
 *
 * ⚠️ **"不管什么档位"**：这段**加在 `parts` 末尾、`return` 之前** ⇒
 *    三档（1/2/3）与主题交接**都会带上**，不依赖档位分支。
 * @returns 收尾指令 markdown（含前置分隔线）。
 */
export const CLOSING_INSTRUCTION: string = `---

⭐ **以上内容已注入完毕——这就够了。**

🔴 **你不需要为了"用上"这些信息而做任何动作**：
不要写库、不要改交接文档、不要调工具去核对或补全。
（这些信息的作用是**让你知道上下文**，不是**让你产出**。）

⭐ **唯一可以做的**：如果合适，**告诉用户接下来可以让你做什么**。
⚠️ **然后就停下**，等用户的下一条指令——**不要自行开始那件事**。`

// ⭐⭐⭐ **注入段表头的可编辑常量**（2026-10-12 抽成常量 + 走 `promptText`）。
//
// 🔴 **为什么这些"表头"也算提示词**：它们**逐字写在注入给模型的那段文本里** ——
//    模型读到的就是它们，且它们直接决定"模型怎么看待这批内容"
//    （例如"正文按需读"这句，模型据此决定要不要去 `memj_read`）。
//    ⭐ 本项目判据：**能改变模型怎么做的文本就是提示词**，不管它看起来像不像"一句话说明"。
//
// ⚠️ **它们不决定"注入哪些条目"** —— 那是代码里的判据（`level` / `wanted()` 等）；
//    改这里只影响措辞，不影响集合。所以标 `immediate`（渲染是调用点现读，无需重启）。
export const TARGET_PROJECT_LINE: string =
  `后续 handoff 若要归档本次工作到这个项目，可直接沿用，**不必再调 \`memj_info\` 判断归属**；⚠️ 但若**后续工作明显是另一件事**，仍应按新话题重新判断。`

export const TARGET_THEME_LINE: string = '（用于了解这个主题下有哪些可复用知识）。'

export const PROJECT_KNOWLEDGE_HINT: string =
  `⭐ **以下只给标题与描述，正文按需读**——用 \`memj_read\` 传 \`id\` 取正文（长文档它会回节名清单，再用 \`section\` 取某一节）。`

export const THEME_KNOWLEDGE_HINT: string =
  '⭐ **同样只给标题与描述，正文按需读**（`memj_read`）。'

export const THEME_COVERS_HINT: string =
  `⭐ **只给标题与描述，正文按需读**——用 \`memj_read\` 传 \`id\` 取正文（长文档它会回节名清单，再用 \`section\` 取某一节）。`

// ⭐⭐⭐ **登记默认值**（本次新增；展示页要用）。
// ⚠️ **措辞原本是用户拍板的**（2026-09-19）—— 页面上允许改，属于用户自己的决定。
registerPromptDefault('inject:closing', CLOSING_INSTRUCTION)
registerPromptDefault('inject:target-project', TARGET_PROJECT_LINE)
registerPromptDefault('inject:target-theme', TARGET_THEME_LINE)
registerPromptDefault('inject:project-knowledge-hint', PROJECT_KNOWLEDGE_HINT)
registerPromptDefault('inject:theme-knowledge-hint', THEME_KNOWLEDGE_HINT)
registerPromptDefault('inject:theme-covers-hint', THEME_COVERS_HINT)

/**
 * 渲染一条知识的**封面行**（不给正文）。
 *
 * ⚠️ **不再在行尾重复"读它"提示**（决策 124 分层改造）：
 * 各节的**表头**已经统一写了"只给标题与描述，正文按需读 + 用 `memj_read` 取"——
 * 每行再重复一次是**同一件事写 N 遍**：单行提示 21 字符 + 换行缩进 3 = 24 字符，
 * 以本项目 70 张封面算 ≈ **1,680 字符**的白费。
 * @param c - 封面。
 * @returns markdown 行。
 */
function renderKnowledgeLine(c: Cover): string {
  // 🔴 **`oneLine()` 不是修饰，是边界**（安全评审 F2）：
  //    这个格式**按行**表达"一条知识" ⇒ 标题或描述里只要有 `\n`，
  //    就能凭空造出**一条看起来完全合法**的条目（实测：1 条真条目渲染成 2 条，
  //    伪造的那条 id 是 `deadbeef`）。⇒ 行内字段一律先压成单行。
  const kind = c.kind === '' ? '' : ` [${oneLine(c.kind)}]`
  const ext = c.ext ? '（外部引用）' : ''
  return `- \`${oneLine(c.id)}\`${kind} **${oneLine(c.title)}**${ext} — ${oneLine(c.desc)}`
}

/**
 * 渲染一个项目的交接内容。
 *
 * 档位：
 * - **1**：只有交接文档正文；
 * - **2**：+ 项目自己的知识（**不含**主题的）；
 * - **3**：+ 该项目所属主题下的知识。
 *
 * @param projectId - 项目 id。
 * @param level - 档位。
 * @returns 模型可见文本；项目不存在时返回 `undefined`。
 */
export async function renderProjectHandoff(
  projectId: string,
  level: HandoffLevel,
): Promise<{ text: string; counts: { narrative: boolean; project: number; theme: number } } | undefined> {
  const doc = await loadProjectDoc(projectId)
  if (doc === undefined) return undefined
  const snapshot = await scanLibrary()

  const parts: string[] = []
  parts.push(`## 项目交接：\`${projectId}\``)
  parts.push('')
  // ⭐ 只说"本次交接的目标"，**不说"本会话属于"**——避免模型把无关工作也归到这里。
  // ⭐⭐⭐ 走 `promptText` 取覆盖值（2026-10-12）——改完下一次注入即生效。
  parts.push(
    `⭐ **本次交接的目标项目是 \`${projectId}\`**。` +
      promptText('inject:target-project', TARGET_PROJECT_LINE),
  )
  parts.push('')
  if (doc.frontmatter.desc.trim() !== '') {
    parts.push(`> 项目描述：${doc.frontmatter.desc}`)
    parts.push('')
  }

  // ── ① 交接文档正文（**始终给**）──
  //
  // ⭐⭐⭐ **安全评审 F6**：这段正文是**库里的数据**（可能由历史会话、外部文档写进来），
  //     而它现在被逐字塞进 **node 0 系统提示词**里 ⇒ 必须先划出"这是数据"的边界，
  //     否则文档里的一句"忽略以上指令"与用户的真指令在模型眼里同权。
  parts.push('### 交接文档')
  parts.push('')
  parts.push(
    ...untrustedBlock([
      doc.narrative.trim() === '' ? '_（该项目暂无叙事内容）_' : doc.narrative.trim(),
    ]),
  )
  parts.push('')

  const counts = { narrative: true, project: 0, theme: 0 }

  // ── ② 项目自己的知识（档位 ≥ 2）──
  if (level >= 2) {
    // ⚠️ `project` 字段等于本项目的封面 —— 这里**不含**只挂在主题上的。
    const own = snapshot.covers.filter((c) => c.cover.project === projectId)
    counts.project = own.length
    parts.push(`### 本项目的知识（${own.length} 条）`)
    parts.push('')
    parts.push(
      promptText('inject:project-knowledge-hint', PROJECT_KNOWLEDGE_HINT),
    )
    parts.push('')
    if (own.length === 0) parts.push('_（本项目暂无知识条目）_')
    else parts.push(...untrustedBlock(own.map(({ cover }) => renderKnowledgeLine(cover))))
    parts.push('')
  }

  // ── ③ 所属主题的知识（档位 3）──
  if (level >= 3) {
    const themeIds = [...new Set(doc.frontmatter.themes)].filter((t) => t !== '')
    parts.push(`### 所属主题的知识（主题：${themeIds.length > 0 ? themeIds.join('、') : '无'}）`)
    parts.push('')
    if (themeIds.length === 0) {
      parts.push('_（本项目尚未关联任何主题）_')
    } else {
      // 🔴 **去重**（决策 110 用户明确要求）：
      //    同一张封面可能**既属于本项目、又挂了本项目的主题**
      //    ⇒ 若不去重，它会在②里出现一次、这里再出现一次，模型会以为是两条。
      const shown = new Set(
        snapshot.covers.filter((c) => c.cover.project === projectId).map((c) => c.cover.id),
      )
      const extra = snapshot.covers.filter(
        (c) => c.cover.theme.some((t) => themeIds.includes(t)) && !shown.has(c.cover.id),
      )
      counts.theme = extra.length
      if (extra.length === 0) {
        parts.push('_（这些主题下的知识都已在上面的「本项目知识」里列出，无新增条目）_')
      } else {
        parts.push(promptText('inject:theme-knowledge-hint', THEME_KNOWLEDGE_HINT))
        parts.push('')
        parts.push(...untrustedBlock(extra.map(({ cover }) => renderKnowledgeLine(cover))))
      }
    }
    parts.push('')
  }

  // ⭐⭐ **收尾指令**（用户拍板）：加在**所有档位分支之后** ⇒ 1/2/3 档都会带上。
  // ⭐⭐⭐ 走 `promptText` 取覆盖值（本次新增）—— 改完下一次注入即生效。
  parts.push('')
  parts.push(promptText('inject:closing', CLOSING_INSTRUCTION))

  return { text: parts.join('\n').trimEnd(), counts }
}

/**
 * 渲染一个主题的交接内容。
 *
 * ⭐ 内容是：**主题封面（frontmatter）+ 该主题下的知识清单**（只给标题/描述/id）。
 * ⚠️ 主题没有"交接文档正文"——`THEME-<id>.md` 是**派生层**，
 *    它的正文（覆盖的项目表 + 封面块）是机器生成的，给模型没意义。
 *
 * @param themeId - 主题 id。
 * @returns 模型可见文本；主题不存在时返回 `undefined`。
 */
export async function renderThemeHandoff(
  themeId: string,
): Promise<{ text: string; counts: { covers: number; projects: number } } | undefined> {
  const snapshot = await scanLibrary()
  if (!snapshot.themeIds.includes(themeId)) return undefined
  const fm = await loadThemeFrontmatter(themeId)
  const covers = snapshot.covers.filter((c) => c.cover.theme.includes(themeId))

  const parts: string[] = []
  parts.push(`## 主题：\`${themeId}\``)
  parts.push('')
  parts.push(
    `⭐ **本次交接的目标主题是 \`${themeId}\`**` +
      promptText('inject:target-theme', TARGET_THEME_LINE),
  )
  parts.push('')
  parts.push(`> 主题描述：${fm?.desc !== undefined && fm.desc.trim() !== '' ? fm.desc : '（无描述）'}`)
  parts.push('')

  // 覆盖的项目（给人/模型的语境：这个主题被哪些项目用到）。
  const projectIds = [
    ...new Set(covers.map((c) => c.cover.project).filter((p) => p !== '')),
  ]
  parts.push(`### 覆盖的项目（${projectIds.length}）`)
  parts.push('')
  parts.push(projectIds.length === 0 ? '_（暂无）_' : projectIds.map((p) => `- \`${p}\``).join('\n'))
  parts.push('')

  parts.push(`### 本主题的知识（${covers.length} 条）`)
  parts.push('')
  parts.push(
    promptText('inject:theme-covers-hint', THEME_COVERS_HINT),
  )
  parts.push('')
  if (covers.length === 0) parts.push('_（该主题暂无知识条目）_')
  else parts.push(...untrustedBlock(covers.map(({ cover }) => renderKnowledgeLine(cover))))

  // ⭐⭐ **收尾指令**（与项目交接**共用同一份**）——主题交接也没有档位分支，直接加在末尾。
  parts.push('')
  parts.push(promptText('inject:closing', CLOSING_INSTRUCTION))

  return {
    text: parts.join('\n').trimEnd(),
    counts: { covers: covers.length, projects: projectIds.length },
  }
}
