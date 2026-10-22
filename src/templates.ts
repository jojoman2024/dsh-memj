/**
 * dsh-memj —— **交接文档模板**（决策 204）
 *
 * ── 它解决什么 ──────────────────────────────────────────────────────────────
 * 交接文档原先**硬编码六节**（`sections.ts` 的 `NARRATIVE_TITLES`）。
 * 用户要求：能**完全自定义**——自己定节名、节数、**每一节要干嘛**。
 *
 * ── 🔴 两条硬边界（用户 2026-09-30 裁定）──────────────────────────────────
 * 1. **只作用于「新建项目」那一刻** ⇒ 模板**绝不回溯**已有文档。
 *    落地方式：建文档时把模板的节骨架与**「本档写作规范」一节**一起写进正文，
 *    此后那份文档**按自己正文里的 `##` 标题**工作（决策 207：**正文是节名的唯一权威**；
 *    封面的 `sections` 字段**已删除**（2026-10-05）⇒ 节名只认正文）。
 *    ⇒ ⭐ 这也意味着**改模板不影响任何已有文档**，删除模板同理。
 * 2. **「沉淀知识」节钉死**（`KNOWLEDGE_TITLE`）——封面物理存在那一节里，
 *    改名或删掉会让封面丢失或累积。⇒ 模板里**不许出现**这个节名。
 *
 * ── 数据形状（`<库根>/templates/<id>.md`，决策 208）───────────────────────
 * ⭐ 人可读的 markdown：frontmatter 放 `id` / `title`，**每个 `## ` 标题 = 节名，
 *    标题下的正文 = "这一节要干嘛"**（行末 `<!-- truncate -->` 标记参与截断）。
 *    ⇒ 用户在设置页改模板 ≈ 直接改这份文档（见 `renderTemplateDoc` / `parseTemplateDoc`）。
 * ⚠️ 旧的 `<id>.json` 仍**兼容读**（`legacyTemplatePath()`），但**不再写入**；
 *    想清掉旧格式用 `scripts/migrate-templates-to-md.mjs`。
 * | 字段 | 说明 |
 * |---|---|
 * | `id` | 模板 id（= 文件名，全小写英文/数字/连字符） |
 * | `title` | 给人看的名字 |
 * | `sections[]` | ⭐ **顺序即文档节顺序**；每条 `{ name, desc, truncate? }` |
 * | `sections[].name` | `## ` 标题本身 |
 * | `sections[].desc` | ⭐ **这一节要干嘛**（必填，渲染进该文档自己的「本档写作规范」一节） |
 * | `sections[].truncate` | 该节是否参与**自动截断**（**可多节**；全 false = 不自动截断） |
 *
 * @module dsh-memj/templates
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { defaultTemplatePath, legacyTemplatePath, templatePath, templatesDir } from './paths.ts'
import { writeTextAtomic } from './files.ts'
import { fillSlots, promptText, registerPromptDefault } from './prompts.ts'
import { renderFrontmatter, splitFrontmatter, yamlScalar } from './parse.ts'
import {
  KNOWLEDGE_TITLE,
  NARRATIVE_TITLES,
  SPEC_BLOCK_FENCE,
  SPEC_SECTION,
  SPEC_TITLE,
  specBlockRange,
} from './sections.ts'

// ══════════════════════════════════════════════════════════════════════════
// ⭐⭐⭐ **「本档写作规范」那一节的骨架**（2026-10-12 开放编辑；`{{…}}` 是插槽）
//
// 🔴 **它是什么**：`handoff` 落盘时把它渲染成**该文档正文里的一节**
//    （`## 本档写作规范`，排在叙事节之后、`## 沉淀知识` 之前）
//    —— 告诉模型"这份文档有几节、每节要干嘛、哪节会被自动截断"。
//    ⭐ **建项目时从模板复制进来，之后归文档自己所有**（改模板不影响已有文档）。
//
// ⚠️ **它【不再】是"`memj_read` 额外附一份"的投递通道** —— 那条通路已于 2026-10-12 退役
//    （规范就在正文里，`memj_read` 返回的 `content` 本来就带着它；再附一份就是第二份副本）。
//
// 🔴 **为什么它以前不可编辑**：正文里嵌着**运行时才知道的值**（节数、节名、每节用途、
//    可截断标记）⇒ 是模板不是常量。
// ⭐ **现在**：骨架走覆盖层、值由 `fillSlots` 填，`slots` 校验保证插槽不被删/写错。
//
// ⚠️ **`{{desc}}` 是用户自己在模板页写的"这一节要干嘛"**，不是本文件的内容 ——
//    改行模板时别把 `{{desc}}` 当成示例文字删掉。
// ══════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════
// ⚠️⚠️ **决策 209：`tpl:guidance-*` 五条已退役三条**（2026-10-05）
//
// 它们原先用于渲染「本档写作规范」那一节（决策 207 的"末尾单列一节"）。
// 现在规范**长在各节自己身上**（标题下的 ` ```memj:spec ` 围栏，见 `sections.ts`），
// 围栏形态**由代码生成**（`renderSpecBlocksSkeleton`）⇒ **不再走提示词**
//   ⇒ ⭐ 顺带消灭了当年的一个坑：**用户把外壳改坏 ⇒ 反解静默失效**（现在改不了）。
//
// | key | 现在还有用吗 |
// |---|---|
// | `tpl:guidance-head` | ❌ **退役**（"本文档共 N 节"不再需要） |
// | `tpl:guidance-row` | ❌ **退役**（围栏形态由代码定） |
// | `tpl:guidance-foot` | ❌ **退役**（"沉淀知识由工具生成"改由回执报） |
// | `tpl:guidance-trunc-mark` | ✅ **保留** —— **旧形态的兼容读要用它** |
// | `tpl:guidance-no-trunc` | ✅ **保留** —— 回执里要报"本模板没有可截断的节" |
//
// 🔴 **退役 ≠ 可以删 key**：用户可能在设置页改过它们。删了 key 会让那份覆盖
//    变成**孤儿**（页面上再也看不到、也删不掉）。⇒ 保留登记、标注退役。
// ══════════════════════════════════════════════════════════════════════════

/** @deprecated 决策 209 退役（不再有消费者）。保留常量是为了**不删台账里的 key**。 */
export const TPL_GUIDANCE_HEAD: string =
  '本文档共 **{{count}} 节**（顺序固定，工具按此输出；缺的节补空标题）：'
/** @deprecated 决策 209 退役（规范块的形态由 `renderSpecBlocksSkeleton` 生成）。 */
export const TPL_GUIDANCE_ROW: string = '- `## {{name}}` —— {{desc}}{{trunc}}'
/**
 * ✅ **仍在使用**（唯一还活着的 `tpl:guidance-*`）——**旧形态的兼容读**。
 *
 * 🔴 用途没变，但**消费者换了**：`truncateTitlesFromSpec()` 现在只服务
 *   **存量文档**（决策 207 建的、规范还在末尾那一节里）。
 *   ⇒ 删掉它，那些文档会**静默变成"不截"**（`a113fcb` 事故同族）。
 */
export const TPL_GUIDANCE_TRUNC_MARK: string = '　⭐ **本节的较早内容会被自动截断归档**'
/**
 * ✅ **仍在使用**：建项目回执里报"这份模板的规范里**没写**归档规则 ⇒ 文档不会自动瘦身"。
 *
 * 🔴 **2026-10-09 修**：它原先的触发判据是 `sections.every(s => s.truncate !== true)` ——
 *   而 `truncate` **已从 `TemplateSection` 删除** ⇒ 那个判据**恒真**
 *   ⇒ 这句话会**无条件**出现在每份新建项目的回执里，而它说的是**已废除的机制**。
 *   现在改由 {@link templateDeclaresArchiving} 判"规范里有没有写归档规则"（见 `handoff.ts`）。
 */
export const TPL_GUIDANCE_NO_TRUNC: string =
  `⚠️ **本模板的任何一节规范里都没有写归档规则** ⇒ 文档超长时**不会自动瘦身**。
⭐ 归档现在是**按各节规范里的自然语言**执行的（工具不再自动截断）——
想让某一节瘦身，就把规则写进那一节的规范里。`
/** @deprecated 决策 209 退役（那句话改由回执报，不再写进文档）。 */
export const TPL_GUIDANCE_FOOT: string =
  '🔴 **`## {{knowledgeTitle}}` 由工具生成**（放封面，不是你写的），**不在上面这几节里**。'

registerPromptDefault('tpl:guidance-head', TPL_GUIDANCE_HEAD)
registerPromptDefault('tpl:guidance-row', TPL_GUIDANCE_ROW)
registerPromptDefault('tpl:guidance-trunc-mark', TPL_GUIDANCE_TRUNC_MARK)
registerPromptDefault('tpl:guidance-no-trunc', TPL_GUIDANCE_NO_TRUNC)
registerPromptDefault('tpl:guidance-foot', TPL_GUIDANCE_FOOT)

/** 模板结构版本（变了就升 ⇒ 旧模板当不兼容，不猜）。 */
export const TEMPLATE_VERSION = 1

/**
 * 代码围栏那一串反引号（避免在模板串里直接写它——本项目的老坑）。
 *
 * ⚠️ **它是"围栏那行"的唯一来源**：`renderTemplateDoc` / `renderSpecBlocksSkeleton`
 *   都从它拼 ⇒ 不会出现"一处写 3 个、另一处写 4 个"。
 */
const FENCE = String.fromCharCode(96, 96, 96)

/** 模板 id 的允许形态（与 slug 同规，因为它同时是文件名）。 */
export const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9-]{0,46}[a-z0-9]$/

/** 一节的定义。 */
export interface TemplateSection {
  /** 节名（`## ` 后面那个词）。 */
  name: string
  /**
   * ⭐⭐ **这一节的书写规范**（必填）—— 会进该节的规范块，**模型按它写这一节**。
   *
   * 🔴🔴 **决策 223（2026-10-12）起，它还可能承载"归档规则"**（自然语言）：
   *    用户裁定"**归档完全交给模型、规则写在各节的书写规范里**"，工具不再执行归档
   *    （它读不懂自然语言）⇒ **规范里怎么写，模型就怎么做**。
   *    ⚠️ 所以规范要写得**模型能自检**：**把数字写死**（如"超过 20000 字符"），
   *       因为工具会在交接回执里**把实际字符数报给它**，有确切数字才对照得上。
   */
  desc: string
}

/** 一份模板。 */
export interface Template {
  version: number
  id: string
  title: string
  sections: TemplateSection[]
}

/**
 * ⭐ **内置默认模板**（= 改造前的硬编码六节）。
 *
 * ⭐⭐ **2026-10-12（决策 208）：`default` 也落盘，用户可直接编辑它。**
 *   ⇒ 本函数是**纯函数回落值**（磁盘上没有那份文件时用它）；
 *     真正"当前生效的默认模板"请用 **`loadDefaultTemplate()`**（它读盘优先）。
 *   ⚠️ **为什么必须留一个纯函数的版本**：很多地方（校验、测试、UI 初值）要一个
 *     不依赖磁盘的确定值；而"用户改过默认模板"这件事只影响**新建项目**。
 *
 * 🔴🔴 **2026-10-12（决策 223）：`truncate` 标记已废除，归档规则改成写进 `desc`。**
 *   · **旧**：`{ name:'当前进度', truncate: true }` + 设置页两个全局旋钮
 *     ⇒ 工具**自动**截断并落 `history` 条目；
 *   · **新**：规则**写成自然语言放进这一节的书写规范**，**由模型执行**；
 *     工具不再执行，只在交接回执里**报出各节字符数**（让模型有数字可对照）。
 *   ⭐ 用户原话：*"什么阈值触发，压缩目标，要不要截断，怎么归档，归档到什么类型
 *     完全由章节的书写规范去定。"*
 */
export function defaultTemplate(): Template {
  return {
    version: TEMPLATE_VERSION,
    id: 'default',
    title: '默认（六节）',
    sections: [
      { name: '目标', desc: '这个项目要做什么。只保留**总目标**与**最新批次的目标**，用 `###` 子章节分开。' },
      {
        name: '当前进度',
        desc: [
          '做到哪了（新进展必须写进这一节）。',
          '最新的批次写在**最上面**；每个批次一个 `###` 小节，格式',
          '`### 第N批（YYYY-MM-DD）：<一句话主题>`（批号用中文数字，同一批次只写一个小节）。',
          '本节字符数**超过 20000 字符**时，把**最早的那些 `###` 小节整节**归档掉，压到**不超过 12000 字符**为止：',
          '· 条目：用 `memj_handoff` 的 `entries` 落成 **`kind: history`** —— ⚠️ **它不参与检索**（是留档，不是知识；写成别的类型就会正常参与检索）；',
          '· 正文**原文照收、一字不改**；`slug` 形如 `dsh-memj-history-b32-b37`；',
          '· 原处**只留一行指针**：**完整 uuid** + 一句话批次主题（例：`· 第32~37批：早期设置页改造 —— 详见条目 9f3c1a2b-…`）；',
          '· 指针集中放进 `### 历史进展` 小节，它在本节**最末尾**。',
        ].join('\n'),
      },
      { name: '有效做法', desc: '被验证过的工作方法' },
      { name: '失败/踩坑', desc: '出过的错与根因' },
      { name: '关键上下文', desc: '接手人必须知道的事实（路径、id、机制）' },
      { name: '下一步', desc: '待办' },
    ],
  }
}

/**
 * ⭐⭐ **取"当前生效的默认模板"**（决策 208）——**磁盘优先，回落内置**。
 *
 * 🔴 **为什么要它**：`default` 落盘之后，用户可能**改过它**
 *   （这正是"default 也落盘"的目的）⇒ 凡"要用默认模板去建项目 / 渲染规范"的地方，
 *   都该用本函数而不是 `defaultTemplate()`，否则**用户的修改会被内置值悄悄盖掉**。
 *
 * ⚠️ 与 `loadTemplate('default')` 的关系：那个也能读盘，但它**没有内置回落**
 *   （文件不在就 `undefined`）⇒ 默认模板**必须永远可用**（它是 `delete` 的拒绝理由、
 *   也是 `template` 参数的默认档），所以这里补上回落。
 * @returns 模板（**永不 `undefined`**）。
 */
export async function loadDefaultTemplate(): Promise<Template> {
  const t = await loadTemplate('default')
  return t ?? defaultTemplate()
}

/**
 * ⭐⭐ **确保 `default` 模板已落盘**（决策 208）——首次使用时写一份出来。
 *
 * 🔴 **为什么需要"确保"而不是"启动时无条件写"**：
 *   ① 它必须可被用户编辑 ⇒ 不能每次启动都把用户的改动**覆盖回内置值**；
 *   ⇒ 判据 = **文件不存在才写**（幂等，不碰已有内容）。
 * @returns 是否本次新建了该文件。
 */
export async function ensureDefaultTemplateFile(): Promise<boolean> {
  const p = defaultTemplatePath()
  let exists = false
  try {
    await readFile(p, 'utf8')
    exists = true
  } catch {
    exists = false
  }
  if (exists) return false
  await mkdir(templatesDir(), { recursive: true })
  await writeTextAtomic(p, renderTemplateDoc(defaultTemplate()))
  return true
}

/**
 * ⭐⭐ **校验一份模板**（纯函数，不读盘）。
 *
 * 🔴🔴 **为什么"节名不得互为子串"是硬校验**（本次核实发现）：
 *    `read.ts` 的按节匹配是**子串匹配**（`title.toLowerCase().includes(key)`），
 *    而 `tools.ts` 累积"读到过哪些节"时**用同一条规则再筛一遍**
 *    ⇒ 若两节互为子串（如「进度」与「进度详述」），**一次读取会同时记下两节**
 *    ⇒ 「写前先读」闸门判"读全了"时**假绿**（它以为读过了，其实没有）。
 *
 * 🔴 **为什么必须挡「沉淀知识」**：封面物理存在那一节里（见 `sections.ts`）。
 * @param t - 待校验的模板。
 * @returns 问题清单（空 = 合法）。
 */
export function validateTemplate(t: Template): string[] {
  const errs: string[] = []
  if (!TEMPLATE_ID_RE.test(t.id)) {
    errs.push(`\`id\` 必须是全小写英文/数字/连字符（2–48 字符），当前是 \`${t.id}\`。`)
  }
  if (t.title.trim() === '') errs.push('`title` 不能为空。')
  if (t.sections.length === 0) errs.push('`sections` 至少要有 1 节。')

  const names: string[] = []
  for (const [i, s] of t.sections.entries()) {
    const at = `第 ${i + 1} 节`
    const name = s.name.trim()
    if (name === '') errs.push(`${at}：节名不能为空。`)
    if (/[\r\n]/.test(s.name)) errs.push(`${at}：节名不能含换行。`)
    if (name.startsWith('#')) errs.push(`${at}：节名不要带 \`#\`（工具会自己加 \`## \`）。`)
    // ⭐ desc 必填（用户 2026-09-30 裁定："必须写"）——它要进写作指导。
    if (s.desc.trim() === '') errs.push(`${at}（${name || '未命名'}）：\`desc\` 必填——它是"这一节要干嘛"。`)
    // ⭐⭐ **2026-10-05（用户裁定）：`desc` 的 200 字符硬上限【取消】，改为软提醒**（见 `templateWarnings`）。
    //    理由：这一节现在装的是**完整的书写规范**（要写什么 + 怎么写 + 截断/归档规则），
    //    200 字对它偏紧（实测生产模板最多已用到 83 字，很快会不够）；
    //    而**它不吃截断配额**（`sectionCharCount` 把规范块整体剔除）⇒ 写长没有副作用。
    //    ⇒ ⭐ 判据：**"太长"是提醒，不是拒绝** —— 异常长多半是"误贴了整篇文档"，
    //      那该由人判断，而不是让校验替他拒绝。
    if (name === KNOWLEDGE_TITLE) {
      errs.push(`${at}：节名不能是「${KNOWLEDGE_TITLE}」——**那一节由工具维护**（封面存在那里），不开放给模板。`)
    }
    // 🔴🔴 **决策 209 补的缺口**（实测：原先放行 ⇒ 文档里会出现**两个同名顶层节**）：
    //    模板里若有一节叫「本档写作规范」，工具落盘时**还会再加一个**规范节
    //    ⇒ `specRange()` 只认第一个、`cutSpecSection` 只砍第一个 ⇒ **第二个残留**，
    //    且 `sectionsFromNarrative` 把两个都排除 ⇒ 那一节成了"既不是叙事节、
    //    也不受工具管"的**孤儿**。
    if (name === SPEC_TITLE) {
      errs.push(`${at}：节名不能是「${SPEC_TITLE}」——**那一节由工具维护**（写作规范），不开放给模板。`)
    }
    // 🔴🔴 **决策 209 补的第二个缺口**（实测：节名含反引号 ⇒ 规范节渲染后被**截断反解**）：
    //    节名会被渲染进 `- \`## <节名>\` —— …` 这类**行内代码**里；
    //    反引号/竖线/`#` 会破坏它 ⇒ 反解出的节名**少一截**（截断瞄错节）。
    //    ⚠️ 这些字符在**文档标题行**里也是 markdown 元字符，本就不该出现在节名里。
    if (/[`|]/.test(s.name)) {
      errs.push(`${at}（${name}）：节名不能含反引号或竖线 —— 它会被渲染进行内代码，**反解时会被截断**（截断会瞄错节）。`)
    }
    if (name.startsWith('#')) errs.push(`${at}：节名不要带 \`#\`（工具会自己加 \`## \`）。`)
    if (names.includes(name)) errs.push(`${at}：节名 \`${name}\` 重复。`)
    names.push(name)
  }

  // ⭐ 互为子串 ⇒ 读取时一次命中两节（见上方注释）。
  for (const a of names) {
    for (const b of names) {
      if (a === b || a === '' || b === '') continue
      if (a.includes(b)) {
        errs.push(`节名 \`${a}\` 含 \`${b}\` ⇒ 按节读取时会**一次命中两节**（读记录会误判"读全了"）。请改成互不包含的名字。`)
      }
    }
  }

  // ⭐⭐ 决策 206（用户 2026-10-02）：**允许多节声明可截断**。
  //    🔴 原先限制"至多 1 节"是**错的**（用户指出）——
  //       交接文档里可能有好几节都会无限膨胀（比如「当前进度」+「失败/踩坑」）。
  //    ⭐ 语义（用户拍板）：**各自独立** —— 每节各自与阈值比、各自截、
  //       各自产出自己的历史归档块（`history.ts` 的 `truncateProgress` 已支持）。
  //    （因此这里**不再有任何数量校验**。）
  return errs
}

/**
 * ⭐⭐ **`desc` 超过这个长度就提醒**（**不阻断保存**）——2026-10-05 用户裁定。
 *
 * 🔴 **为什么是"提醒"而不是"上限"**：
 *   这一节装的是**完整的书写规范**（要写什么 + 怎么写 + 截断/归档规则），
 *   用户明确裁定"**干脆不限**"；而它**不吃截断配额**（规范块被整体剔除）⇒ 写长没有副作用。
 * ⚠️ 保留一个提醒的理由很实际：**异常长多半是"误贴了整篇文档进来"** ——
 *   那是人要判断的事，工具只负责**让他看见**，不替他拒绝。
 */
export const DESC_SOFT_WARN = 2000

/**
 * ⭐ **模板的"提醒"清单**（**不阻断保存**，与 `validateTemplate` 的"错误"分开）。
 *
 * ⭐ 为什么要和错误分开：两者的**后果完全不同** ——
 *   错误 ⇒ 保存被拒（必须改）；提醒 ⇒ 照常保存，只是一句话告诉你"这看着不太对"。
 *   混在一个数组里会让调用方**分不清该不该拦**。
 * @param t - 待检查的模板。
 * @returns 提醒清单（空 = 没什么可说的）。
 */
export function templateWarnings(t: Template): string[] {
  const warns: string[] = []
  for (const [i, s] of t.sections.entries()) {
    const n = [...s.desc].length
    if (n > DESC_SOFT_WARN) {
      warns.push(
        `第 ${i + 1} 节（${s.name.trim() || '未命名'}）：这一节的书写规范有 **${n}** 字符` +
          `（超过 ${DESC_SOFT_WARN}）—— 请确认不是误贴了整篇文档。**不影响保存**。`,
      )
    }
  }
  return warns
}

/**
 * ⭐ 把模板拼成**该项目的节名清单**（顺序即文档顺序）。
 * @param t - 模板。
 * @returns 节名数组。
 */
export function templateSectionNames(t: Template): string[] {
  return t.sections.map((s) => s.name)
}

/**
 * ⭐ **这份模板有没有在任何一节的规范里写「归档规则」**（决策 223 之后的新判据）。
 *
 * ── 为什么要它 ─────────────────────────────────────────────────────────────
 * 🔴🔴 旧判据是 `sections.every(s => s.truncate !== true)` —— 而 `truncate`
 *   这个字段**已从 `TemplateSection` 删除**（决策 223）、`normalizeTemplate()` 也不读它
 *   ⇒ 它**恒为 `undefined`** ⇒ `every(...)` **恒为 `true`**
 *   ⇒ **每一份新建项目的回执都会说那句"文档不会自动瘦身"**，而它说的是**已废除的机制**。
 *   ⭐ 判据必须指向**真实存在的东西**；指向一个被删掉的字段，就必然恒真。
 *
 * ── 现在的判据 ─────────────────────────────────────────────────────────────
 * 归档规则**写在 `desc` 里的自然语言中**（工具读不懂它，但**能看出它有没有被写**）——
 * 于是这里只做一件可机械判定的事：**任一节的 `desc` 里有没有提到归档**。
 *
 * ⚠️ **边界（这是"提醒"不是"校验"）**：正则按关键词判，**认不出自由措辞**
 *   （用户若写"超过 2 万就把最早的挪到条目里"而不出现"归档/history" ⇒ 会判成"没写"）。
 *   ⇒ 假阴性的方向是**多说一句提醒**，不影响功能；所以**不必**把它做成精确解析。
 * @param t - 模板。
 * @returns 有任一节提到归档 ⇒ `true`。
 */
export function templateDeclaresArchiving(t: Template): boolean {
  return t.sections.some((s) => /归档|history/i.test(s.desc))
}

/**
 * ⭐⭐⭐ **把一份模板渲染成 markdown 文档**（决策 208，2026-10-12）。
 *
 * ── 形态（人可读写，机器也能解析）────────────────────────────────────────
 * ```
 * ---
 * version: 1
 * id: company-deep-research
 * title: 公司深度研究交接文档
 * ---
 *
 * # <文件位置说明>
 *
 * ## 研究目标
 *
 * 本次要研究这家公司是为了回答哪些问题……（= 这一节要干嘛）
 *
 * ## 公司画像
 *
 * ……
 * ```
 *
 * 🔴 **每节 = 一个 `## ` 标题 + 一段"这一节要干嘛"**：
 *   · `## ` 标题就是**节名** → 它同时是 `renderSpecSection()` 里那条 `- \`## X\` —— desc`；
 *   · 标题下的正文就是 **`desc`**（决策 204 的"这一节要干嘛"）。
 *   ⭐ 于是**同一份文件**既是"模板"、又是人能直接读懂的结构说明 ——
 *     这正是用户要的"把初始模板作为一个文档模板存 md"。
 *
 * 🔴 **"可截断"已不再是一个标记**（决策 223）：归档规则**直接写进那一节的 `desc`**
 *   —— 也就是它必须写成**自然语言**（如"本节超过 20000 字符时……"）。
 *   ⚠️ 所以模板里**没有** `<!-- truncate -->` 这类机器标记了；解析侧对存量**仍宽容**。
 * @param t - 模板。
 * @returns markdown 全文（末尾带换行）。
 */
export function renderTemplateDoc(t: Template): string {
  const fm = renderFrontmatter([
    ['version', String(TEMPLATE_VERSION)],
    ['id', yamlScalar(t.id)],
    ['title', yamlScalar(t.title)],
  ])
  const parts: string[] = [
    fm,
    `# 交接文档模板 — ${t.title || t.id}`,
    '',
    `<!-- 这是模板 \`${t.id}\`：\`## \` 标题 = 节名；标题下的 ${FENCE}${SPEC_BLOCK_FENCE} 围栏里写"这一节要干嘛"。`,
    '     ⭐ 建项目时工具会把**整份结构（含规范块）**复制成那份项目文档，此后两者解耦（改这里不影响已有文档）。',
    '     ⭐ **归档规则也写在这里**（自然语言）：想让某一节自动瘦身，就把"超过多少字符、', 
    '        把什么归档成什么类型、原处留什么"写进那一节的围栏里 —— 由模型照它执行。 -->',
    '',
  ]
  for (const s of t.sections) {
    parts.push(`## ${s.name}`, '')
    // ⭐⭐ 决策 209：desc 放进**规范块**（与项目文档同形）。
    //    ⚠️ 即使 desc 是空串也照样写围栏 —— 否则解析回来分不清
    //       "这一节没有规范"与"规范是空的"，而后者是**校验要报的错**。
    parts.push(`${FENCE}${SPEC_BLOCK_FENCE}`, s.desc.trim(), FENCE, '')
  }
  return `${parts.join('\n').trimEnd()}\n`
}

/**
 * ⭐⭐ **解析 markdown 模板**（`renderTemplateDoc()` 的逆；决策 208）。
 *
 * 🔴 **必须能容忍人手改**（这是选 md 的理由之一）：
 *   · 标题级别只用 `## `；`# ` 那行是文件标题、**不是节**；
 *   · 行末的 `<!-- truncate -->` 决定该节是否可截断（⚠️ 用 `includes` 而非严格相等：
 *     人手改时很容易多打个空格）；
 *   · `id`/`title` 优先取 frontmatter；**缺 frontmatter 时从文件名兜底**
 *     （`fallbackId`）⇒ 用户新建一个裸 md 也能用。
 * @param text - markdown 全文。
 * @param fallbackId - 文件名推出的 id（frontmatter 没有时用）。
 * @returns 模板；**一个 `## ` 节都没有 ⇒ `undefined`**（不猜）。
 */
export function parseTemplateDoc(text: string, fallbackId: string): Template | undefined {
  const { data, body } = splitFrontmatter(text)
  const id = typeof data?.['id'] === 'string' && (data['id'] as string).trim() !== ''
    ? (data['id'] as string).trim()
    : fallbackId.trim()
  if (id === '') return undefined
  const fmTitle = typeof data?.['title'] === 'string' ? (data['title'] as string) : ''

  const sections: TemplateSection[] = []
  /** 当前节在**全文行数组**里的起始下标（攒行用；`undefined` = 还没有节）。 */
  let curFrom = -1
  let inFence = false
  const all = body.split(/\r?\n/)

  /** 收尾：把 `all[curFrom, to)` 这一节解析出来（⭐ 规范块由 `specBlockRange` 单独取）。 */
  const flush = (to: number): void => {
    if (curFrom < 0) return
    const seg = all.slice(curFrom, to)
    const head = /^##\s+(.+?)\s*$/.exec(seg[0] ?? '')
    if (head === null) { curFrom = -1; return }
    let name = (head[1] ?? '').trim()
    // ⚠️ **兼容旧版遗留的 `<!-- truncate -->` 行末标记** ——
    //    决策 223 起归档标记已废除，但**存量模板里可能还带着它**
    //    ⇒ 读侧**照旧剥掉**（否则它会留在节名里 ⇒ 节名对不上 ⇒ 模板看起来坏了）。
    name = name.replace(/<!--\s*truncate\s*-->/i, '').trim()
    if (name === '') { curFrom = -1; return }
    // ⭐⭐ 决策 209：**围栏的内容 = desc**（`specBlockRange` 是唯一边界实现）。
    const r = specBlockRange(seg)
    // ⚠️⚠️ **兼容旧形态（决策 208）**：那时 desc 是**标题下的裸正文**。
    //    🔴 不接住它们 ⇒ 存量模板的 desc **全部变成空串** ⇒ `validateTemplate`
    //       报"desc 必填" ⇒ **用户会以为自己的模板坏了**（而它只是旧格式）。
    //    ⭐ 判据：**换存储形态时，读侧必须同时认两种**（本项目的老纪律）。
    const desc = r === undefined
      ? seg.slice(1).join('\n').trim()
      : seg.slice(r.bodyStart, r.bodyEnd).join('\n').trim()
    // 🔴 **决策 223：不再读 `truncate`** —— 归档规则现在是 `desc` 里的自然语言，
    //    ⇒ 围栏起始行的后缀（若有）**被解析侧忽略**（`specBlockFenceInfo` 仍认那行）。
    sections.push({ name, desc })
    curFrom = -1
  }

  for (let i = 0; i < all.length; i += 1) {
    const line = all[i] ?? ''
    // ⚠️ 跳过代码围栏内的伪标题（与人侧文档解析同规）。
    //    🔴 **但规范块的围栏起始行不在此列** —— 它由 `specBlockRange` 认，
    //       而这里只需知道"进了围栏、里面的 `##` 不是节"。
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^##\s+(.+?)\s*$/.exec(line)
    if (m !== null) {
      flush(i)
      curFrom = i
      continue
    }
    // ⚠️ 顶层 `# ` 是文件标题 ⇒ 结束当前节（"这一节要干嘛"不会跨过它）。
    if (/^#\s+/.test(line)) {
      flush(i)
      continue
    }
  }
  flush(all.length)

  if (sections.length === 0) return undefined
  return { version: TEMPLATE_VERSION, id, title: fmTitle.trim() !== '' ? fmTitle.trim() : id, sections }
}

/**
 * ⭐ 读一份模板 —— **`.md` 优先，回落旧的 `.json`**（决策 208 + 兼容读）。
 *
 * 🔴 **两种格式都必须接住**：决策 204 的存量是 `.json`（生产库当时有一份
 *   `company-deep-research.json`）⇒ 只顾新格式会让它**静默消失**。
 * @param id - 模板 id。
 * @returns 模板；两种都不存在或都不可解析 ⇒ `undefined`（**不猜**）。
 */
export async function loadTemplate(id: string): Promise<Template | undefined> {
  // ① 新格式（.md）。
  let text: string | undefined
  try {
    text = await readFile(templatePath(id), 'utf8')
  } catch {
    text = undefined
  }
  if (text !== undefined) {
    const t = parseTemplateDoc(text, id)
    if (t !== undefined) return t
  }
  // ② 旧格式（.json）——兼容读。
  try {
    const json = await readFile(legacyTemplatePath(id), 'utf8')
    return normalizeTemplate(JSON.parse(json))
  } catch {
    return undefined
  }
}

/**
 * 宽松地把任意 JSON 规整成 `Template`（字段缺失用默认值兜）。
 * ⚠️ **不在这里做语义校验**（那是 `validateTemplate` 的事）——本函数只保证"形状可用"。
 */
export function normalizeTemplate(raw: unknown): Template | undefined {
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const id = typeof o['id'] === 'string' ? o['id'] : ''
  if (id === '') return undefined
  const title = typeof o['title'] === 'string' ? o['title'] : id
  const secsRaw = Array.isArray(o['sections']) ? (o['sections'] as unknown[]) : []
  const sections: TemplateSection[] = []
  for (const s of secsRaw) {
    if (s === null || typeof s !== 'object') continue
    const so = s as Record<string, unknown>
    const name = typeof so['name'] === 'string' ? so['name'] : ''
    if (name === '') continue
    // 🔴 **决策 223：`truncate` 不再读**（归档规则改由 `desc` 的自然语言表达）。
    //    ⚠️ 存量 `.json` 模板里可能还带着 `truncate: true` ⇒ **忽略它**（不报错、也不生效）。
    sections.push({
      name,
      desc: typeof so['desc'] === 'string' ? so['desc'] : '',
    })
  }
  return { version: TEMPLATE_VERSION, id, title, sections }
}

/**
 * 列出库里全部模板（含默认，它**总是可用**且不可删）。
 *
 * ⭐⭐ **2026-10-12（决策 208）**：`default` 现在**也在磁盘上**
 *   （`ensureDefaultTemplateFile()` 首次落盘）⇒ 列表里那份**以磁盘为准**
 *   （用户可能改过它）；磁盘上没有才回落内置值。
 * ⚠️ 兼容读旧的 `.json`（存量模板不会因为改格式而消失）。
 */
export async function listTemplates(): Promise<Template[]> {
  // ⭐ 默认模板：磁盘优先（用户可编辑），否则内置。
  const def = await loadDefaultTemplate()
  const out: Template[] = [def]
  let files: string[] = []
  try {
    files = await readdir(templatesDir())
  } catch {
    return out
  }
  const seen = new Set<string>(['default'])
  // ① 新格式（.md）优先；② 再收旧的 .json 里"还没有 .md 版本"的（兼容读）。
  for (const ext of ['.md', '.json'] as const) {
    for (const f of files) {
      if (!f.endsWith(ext)) continue
      const id = f.slice(0, -ext.length)
      if (seen.has(id)) continue
      const t = await loadTemplate(id)
      if (t === undefined) continue
      seen.add(id)
      out.push(t)
    }
  }
  return out
}

/**
 * 保存一份模板（**先校验、不合法不写盘**）。
 *
 * ⭐ **决策 208**：写 `.md`（`renderTemplateDoc`）。
 * ⭐ **`default` 现在可以保存**（用户可编辑它）—— 落盘后 `loadDefaultTemplate()` 会读到它。
 * @param t - 模板。
 * @returns 问题清单（空 = 已写入）。
 */
export async function saveTemplate(t: Template): Promise<string[]> {
  const errs = validateTemplate(t)
  if (errs.length > 0) return errs
  await mkdir(templatesDir(), { recursive: true })
  await writeTextAtomic(templatePath(t.id), renderTemplateDoc(t))
  return []
}

/**
 * 删除一份模板。
 * 🔴 **`default` 不可删**（它是回落目标）。
 * @param id - 模板 id。
 * @returns 是否真的删了。
 */
export async function deleteTemplate(id: string): Promise<boolean> {
  if (id === 'default') return false
  let deleted = false
  // ⚠️ 两种格式都要删（否则旧的 .json 会让它"删了又回来"——`loadTemplate` 会回落读它）。
  for (const p of [templatePath(id), legacyTemplatePath(id)]) {
    try {
      // 🔴 **不能用 `force: true`**（安全评审 F5，2026-10-22）：
      //    `force` 把"本来就不存在"也当成功 ⇒ 本函数**对任意 id 都回 `true`** ⇒
      //    实测 `POST /api/template/delete {id:"根本没有这个"}` 回 `200 {"ok":true}`。
      //    ⚠️ 这不是小事：调用方（页面 / 模型）据 `ok` 判断"删掉了"，
      //       而库里**什么都没变** —— 假成功比失败更难查（它不报错、不留痕）。
      //    不带 `force` ⇒ 不存在时抛 ENOENT ⇒ `deleted` 保持 false ⇒ 上层回 404。
      await rm(p)
      deleted = true
    } catch {
      /* 不存在（ENOENT）或删不掉（EPERM）⇒ 都不算删成功 */
    }
  }
  return deleted
}

/**
 * 🔴🔴 **`renderTemplateGuidance()` 已删除**（2026-10-12，决策 207）。
 *
 * 它的职责是"按模板拼一段写作指导、由 `memj_read` **按需附在返回值末尾**"。
 * 那条通路**已退役**：规范现在**就写在文档正文里**（`## 本档写作规范` 一节，
 * 由 `renderSpecSection()` 渲染、建项目时从模板复制）
 * ⇒ `memj_read` 返回的 `content` **本来就带着它**。
 *
 * ⚠️ 留着它等于**同一事实两份实现**：本项目的判据是
 *   "一段代码里已经有了一种实现，就问其他几条路径为什么还需要"，
 *   而两条路都会输出去给模型看 ⇒ **迟早漂开、且两个副本会同时出现**。
 * @see renderSpecSection 它的替代者（落点是**文档正文**，不是工具返回值）。
 */

/** 供内部使用：默认六节的节名（= 无模板时的回落）。 */
export const DEFAULT_SECTION_NAMES: readonly string[] = NARRATIVE_TITLES

/**
/**
 * ⭐⭐⭐ **渲染"建项目用的骨架"——每节连它的规范块一起生成**（决策 209）。
 *
 * ── 它取代了什么 ──────────────────────────────────────────────────────────
 * 取代 `renderSpecSection()`（决策 207 的"文档末尾单列一节"）。
 * 现在规范**长在它讲的那一节自己身上**（用户最初的形态）：
 *
 *   ## 目标
 *
 *   ```${SPEC_BLOCK_FENCE}
 *   这个项目要做什么
 *   ```
 *
 *   （空行留给模型写正文）
 *
 * ── 🔴 三条纪律 ───────────────────────────────────────────────────────────
 *   1. **纯函数 + 幂等**：建项目路径上每次都会调它（同一输入永远同一输出）；
 *   2. **围栏语言标记走 `SPEC_BLOCK_FENCE` 常量**（与解析侧同源，改一处即两侧同步）；
 *   3. **只产出"标题 + 规范块 + 空行"**，不动正文（正文由 `mergeNarrative` 负责）。
 *
 * ⚠️ **desc 为空也照样写围栏** —— 否则解析回来分不清"这一节没有规范"与
 *   "规范是空的"，而后者正是 `validateTemplate` 要报的错。
 * @param t - 模板。
 * @returns 骨架全文（末尾一个换行）。
 */
export function renderSpecBlocksSkeleton(t: Template): string {
  const out: string[] = []
  for (const s of t.sections) {
    // 🔴 **决策 223：围栏起始行不再有任何后缀**（`truncate` 已废除）。
    out.push(`## ${s.name}`, '', `${FENCE}${SPEC_BLOCK_FENCE}`)
    if (s.desc.trim() !== '') out.push(s.desc.trim())
    out.push(FENCE, '')
  }
  return `${out.join('\n').trimEnd()}\n`
}

/**
 * 🔴🔴 **`truncateTitlesFromSpec()` 已于 2026-10-12（决策 223）删除。**
 *
 * ── 它原来做什么 ────────────────────────────────────────────────────────────
 * 兼容读**决策 207 的旧形态**：从文档末尾那节「本档写作规范」里反解"哪几节能自动截断"。
 *
 * ── 为什么现在能删 ──────────────────────────────────────────────────────────
 * 它服务的是"**工具自动截断**"这条机制 —— 而该机制已整个废除
 * （归档交给模型、规则写成自然语言）⇒ 没有消费者了。
 * ⚠️ **代价（已接受）**：存量老文档里那句"本节的较早内容会被自动截断归档"
 *    **不再有任何效果** —— 它现在只是一句**给人看的陈述**。
 *    用户若要让那些文档继续瘦身，得按新规范**把归档规则写进各节的规范块**。
 * ⭐ 这不影响文档可读性（那行本来就只是说明），也不会让页面报错。
 */

