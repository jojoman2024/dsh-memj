/**
 * 模型可见的六个工具（方案 §4 / §5）。
 *
 * ⚠️ **API 要点**（`dsh-plugin-knowledge.md` §4）：
 *  - `ToolDefinition` **没有 `handler`**，是 `execute(args, exec)`；
 *  - **`output` 必填**：`{ schema, render }`；
 *  - 参数 DSL **不是** schemastery 也不是手写 JSON Schema：
 *    根是隐式开放 object，**必填靠属性上的 `required: true`**；
 *    `type:'object'` 节点必须显式给 `additionalProperties`；
 *  - 注册是 **`ctx.tools.register(...)`**（不是 `ctx.tool(...)`）。
 *
 * ── 每个工具何时调、参数怎么填（§5 总表第 1 行）────────────────────────────
 * 这些都写在各自的 `description` 里（**每步常驻上下文**）。
 * 其中 `memj_handoff` 的 description 同时承载「文档怎么写 + 知识怎么落盘」规范。
 *
 * ── ⚠️ 逐个 try 注册 ───────────────────────────────────────────────────────
 * 一个工具注册抛异常会**拖垮其后全部注册且无日志**（fiber 吞掉）。
 *
 * @module dsh-memj/tools
 */

import type { Context } from '@deepseek-ai/cordis'
// type-only import 提供声明合并：`ctx.tools` 来自 dsh-tools。
import type {} from '@deepseek-ai/dsh-tools'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemjConfig } from './config.ts'
import { runHandoff } from './handoff.ts'
// ⭐⭐ 英文召回索引（设计文档 §9.3）：落盘成功后触发一次后台重建
import { triggerEnIndexRebuild } from './en-index.ts'
// ⭐⭐ 封面删改通道（决策 114）——**与网页 API 共用同一份实现**。
import {
  deleteEntry,
  deleteProject,
  deleteTheme,
  editEntryThemes,
  probeCoverState,
  renameProject,
  renameTheme,
  setEntryFields,
  setEntryGlobal,
  setProjectDesc,
  setProjectFields,
  setThemeDesc,
  setThemeFields,
  updateEntry,
} from './edit.ts'
import { loadEntryDoc, rebuildDerivedLayers, scanLibrary, loadProjectDoc, appendDocRead, findDocRead } from './store.ts'
import { recordRead, renderSnapshotList, pendingSnapshots } from './reads.ts'
import { decideRead } from './read.ts'
// ⭐⭐⭐ 提示词运行期覆盖（本次新增）：`safeRegister` 用它把工具描述改成 getter。
import { fillSlots, promptText, registerPromptDefault } from './prompts.ts'
// ⭐⭐ 决策 221：读项目文档时要把「各节写作规范」集中交出（读侧与那段文案的唯一出处）。
import { renderSectionSpecs } from './reads.ts'
import { sectionSpecsOf } from './sections.ts'
// ⭐ 决策 205：模板工具的两段式确认（纯函数，可单测）。
import { decideTemplateTool } from './template-tool.ts'
// 🔴 **决策 223 的清理（2026-10-09 做的这批）**：这里原来还 import 了 `TPL_GUIDANCE_TRUNC_MARK` ——
//   那个常量是"本节的较早内容会被自动截断归档"那句标记，**已随机制一起废除**，
//   全文件**只剩 import 那一行**（0 个消费者）⇒ 删掉。
//   ⚠️ 常量本身**仍留在 `templates.ts`**（它登记进了提示词账本，删常量会让账本对不上）。
import { KNOWLEDGE_TITLE } from './sections.ts'
// ⭐⭐ 把工具 schema 渲染成人读文本（**只为展示**，见 `safeRegister` 里的说明）。
import { renderOutputText, renderParametersText } from './prompt-catalog.ts'
import { bodySize, filterByContext, filterContextByTerms, normalizeQuery, scoreCover, sortHits } from './search.ts'
import { resolveRef } from './paths.ts'
// ⭐ `kind` 的受控词表判据（决策 114 的 `setFields.kind` 用）。
import {
  currentKindsOf,
  currentReservedKinds,
  fillKindMarkers,
  isEntryKind,
  kindsInline,
  selectableKindList,
  type EntryKind,
} from './schema.ts'
import {
  MEMJ_HANDOFF_DESCRIPTION,
  MEMJ_INFO_DESCRIPTION,
  MEMJ_NORMALIZE_TAGS_DESCRIPTION,
  // ⭐⭐⭐ 决策 177：轮末知识评分。
  MEMJ_SCORE_TURN_DESCRIPTION,
  MEMJ_PROMOTE_DESCRIPTION,
  MEMJ_UPDATE_DESCRIPTION,
  MEMJ_READ_DESCRIPTION,
  MEMJ_REBUILD_DESCRIPTION,
  // ⭐⭐⭐ 决策 205：交接文档模板。
  MEMJ_TEMPLATE_DESCRIPTION,
  MEMJ_SEARCH_DESCRIPTION,
  MEMJ_SNAPSHOTS_DESCRIPTION,
} from './tool-descriptions.ts'

// ══════════════════════════════════════════════════════════════════════════
// 🔴🔴 **原「`memj_read` 附带的写作指导外壳」已删除**（2026-10-12，模板与提示词解耦）
//
// 这里原有三条提示词：`tpl:notice-templated` / `tpl:notice-fallback` / `tpl:notice-missing`
// —— 它们的作用是"`memj_read` 读项目文档时，额外附一份该文档的节结构与每节用途"。
//
// ⭐ **为什么删掉是对的**：那份规范现在**就写在这份文档自己的正文里**
//    （叙事末尾的 `## 本档写作规范` 一节，由 `handoff` 落盘时从模板复制/维护）
//    ⇒ `memj_read` 返回的 `content` **本来就带着它**。
//    ⚠️ 留着这三条会变成**同一事实的第二份副本**，且**两个副本会同时出现在返回值里**
//    （模型看到两份、可能不一致的规范）—— 正是本项目判据
//    "同一事实被两条路维护 ⇒ 必然漂开"的教科书场景。
//
// ⚠️ **`tpl:guidance-*` 那五条【保留】**：它们现在被 `renderSpecSection()` 用来
//    **渲染那一节**（骨架 + 插槽），仍是活的提示词，只是不再有"读文档时另附一份"的通路。
// ══════════════════════════════════════════════════════════════════════════

/** 工具依赖。 */
export interface ToolDeps {
  ctx: Context
  config: MemjConfig
  version: string
}

/**
 * 取当前会话 id。
 *
 * ⚠️ **`exec.agent` 是可选的**——非模型直呼（如栈内调用）时为 `undefined`。
 * 读快照按会话分文件，拿不到会话时退化成一个固定名字，**不能因此中断读取**。
 * @param agent - `exec.agent`。
/**
 * @returns 会话 id。
 */
export function sessionIdOf(agent: { session?: { id?: unknown } } | undefined): string {
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : 'unknown-session'
}

/**
 * ⭐⭐ 取**当前轮次号**（决策 112 的"有效期粒度 = 一个完整轮次"）。
 *
 * ── 来源（已核 DSH 上游源码，非猜测：`@deepseek-ai/dsh-agent` 的会话与投影定义）
 *    ⚠️ 这里**不写本地源码目录**（那是一台机器上的检出位置，对读者无意义且不该公开）——
 *    要复核就看下面这几个**包内路径**，它们在任何安装里都存在。
 * · 会话事件 `turn/start` / `turn/end` 带 `turn: number`
 *   （`packages/core/session/src/types.d.ts`）；
 * · agent-loop 把边界折成投影、key = **`turnBoundary`**
 *   （`turnBoundaryProjectionDefinition = { key: 'turnBoundary', … }`）；
 * · 形状 `TurnBoundaryProjection.lastTurn: number`
 *   ——"Turn number of the latest `turn/start`; 0 before the first turn"；
 * · 读法 **`ctx.sessionProjections.stateOf(session, 'turnBoundary')`**
 *   （服务名取自 `super(ctx, 'sessionProjections')`）。
 *
 * ⚠️ **拿不到就返回 `-1`**（不抛、不中断）：非模型直呼（栈内调用）时
 * `exec.agent` 为 `undefined`，或该投影未注册（无 agent-loop）。
 * ⇒ 校验侧会**退化为"本会话读过即可"**——硬校验的目的是防"凭记忆写"，
 * **不是卡人**，所以宁可放松也不误拦。
 * @param ctx - 插件 ctx（要能取到 `sessionProjections`）。
 * @param agent - `exec.agent`。
 * @returns 轮次号；未知时 `-1`。
 */
export function turnOf(
  ctx: Context,
  agent: { session?: unknown } | undefined,
): number {
  try {
    const session = agent?.session
    if (session === undefined || session === null) return -1
    const svc = ctx.get('sessionProjections') as
      | { stateOf?: (s: unknown, key: string) => { lastTurn?: unknown } | undefined }
      | undefined
    const state = svc?.stateOf?.(session, 'turnBoundary')
    const t = state?.lastTurn
    return typeof t === 'number' && Number.isFinite(t) ? t : -1
  } catch {
    // 投影读取失败**不该影响工具本身**。
    return -1
  }
}

/**
 * 注册全部工具（逐个 try）。
 * @param deps - 依赖。
 */
export function registerTools(deps: ToolDeps): void {
  const { ctx, config } = deps

  /**
   * ⭐⭐⭐ **`kind` 字段的 schema 片段（`enum` 与 `description` 都每轮现算）**。
   *
   * ── 🔴 为什么需要它 ────────────────────────────────────────────────────────
   * 词表**运行期可配**了（用户在设置页增删类型）⇒ 两者**都不能是"注册时算一次"的**：
   *   · 只看 `enum` 不算数 ⇒ 用户加的类型会 **"UI 能选、工具不认"**（模型填了被判非法）；
   *   · **只看描述也不算数** —— 描述里写着"有哪些类型/各自什么意思"，
   *     若它是注册时定死的，就会出现 🔴🔴 **同一个 schema 内部自相矛盾**：
   *     `enum` 里有 `pitfall`，而描述说"只能 fact/trap/howto/decision"。
   *     ⚠️ 这正是本项目反复记的"**两边打架**"，只不过发生在一个字段内部。
   *
   * ── 机制（与 `description` 的覆盖 getter **同源**，见 `safeRegister` 的长注释）──
   * DSH 的装配路径是 `ctx.systemPrompt.tools((context) => this.wireSchemas(...))`
   * ⇒ **每轮重新 `schemaOf()`** ⇒ 参数对象上的 **getter 每轮都会被求值**。
   * ⇒ ⭐ 把两者都做成 getter，**改完类型下一轮即时生效、不用重启**。
   *
   * ⚠️ **`parameters` 是 `defineTool` 一次性构造的普通对象** ⇒
   *    这里返回的也必须是**它当场能吃下的形态**。
   *
   * 🔴🔴 **2026-10-09 重大修正：上面那句"getter 一直有效"是错的，而且【不能】靠 getter 修。**
   *
   * ── 第一层错：getter 被【对象展开】吃掉了（曾经的真实状态）────────────────
   *   本函数**返回**的对象带 getter，但 5 个调用点全写成 `{ ...kindParam(...) }`，
   *   而 **展开运算符走 `[[Get]]`**：读值、然后在新对象上建**数据属性**
   *   ⇒ **getter 不会被带过去**（实测：`{...o}` 之后 `getOwnPropertyDescriptor(x,'enum').get` 为 undefined）。
   *   ⭐ 后果：enum 退化成**注册时快照**，与决策 215 的初衷正好相反。
   *
   * ── 🔴🔴 第二层错（更根本，2026-10-09 实测才知道）：**DSH 根本不接受动态 schema**
   *   我第一版修法是"用一个 symbol 标记穿过展开，再在最终对象上重装 getter"。
   *   **结果 4 个工具整条注册失败**：
   *   ```
   *   JsonSchemaError: unsupported JSON schema:
   *     parameters.entries.items.properties.kind must be a value schema object
   *   ```
   *   ⭐ 根因（查 `dsh-tools/lib/index.js` 的 `isJsonSchemaRecord`）：
   *   它要求参数对象 **只有 own enumerable string keys**
   *   （`hasOnlyEnumerableStringKeys`：`Reflect.ownKeys(v).every(k => typeof k === 'string' && …)`）
   *   ⇒ **symbol 键直接不合格**；而**访问器属性**同样过不了 "value schema object"。
   *   ⇒ 🔴 **DSH 会把 `parameters` 编译成 JSON Schema**（见「知识来源」那条知识），
   *     所以"每轮现算的 schema"**在参数层从原理上做不到**。
   *   ⚠️ 更讽刺的是：**原来那个"展开吃掉 getter"的 bug，恰好让 schema 变成了静态数据属性** ——
   *     它**无意中满足了 DSH 的要求**。所以那 5 个工具一直能注册。
   *     ⭐ 判据：**"能注册上"不等于"设计对了"** —— 两者在这里恰好由同一个 bug 维持。
   *
   * ── ✅ 正确做法（两级，各管各的）────────────────────────────────────────────
   * | 层 | 谁负责 | 怎么保证"用户加的类能用" |
   * |---|---|---|
   * | **参数层**（`enum`） | ⭐ **注册时快照，静态** —— DSH 的要求 | 用户改类型后**下次重启**生效（`enum` 只影响"模型能否填"，是**建议面**）|
   * | **运行期**（`execute` 里） | ⭐ **现算校验**（`isEntryKind` 读进程内词表） | ⭐ **改完立即生效**，且报错**列出当前全部合法值** |
   * ⇒ 这就是库里那条知识给的判据：**"把闸门从参数层移到运行时校验"** ——
   *   拦住集合不变、报错信息量更大、且**不受 DSH 的 schema 限制**。
   * @param descOf - **现算描述**的函数（各处文案不同，但都从当前词表取）。
   * @returns 可直接放进 `parameters` 的 schema 片段（**普通数据属性**）。
   */
  const kindParam = (descOf: () => string): { type: 'string'; enum: string[]; description: string } => ({
    type: 'string' as const,
    /**
     * ⚠️ **注册时的快照**（不再做成 getter）—— 理由上面那段。
     * 🔴 **它只用于"告诉模型有哪些可选"**，**不是**最终闸门：
     *   真正的合法性判断在 `execute` 里走 `isEntryKind()`（读**进程内当前词表**）。
     * ⭐ 所以"用户新加的类型在模型填了之后会不会被拒"这件事，**由运行期那一层保证**。
     */
    enum: currentKindsOf().filter((id) => !new Set(currentReservedKinds()).has(id)),
    /** 描述是**纯展示文本**，做成快照没有副作用（改类型后重启即更新）。 */
    description: descOf(),
  })

  /**
   * 逐个注册，**一个失败不拖垮其余**（同 `dsh-memory` 的教训）。
   *
   * ⭐⭐⭐ **这里是工具描述接入"运行期覆盖"的唯一漏斗**（本次新增）。
   *
   * 🔴🔴 **为什么必须在这里做、且必须用 getter**（实测见 `scripts/probe-prompt-override.mjs`，
   *    13/0）：
   *  - `defineTool` 内部是 `description: options.description` —— **普通属性赋值**，
   *    取值一次就固化了 ⇒ 事后改覆盖值**它不会跟着变**；
   *  - 而 DSH 的装配路径是 `ctx.systemPrompt.tools((context) => this.wireSchemas(...))`
   *    （`dsh-tools:2609`）⇒ 每轮重新 `schemaOf()` ⇒ `const { description } = definition`
   *    （`:2935`）⇒ **getter 每轮都会被求值**。
   *  ⇒ ⭐ **改成 getter 后，改覆盖值无需重启、无需重新注册，下一轮即生效**。
   *    （反证：不加 getter 时改覆盖值**不跟随** —— 探针 D2 专门盯着这一点。）
   *
   * ⚠️ **必须在 `make()` 返回之后做**：早了会被 `defineTool` 的普通赋值覆盖掉。
   * @param name - 工具名（仅用于日志）。
   * @param make - 构造工具定义。
   */
  const safeRegister = (name: string, make: () => ReturnType<typeof defineTool>): void => {
    try {
      const def = make()
      // ⭐ 把源码常量包成"默认值"：覆盖表里没有该键时，`promptText` 原样回它。
      const fallback = def.description
      // ⭐ **登记默认值**（展示页要并排显示"默认 vs 当前"，且"恢复默认"要有依据）。
      registerPromptDefault(`tool:${name}:description`, fallback)
      Object.defineProperty(def, 'description', {
        enumerable: true,
        configurable: true,
        /**
         * ⭐⭐⭐ **决策 217：这里同时填 `{{kindList}}` 插槽**。
         *
         * 🔴 **为什么**：`memj_handoff` / `memj_promote` 的描述里有"只能 {{kindList}}"，
         *    而那句以前是**写死的四值** ⇒ 用户加了类型之后，
         *    同一个 schema 的 `enum` 里有它、描述却说"只能四个" —— **自相矛盾**。
         * ✅ 做成插槽 + **每轮现填** ⇒ 描述永远跟着类型表走。
         * ⚠️ 不认识 `{{…}}` 的（别的工具描述里没有）**原样保留** ——
         *    `fillSlots` 的语义就是"没提供的插槽不填空串"（宁可在输出里可见，也别静默吞掉）。
         */
        get: () => fillKindMarkers(promptText(`tool:${name}:description`, fallback)),
      })
      // ⭐⭐⭐ **登记参数 / 输出的「可读文本」**（2026-10-12 新增）——**只为展示**。
      //
      // 🔴 **解决什么问题**：这两个在源码里是 **JavaScript 对象**（不是字符串）
      //   ⇒ 页面取不到文本 ⇒ 那 22 条**点进去是空的**（用户看到"列了却没内容"）。
      // ⭐ **做法**：把对象**渲染成 markdown**、当"默认值"登记 ⇒ 页面能显示真内容。
      // ⚠️ **只用于显示**：运行时用的仍是 `def.parameters` / `def.output` 那两份**对象**，
      //   两者互不影响 ⇒ **不存在"显示的和实际用的不一致"**。
      // ⚠️ 它们**不可编辑**（`editable: false`）⇒ 覆盖层不会有这两个键
      //   ⇒ `promptText` 永远不会读它们，**纯展示**。
      registerPromptDefault(`tool:${name}:parameters`, renderParametersText(def.parameters))
      registerPromptDefault(`tool:${name}:output`, renderOutputText(def.output))
      ctx.tools.register(def)
    } catch (err) {
      ctx.logger?.error?.('dsh-memj: 工具 %s 注册失败（该工具将不可用）: %o', name, err)
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  // memj_info —— 只报语境，不报知识
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_info',
    () =>
      defineTool({
        name: 'memj_info',
        description: MEMJ_INFO_DESCRIPTION,
        parameters: {
          query: {
            type: 'array',
            items: { type: 'string' },
            description:
              '检索词数组——按词筛**项目与主题**，只回相关的那几个。规则与 memj_search 一致：' +
              '给提炼过的语义词（不是原句），整词命中才算分；匹配 id、名称与描述。' +
              '没有命中就如实说没有匹配（不要回退成全部清单）。',
          },
          kind: {
            type: 'string',
            enum: ['project', 'theme'],
            description: "只查其中一类：'project' 或 'theme'；不给则两类都回。",
          },
          withDesc: {
            type: 'boolean',
            description: '为 true 时附带项目与主题的描述（判断"是不是同一个项目"时必须开）。默认 false。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              projects: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    desc: { type: 'string', required: true },
                  },
                },
              },
              themes: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    name: { type: 'string', required: true },
                    desc: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => {
            const v = value as {
              projects: Array<{ id: string; name: string; desc: string }>
              themes: Array<{ id: string; name: string; desc: string }>
            }
            const parts: string[] = []
            parts.push('## 项目')
            if (v.projects.length === 0) parts.push('_（没有匹配的项目）_')
            for (const p of v.projects) {
              parts.push(`- \`${p.id}\` **${p.name}**${p.desc === '' ? '' : ` — ${p.desc}`}`)
            }
            parts.push('', '## 主题')
            if (v.themes.length === 0) parts.push('_（没有匹配的主题）_')
            for (const t of v.themes) {
              parts.push(`- \`${t.id}\` **${t.name}**${t.desc === '' ? '' : ` — ${t.desc}`}`)
            }
            return [{ type: 'text', text: parts.join('\n') }]
          },
        },
        async execute(args) {
          const { query, kind, withDesc } = args as {
            query?: string[]
            kind?: string
            withDesc?: boolean
          }
          const terms = normalizeQuery(query)
          const snapshot = await scanLibrary()

          let projects = snapshot.projects.map((p) => ({
            id: p.id,
            name: p.id,
            desc: p.frontmatter.desc,
          }))
          // 主题的描述存在 THEME 文档 frontmatter 里。
          const themes: Array<{ id: string; name: string; desc: string }> = []
          for (const id of snapshot.themeIds) {
            const text = await loadThemeDesc(id)
            themes.push({ id, name: id, desc: text })
          }

          // `query` 无命中就如实回空（决策 53），**不兜底成全量**。
          if (terms.length > 0) {
            if (kind !== 'theme') projects = filterContextByTerms(projects, terms)
            if (kind !== 'project') {
              const filtered = filterContextByTerms(themes, terms)
              themes.length = 0
              themes.push(...filtered)
            }
          } else if (kind === 'project') {
            themes.length = 0
          } else if (kind === 'theme') {
            projects = []
          }

          return {
            projects: withDesc === true ? projects : projects.map((p) => ({ ...p, desc: '' })),
            themes: withDesc === true ? themes : themes.map((t) => ({ ...t, desc: '' })),
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // memj_search —— 只找，不读
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_search',
    () =>
      defineTool({
        name: 'memj_search',
        description: MEMJ_SEARCH_DESCRIPTION,
        parameters: {
          project: { type: 'string', description: '按归属项目筛，给项目 id。' },
          theme: { type: 'string', description: '按命中主题筛，给主题 id。' },
          kind: {
            // ⭐ 2026-10-05 收敛：取值与含义都从 `schema.ts` 的唯一词表取 ——
            //    收敛前这里**抄了一遍**，加类型时漏改就会"工具不认、UI 能选"。
            // ⭐⭐ 决策 215：词表运行期可配 ⇒ enum 做成 getter 每轮现算（见 kindParam）。
            // ⭐ 传**函数**（描述每轮现算，决策 217）—— 不是"注册时拼好的字符串"。
            ...kindParam(
              () =>
                `按**形态分类**筛（决策 81）：${kindsInline()}。` +
                '与 project/theme 正交，可并用。',
            ),
          },
          query: {
            type: 'array',
            items: { type: 'string' },
            description:
              '检索词数组——**给提炼过的语义词，不要给用户原句**。整词命中才算分（不做二次切分）。',
          },
          limit: { type: 'integer', description: `最多返回几张封面，默认 ${config.searchLimit}。` },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              hits: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    id: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    desc: { type: 'string', required: true },
                    project: { type: 'string', required: true },
                    theme: { type: 'string', required: true },
                    kind: { type: 'string', required: true },
                    global: { type: 'boolean', required: true },
                    tags: { type: 'string', required: true },
                    ext: { type: 'boolean', required: true },
                    size: { type: 'integer', required: true },
                    ref: { type: 'string', required: true },
                  },
                },
              },
              total: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as {
              hits: Array<{
                id: string; title: string; desc: string; project: string; theme: string
                kind: string; global: boolean; tags: string; ext: boolean; size: number; ref: string
              }>
              total: number
            }
            if (v.hits.length === 0) {
              return [{ type: 'text', text: '没有命中任何封面。不要用别的封面凑数——如实说搜不到。' }]
            }
            const lines = v.hits.map((h) => {
              const sizeNote = h.size > 0 ? `｜size ${h.size} 字符` : ''
              const extNote = h.ext ? '｜外部引用' : ''
              const gNote = h.global ? '｜global' : ''
              const kNote = h.kind !== '' ? `｜${h.kind}` : ''
              return (
                `- \`${h.id}\`${kNote} **${h.title}** — ${h.desc}\n` +
                `  （project: ${h.project || '(无)'}｜theme: ${h.theme || '(无)'}${gNote}${extNote}${sizeNote}｜tags: ${h.tags}）`
              )
            })
            const tail =
              v.total > v.hits.length ? `\n\n（共 ${v.total} 条，此处列出 ${v.hits.length} 条。）` : ''
            return [{ type: 'text', text: `${lines.join('\n')}${tail}` }]
          },
        },
        async execute(args) {
          const { project, theme, kind, query, limit } = args as {
            project?: string; theme?: string; kind?: string; query?: string[]; limit?: number
          }
          const terms = normalizeQuery(query)
          // ⭐⭐ **2026-10-13（「文档内提问」）：检索侧排除 `chat`**。
          //
          //    🔴 **为什么不能用"改 scanLibrary 的默认排除"来实现**：
          //       `chat` **要出现在知识库列表里**（用户裁定：点节选文字能开新标签页看它）
          //       ⇒ 它必须过 `scanLibrary`。所以排除只能做在**模型侧**——
          //       这正是本条：**列表/读侧含它，检索/注入侧排除它**。
          //    ⚠️ 同理，`history` 的排除仍由 `scanLibrary()` 的默认值承担（不变）。
          const snapshot = await scanLibrary()
          let candidates = filterByContext(
            snapshot.covers.map((c) => c.cover).filter((c) => c.kind !== 'chat'),
            project,
            theme,
          )
          // ⭐ `kind` 是**附加的**筛选维度（与 project/theme 正交，可并用）。
          if (kind !== undefined && kind.trim() !== '') {
            candidates = candidates.filter((c) => c.kind === kind.trim())
          }

          const hits = []
          for (const cover of candidates) {
            // ⭐ **标题来自封面**（决策 98）⇒ 这里**不必再打开正文**了。
            //    ⚠️ 以前必须 `loadEntryDoc` 才能拿标题（正文首个 `###`），
            //    导致"不带 query 的检索"也要读**每一个候选**的正文——
            //    成本被低估（见设计 §11.11 与 §3.10.3）。
            const title = cover.title
            if (terms.length === 0) {
              // ⭐ 不带 query ⇒ **不为了 size 去读正文**，size 留空（决策 54）。
              //    ⇒ 现在这条路径**完全不碰文件系统**。
              hits.push({ cover, score: 0, matched: [], title, size: 0 })
              continue
            }
            // ⭐ **只有带 `query` 时**才读正文——因为要拿它做正文匹配与算 size。
            const doc = await loadEntryDoc(cover.ref, cover.ext)
            const body = doc?.body ?? ''
            const scored = scoreCover(cover, terms, title, body)
            if (scored.score === 0) continue
            hits.push({
              cover,
              score: scored.score,
              matched: scored.matched,
              title,
              size: bodySize(body),
            })
          }

          const ordered = terms.length > 0 ? sortHits(hits) : hits
          const capped = ordered.slice(0, typeof limit === 'number' && limit > 0 ? limit : config.searchLimit)
          return {
            hits: capped.map((h) => ({
              id: h.cover.id,
              title: h.title,
              desc: h.cover.desc,
              project: h.cover.project,
              theme: h.cover.theme.join(', '),
              kind: h.cover.kind,
              global: h.cover.global,
              tags: h.cover.tags.join('、'),
              ext: h.cover.ext,
              size: h.size ?? 0,
              ref: h.cover.ref,
            })),
            total: ordered.length,
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // memj_read —— 只读，不找
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_read',
    () =>
      defineTool({
        name: 'memj_read',
        description: MEMJ_READ_DESCRIPTION,
        parameters: {
          id: {
            type: 'string',
            description:
              '封面上的 UUID，来自 memj_search。' +
              '⚠️ 读**项目文档**时改用 `project`（二选一）。',
          },
          project: {
            type: 'string',
            description:
              '⭐ **项目文档的 id**——读 `projects/HANDOFF-<项目>.md` 的正文（决策 112）。' +
              '写交接文档前**必须先读一遍**，所以这是那个前置动作的正规入口。' +
              '与 `id` 二选一。',
          },
          section: {
            type: 'string',
            description:
              '按 `##` / `###` 标题取某一节（子串匹配）。\n' +
              '⭐ 给**顶层 `##` 节名**时，会**连它下面全部 `###` 子节一起返回**；\n' +
              '⭐ 也可以直接给 **`###` 子节名**、单独读它（节太长时分段读用）。',
          },
          full: {
            type: 'boolean',
            description: '强制返回全文（逃生口）。⚠️ 文档很长时它会很大（可能超出上下文）。',
          },
          offset: {
            type: 'integer',
            description:
              '按行区间取：起始行（1 起）。\n' +
              '⭐ **给了 `section` 时按「节内行号」算**（不是全文行号）——' +
              '长节分段读就靠它；没给 `section` 时仍按全文行号。',
          },
          limit: { type: 'integer', description: '按行区间取：取多少行。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              found: { type: 'boolean', required: true },
              id: { type: 'string', required: true },
              title: { type: 'string', required: true },
              mode: { type: 'string', required: true },
              content: { type: 'string', required: true },
              availableSections: { type: 'array', required: true, items: { type: 'string' } },
              /**
               * ⭐⭐ **分两级的节清单**（决策 134）——**顶层节可写、子节只读定位**，
               * 且**每节带字符数** ⇒ 不必先读全文就知道该动哪一节。
               */
              sectionGroups: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    title: { type: 'string', required: true },
                    chars: { type: 'integer', required: true },
                    children: {
                      type: 'array',
                      required: true,
                      items: {
                        type: 'object',
                        additionalProperties: false,
                        properties: {
                          title: { type: 'string', required: true },
                          chars: { type: 'integer', required: true },
                        },
                      },
                    },
                  },
                },
              },
              sectionRequested: { type: 'string', required: true },
              sectionMatched: { type: 'boolean', required: true },
              size: { type: 'integer', required: true },
              notice: { type: 'string', required: true },
              /**
               * ⭐⭐⭐ **决策 221：本文档各节的写作规范**（集中一处，读项目文档时才有）。
               *
               * 🔴 **为什么要有它**：规范原本散落在几万字的正文里，模型读文档时
               *    视线只落在"它这次要写的那一节"⇒ 没有任何东西提醒它"别的节该整理了"。
               *    实测代价见 `reads:section-spec-head` 的目录说明（「目标」节 27 次没被碰过）。
               * ⚠️ 它**只在读项目文档时非空**（读知识条目时恒为空串）。
               */
              sectionSpecs: { type: 'string', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as {
              found: boolean; title: string; mode: string; content: string
              availableSections: string[]; sectionRequested: string
              sectionMatched: boolean; size: number; notice: string
              sectionSpecs?: string
              sectionGroups: Array<{ title: string; chars: number; children: Array<{ title: string; chars: number }> }>
            }
            if (!v.found) {
              // 🔴 **必须把 `notice` 带出来**（决策 112 修正）：
              //    失败原因有四种——知识条目不存在 / 项目不存在 /
              //    两个入口都没给 / 正文读不到（断链）。
              //    ⚠️ 原先这里写死了"找不到该 id 的知识条目"，
              //    于是读**项目文档**失败时会给出**文不对题**的提示，
              //    把模型引向错误的排查方向。
              return [{
                type: 'text',
                text:
                  (v.notice !== '' ? v.notice : '找不到该 id 的知识条目。') +
                  '\n不要用别的内容替代。',
              }]
            }
            const parts: string[] = []
            // ⭐⭐⭐ **决策 221：规范清单排在【最前面】**（读项目文档时才有）。
            //    🔴 **位置是刻意的**：它是"写之前该看的东西"，排在正文之前
            //       才不会又被几万字正文淹掉（那正是它原先失效的原因）。
            //    ⚠️ 它三个分支（按节读 / 节名清单 / 全文）**都要带上** ——
            //       模型可能只读一节就动笔，那时更需要看到"别的节也有规范"。
            if ((v.sectionSpecs ?? '') !== '') parts.push(String(v.sectionSpecs), '', '---', '')
            if (v.mode === 'section-list' || v.mode === 'section-miss') {
              if (v.notice !== '') parts.push(v.notice, '')
              // ⭐⭐ **分两级列出**（决策 134）：顶层节是**可写单位**（`docSection`），
              //    子节是**只读定位**单位（可单独 `section` 取）。**都带字符数**。
              if (v.sectionGroups.length > 0) {
                parts.push('顶层节（⭐ **可作 `memj_handoff` 的 `docSection`**；括号内是字符数）：')
                for (const g of v.sectionGroups) parts.push(`- ${g.title}（${g.chars} 字符）`)
                const withKids = v.sectionGroups.filter((g) => g.children.length > 0)
                if (withKids.length > 0) {
                  parts.push('', '各顶层节下的子节（**只读定位**——可单独 `section` 取它，不能作 `docSection`）：')
                  for (const g of withKids) {
                    parts.push(`· ${g.title}：`)
                    for (const c of g.children) parts.push(`    - ${c.title}（${c.chars} 字符）`)
                  }
                }
              } else if (v.availableSections.length > 0) {
                // 兜底：没有分组信息时回到扁平清单（不丢信息）。
                parts.push('本文的节名：')
                for (const s of v.availableSections) parts.push(`- ${s}`)
              }
            } else {
              parts.push(`# ${v.title}`, '', v.content)
              if (v.notice !== '') parts.push('', `（${v.notice}）`)
            }
            return [{ type: 'text', text: parts.join('\n') }]
          },
        },
        async execute(args, exec) {
          const { id, project, section, full, offset, limit } = args as {
            id?: string; project?: string; section?: string; full?: boolean
            offset?: number; limit?: number
          }

          // ══════════════════════════════════════════════════════════════
          // ⭐⭐ **读项目文档**（决策 112）
          //
          // 🔴 **为什么必须有这条路**：决策 109 把项目文档改成"累积的活文档"
          //    （`doc` 按节合并），但当时就承认了缺口——**模型没有任何工具能读到
          //    项目文档的六节** ⇒ 只能凭记忆重写，而"凭记忆"必然压缩、丢细节。
          //    ⚠️ 真实事故：某轮 handoff 我读了四节、**唯独漏读「当前进度」**
          //    ——恰恰是要写的那一节 ⇒ 没把新批次写进该节，反而另起了一个顶层节。
          //
          // ⇒ 这条路 + 下面的读记录 = 让"先读再写"成为**可校验**的动作。
          // ══════════════════════════════════════════════════════════════
          if (project !== undefined && project.trim() !== '') {
            const projectId = project.trim()
            const pdoc = await loadProjectDoc(projectId)
            if (pdoc === undefined) {
              return {
                found: false, id: projectId, title: '', mode: 'not-found', content: '',
                sectionGroups: [],
                availableSections: [], sectionRequested: '', sectionMatched: false,
                size: 0, sectionSpecs: '', notice: `没有项目 \`${projectId}\`（不存在它的交接文档）。`,
              }
            }
            // 🔴 **归档项目不可读**（决策 133）：归档的语义是"**项目本身**不再参与工具调用"，
            //    而"读它的文档"显然是一次参与 ⇒ 一并挡住。
            //    ⚠️ 与封面侧同理：**先能读到它**，才能给出"已归档"而不是"不存在"。
            if ((pdoc.frontmatter.archivedAt ?? '') !== '') {
              return {
                found: false, id: projectId, title: '', mode: 'archived', content: '',
                sectionGroups: [],
                availableSections: [], sectionRequested: '', sectionMatched: false,
                size: 0, sectionSpecs: '',
                notice: `项目 \`${projectId}\` **已归档**，信息不可用（归档时间 ${pdoc.frontmatter.archivedAt}）。`,
              }
            }
            // 项目文档的正文 = **纯叙事**（frontmatter 与封面块已由 loadProjectDoc 剥掉）。
            const body = pdoc.narrative
            const decision = decideRead(body, {
              section, full, offset, limit, maxChars: config.readFullMaxChars,
            })

            // ⭐ 记一条**项目文档读记录**（决策 112）——写叙事前的硬校验靠它。
            //    ⚠️ **只在那次读取确实返回了内容时记**：只回节名清单不算"读到了"。
            //    ⚠️ `full` 的判据是"**本次读的是不是全文**"：
            //       · 全文分支（`mode === 'full'`）⇒ true
            //       · 按节读 ⇒ false，但把节名累积进 `sections`
            //       ⇒ 逐节读完整篇也算数（见 `docsReadSufficient`）。
            if (decision.content.trim() !== '') {
              try {
                const sid = sessionIdOf(exec.agent)
                // ⭐ **轮次号**（决策 112）：读记录的有效期粒度是"一个完整轮次"。
                const turn = turnOf(ctx, exec.agent)
                const prev = await findDocRead(sid, projectId, turn)
                // ⭐ 本次是否"读到了全文"：
                //    · `full` 模式 ⇒ 是；
                //    · 此前**同一轮内**已读过全文 ⇒ 记着（不因这次按节读而退回 false）。
                const isFull = decision.mode === 'full' || (prev?.full ?? false)
                // ⭐ **累积"读到过的节名"**（只累积同轮内的）：
                //    `decideRead` 在命中时会把**全部节名**放进 `availableSections`，
                //    但本次真正返回内容的只有 `sectionRequested` 命中的那些
                //    ⇒ 用与 `extractSection` 相同的匹配规则筛一遍，才准。
                const seen = new Set(prev?.sections ?? [])
                // 🔴🔴 **`lines` 模式也要累积节名**（决策 134 的连带修复）：
                //    带 `offset`/`limit` 读**某一节**时，`decideRead` 返回的 `mode` 是 `'lines'`
                //    ⇒ 原判据只认 `'section'` ⇒ **这一节根本没被记进读记录**
                //    ⇒ 逐节读完了，闸门仍报"没读全"（**实测踩到**：
                //      我用 `section` + `offset/limit` 读完「有效做法」「失败/踩坑」，
                //      下一次 handoff 仍被拒，说还差这两节）。
                //    ⚠️ 判据要落在"**本次是否真的取到了某一节的内容**"，而不是"用了哪个模式"：
                //       · `section` 命中（`mode==='section'`）⇒ 取到了；
                //       · `section` + `offset/limit`（`mode==='lines'`）⇒ 也取到了；
                //       · `section` **没命中**（回退成全文行号）⇒ **没取到，不许累积**（否则假绿）。
                if (decision.sectionMatched && decision.sectionRequested.trim() !== '') {
                  const key = decision.sectionRequested.trim().toLowerCase()
                  for (const t of decision.availableSections) {
                    if (t.toLowerCase().includes(key)) seen.add(t)
                  }
                }
                await appendDocRead(sid, {
                  project: projectId,
                  turn,
                  readAt: new Date().toISOString(),
                  full: isFull,
                  sections: [...seen],
                })
              } catch {
                /* 记记录失败不该让读取失败 */
              }
            }

            // ⭐⭐⭐ **原「按需注入写作指导」已退役**（2026-10-12，模板与提示词解耦）。
            //
            // 🔴🔴 **为什么删掉它**：规范现在**就写在这份文档自己的正文里**
            //    （叙事末尾的 `## 本档写作规范` 一节，由 `handoff` 落盘时维护）
            //    ⇒ `decision.content` **本来就带着它**（`memj_read` 读的是正文）。
            //    ⚠️ 再附一份就是**同一事实的第二份副本** —— 而本项目的判据是
            //    "同一事实被两条路维护 ⇒ 必然漂开"，且这两个副本会**同时出现在返回值里**
            //    （模型看到两份可能不一致的规范）。
            //
            // ⭐ 净收益：少一次 `loadProjectDoc` + `listTemplates` 的读盘、
            //    少 8 条提示词（`tpl:guidance-*` 5 条 + `tpl:notice-*` 3 条）、
            //    少一个"模板被删就得走 fallback"的分支。
            //
            // ⚠️ **但 `tpl:*` 那 8 条**仍被 `renderSpecSection()` 用着
            //    （它们现在是"渲染那一节"的骨架）⇒ 提示词账本里**继续保留**，
            //    只是不再有"读文档时额外附一份"这条通路。

            // ⭐⭐⭐ **决策 222：规范清单改成【按需】给，不再每次阅读都附。**
            //
            // 🔴🔴 **为什么改**（用户 2026-10-12 当场否掉旧位置）：
            //    *"现在他每一次阅读全都要给他一遍，这有点奇怪吧"* —— 三点都对：
            //    ① **无条件**：读一条知识、查一个事实，也带上整份规范清单；
            //    ② **重复**：一次交接要逐节读文档 ⇒ **同一份清单被给 7 遍**（实测）；
            //    ③ **位置错**：它是"**要写的时候**才需要"的东西，却挂在"读"上。
            //    🔴 更要紧的是它**会自我失效** —— 库里已有判据：
            //      **一个总在报警的警报，与没有警报等价**（每轮都刷 ⇒ 变背景音 ⇒ 等于没给）。
            //
            // ⭐ **现在只在 `full`（整篇读）时给一次**：
            //    整篇读通常发生在"准备大改这份文档"时，那一刻逐节对照规范是合适的；
            //    而**按节读**（写某一节前的常规动作）**不再附带** —— 要改的那一节，
            //    它的规范本来就在返回内容的开头。
            // ⚠️ **真正为"该整理"提供触发点的是 `memj_handoff` 的回执**（决策 222 的另一半）：
            //    ⭐ 原因见 `reads.ts` 那段注释 —— **看得见 ≠ 会去做**
            //    （同一个会话里我看过清单、也量过「目标」节，却只把它写成了"给用户的汇报"）。
            const specBlock = decision.mode === 'full'
              ? renderSectionSpecs(sectionSpecsOf(pdoc.narrative))
              : ''

            return {
              found: true,
              id: projectId,
              title: `项目交接文档 ${projectId}`,
              mode: decision.mode,
              // ⭐ 规范就在正文里（见上面的退役说明）⇒ **原样返回 `decision.content`**。
              content: decision.content,
              // ⭐ 集中版的规范清单（决策 222：**只在整篇读时非空**）——渲染时**排在正文之前**。
              sectionSpecs: specBlock,
              availableSections: decision.availableSections,
              sectionGroups: decision.sectionGroups,
              sectionRequested: decision.sectionRequested,
              sectionMatched: decision.sectionMatched,
              size: decision.size,
              notice: decision.notice,
            }
          }

          // ⚠️ 两个入口都没给 ⇒ 说清该给哪个（**不报错退出，给可执行的下一步**）。
          if (id === undefined || id.trim() === '') {
            return {
              found: false, id: '', title: '', mode: 'not-found', content: '',
              sectionGroups: [],
              availableSections: [], sectionRequested: '', sectionMatched: false,
              size: 0, sectionSpecs: '',
              notice:
                '要给 `id`（知识条目的 UUID，来自 memj_search）' +
                '或 `project`（项目文档 id，如 `dsh-memj`）其中之一。',
            }
          }

          // ⭐⭐ **必须"含归档 + 含历史"地找**：
          //    · **归档**（决策 133）：归档条目不在默认快照里，但**要能找到**才能给出
          //      "已归档"这句**准确**回执——否则会误报成"库里没有该 id"。
          //    · **历史**（决策 136）：`kind:'history'` 默认**不参与检索**，
          //      但「历史进展」小节里的**指针就是指向它的** ⇒ 🔴 **读侧必须能拿到**，
          //      否则那行指针形同虚设（"拿着指针读不回来"）。
          const snapshot = await scanLibrary({ includeArchived: true, includeHistory: true })
          const found = snapshot.covers.find((c) => c.cover.id === id)
          if (found !== undefined && (found.cover.archivedAt ?? '') !== '') {
            // ⚠️ 回执文案是**用户指定的**：*"回执该条目已归档，信息不可用。"*
            return {
              found: false, id, title: found.cover.title, mode: 'archived', content: '',
              sectionGroups: [],
              availableSections: [], sectionRequested: '', sectionMatched: false,
              size: 0, sectionSpecs: '',
              notice: `该条目**已归档**，信息不可用（归档时间 ${found.cover.archivedAt}）。`,
            }
          }
          if (found === undefined) {
            return {
              found: false, id, title: '', mode: 'not-found', content: '',
              sectionGroups: [],
              availableSections: [], sectionRequested: '', sectionMatched: false,
              size: 0, sectionSpecs: '', notice: '',
            }
          }
          const cover = found.cover
          const abs = resolveRef(cover.ref, cover.ext)
          const doc = abs === undefined ? undefined : await loadEntryDoc(cover.ref, cover.ext)
          if (doc === undefined) {
            return {
              found: false, id, title: '', mode: 'body-missing', content: '',
              sectionGroups: [],
              availableSections: [], sectionRequested: '', sectionMatched: false,
              size: 0, sectionSpecs: '',
              notice:
                `封面存在但正文读不到：${cover.ref}` +
                (cover.ext
                  // ⭐⭐⭐ 安全评审 F3：外部引用现在**还要过白名单**（`MEMJ_EXT_ROOTS`）。
                  //     ⚠️ 措辞必须把"被安全闸拒了"与"文件没了"分开 —— 否则用户会去翻文件，
                  //        而他真正该做的是配那个环境变量（或者把文件挪进库）。
                  ? '（外部引用：文件可能已被移动/删除，**或者不在 `MEMJ_EXT_ROOTS` 允许的根之内**被安全闸拒绝。' +
                    '要让这个引用可读：把它挪进库里，或把它的**所在目录**加进 `MEMJ_EXT_ROOTS`）'
                  : ''),
            }
          }

          const decision = decideRead(doc.body, {
            section,
            full,
            offset,
            limit,
            maxChars: config.readFullMaxChars,
          })

          // ⭐ 成功读到正文 ⇒ 记一条读快照（§3.8）。
          //    ⚠️ **只在真的拿到了正文时记**——只回节名清单不算"读到了"。
          if (decision.content.trim() !== '') {
            const ownerProject = cover.project === '' ? undefined : await loadProjectDoc(cover.project)
            try {
              await recordRead(sessionIdOf(exec.agent), {
                entryId: cover.id,
                title: doc.title,
                desc: cover.desc,
                theme: cover.theme,
                project: cover.project,
                owner: {
                  title: ownerProject?.frontmatter.project ?? '',
                  desc: ownerProject?.frontmatter.desc ?? '',
                },
              })
            } catch {
              /* 记快照失败不该让读取失败 */
            }
          }

          return {
            found: true,
            id,
            title: doc.title,
            mode: decision.mode,
            content: decision.content,
            // ⚠️ 读**知识条目**时恒为空串（规范清单只对项目文档有意义）——
            //    schema 里它是 `required` ⇒ 这个字段必须出现（决策 221）。
            sectionSpecs: '',
            availableSections: decision.availableSections,
            sectionGroups: decision.sectionGroups,
            sectionRequested: decision.sectionRequested,
            sectionMatched: decision.sectionMatched,
            size: decision.size,
            notice: decision.notice,
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // memj_snapshots —— 只读本会话的读快照清单（决策 79 新增）
  // ══════════════════════════════════════════════════════════════════════
  //
  // 🔴 **它为什么必须存在**：决策 77 要求 LLM 逐条判断"这条快照确实和本次项目
  //    相关吗"（读了 ≠ 用上了），但原六个工具**没有任何一个把这份清单交给它**。
  //    ⇒ 模型被要求判断，却拿不到要判断的东西。本工具补上这个缺口。
  safeRegister(
    'memj_snapshots',
    () =>
      defineTool({
        name: 'memj_snapshots',
        description: MEMJ_SNAPSHOTS_DESCRIPTION,
        parameters: {
          project: {
            type: 'string',
            required: true,
            description:
              '本次要落盘的**目标项目 id**。工具据此筛出 `快照.project ≠ project` 的那些（跨项目证据）。' +
              '🔴 **必须先用 memj_info 判断好"更新还是新建项目"、拿到 id 之后再来调本工具**。',
          },
          scope: {
            type: 'string',
            enum: ['cross', 'all'],
            description:
              "'cross'（默认）只回**别项目**的快照（project ≠ 传入值）；'all' 连本项目自己的也回。",
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              entries: {
                type: 'array',
                required: true,
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    entryId: { type: 'string', required: true },
                    title: { type: 'string', required: true },
                    desc: { type: 'string', required: true },
                    theme: { type: 'string', required: true },
                    project: { type: 'string', required: true },
                    ownerTitle: { type: 'string', required: true },
                    ownerDesc: { type: 'string', required: true },
                    readAt: { type: 'string', required: true },
                  },
                },
              },
              total: { type: 'integer', required: true },
              hint: { type: 'string', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as {
              entries: Array<{
                entryId: string; title: string; desc: string; theme: string
                project: string; ownerTitle: string; ownerDesc: string
              }>
              total: number
              hint: string
            }
            // ⭐ **模式是返回值里说的，不是提示词里写的**（决策 96）。
            //    这样协议/描述可以**中性、只有一份**，模式一变不必重写 node 0。
            const loose = config.themeCreation === 'loose'
            const modeLine = loose
              ? '📋 **本实例的校验模式：宽松**——工具**不校验跨项目证据**，是否新建主题**由你判断**。'
              : '📋 **本实例的校验模式：严格**——新建主题**必须有跨项目证据**（见下）。'
            if (v.entries.length === 0) {
              return [
                {
                  type: 'text',
                  text:
                    modeLine +
                    '\n\n本会话**没有读过别的项目**的知识（按当前 scope 没有未消费的快照）。\n' +
                    (loose
                      ? '⇒ 本实例是**宽松模式**，这**不妨碍你新建主题**（工具不做该校验）；' +
                        '仍可挂靠本项目已关联的主题（挂靠无门槛）。'
                      : '⇒ 本次**没有跨项目证据**，因此**不能新建主题**；' +
                        '仍可挂靠本项目已关联的主题（挂靠无门槛）。'),
                },
              ]
            }
            const byProject = new Map<string, typeof v.entries>()
            for (const e of v.entries) {
              const key = e.project === '' ? '(无项目归属)' : e.project
              const list = byProject.get(key)
              if (list === undefined) byProject.set(key, [e])
              else list.push(e)
            }
            const parts: string[] = [modeLine, '', `本会话读过 ${v.total} 条知识（按来源项目分组）：`]
            for (const [project, list] of byProject) {
              parts.push('', `- 来源项目 \`${project}\`（${list[0]?.ownerTitle ?? ''}）`)
              for (const e of list) {
                parts.push(
                  `  · \`${e.entryId}\` **${e.title}** — ${e.desc}` +
                    (e.theme === '' ? '' : `（已挂主题：${e.theme}）`),
                )
              }
            }
            parts.push('', v.hint)
            return [{ type: 'text', text: parts.join('\n') }]
          },
        },
        async execute(args, exec) {
          const { project, scope } = args as { project: string; scope?: string }
          const target = (project ?? '').trim()
          const sessionId = sessionIdOf(exec.agent)
          const all = await pendingSnapshots(sessionId)

          // 🔴 **"快照.project ≠ 本次 project" 这处唯一校验，在工具内完成**
          //    （决策 76）——传了 project 才有比较基准，否则"别项目"无从判定。
          //    `cross`（默认）⇒ 只回别项目的；`all` ⇒ 本项目自己的也回。
          const entries =
            scope === 'all'
              ? all
              : all.filter((s) => s.project !== '' && s.project !== target)

          return {
            entries: entries.map((s) => ({
              entryId: s.entryId,
              title: s.title,
              desc: s.desc,
              theme: s.theme.join(', '),
              project: s.project,
              ownerTitle: s.owner.title,
              ownerDesc: s.owner.desc,
              readAt: s.readAt,
            })),
            total: entries.length,
            hint:
              `以上是本会话读过的、且**不属于项目 \`${target}\`** 的知识` +
              `（按来源项目分组；工具已替你完成"快照.项目 ≠ ${target}"这处比较）。\n\n` +
              '🔴 **逐条判断"它确实和本次要落盘的项目相关吗"**——「读过」不等于「用上了」；' +
              '顺手翻到的、探索性读的都要排除。\n' +
              '通过判断的那些，就是"跨项目复用"的证据：若其中某条与本次知识属**同一语义范畴**，' +
              '可用 `memj_handoff` 的 `newThemes` 新建主题（别的项目 A + 本次项目 B ⇒ 已经是 2 个项目，' +
              '不需要再数什么）。\n' +
              (config.themeCreation === 'loose'
                ? '⚠️ 但**本实例是宽松模式**：新建主题**不要求**这些证据，由你判断即可。'
                : '⚠️ **本实例是严格模式**：**没有通过判断的快照 ⇒ 不要新建主题**，' +
                  '留在项目层或挂靠本项目已关联的主题即可。'),
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // memj_handoff —— 唯一写入入口
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_handoff',
    () =>
      defineTool({
        name: 'memj_handoff',
        description: MEMJ_HANDOFF_DESCRIPTION,
        parameters: {
          project: { type: 'string', required: true, description: '项目 id；已存在则更新，不存在则新建。' },
          step: {
            // ⭐ 单值或数组都接受（决策 101 / §3.11.2）。
            //    ⚠️ 用 `oneOf` 而不是只给 array：设计明确"允许数组"，
            //    但**单个值**是最自然的写法（`step: 'knowledge'`），不该逼模型写成单元素数组。
            oneOf: [
              { type: 'string', enum: ['narrative', 'theme', 'knowledge', 'all'] },
              { type: 'array', items: { type: 'string', enum: ['narrative', 'theme', 'knowledge', 'all'] } },
            ],
            description:
              '⭐ **本次做哪几步**（决策 101）。可给单个值，也可给数组；**缺省 = `all`**。\n' +
              '· `narrative` 只写项目叙事（`doc` / `projectDesc`）\n' +
              '· `theme` 只建主题（`newThemes`）\n' +
              '· `knowledge` 只落知识（`entries` / `adopt`）\n' +
              '· `all` 全部（缺省，等价于以前的一次完整 handoff）\n' +
              '🔴 **执行顺序固定** narrative → theme → knowledge，**与数组顺序无关**。\n' +
              '💡 用途：只想补一条知识而不重写叙事 ⇒ `step: \'knowledge\'`。\n' +
              '🔴 **没有"欠账"**：`step` 没列的步骤**不在本次范围**——回执会列出它们并' +
              '**明确说"不要为补齐再调一次"**（⚠️ 分步之间无原子性，可能留下"半套"）。\n' +
              '⚠️ 参数必须与 step 一致：传了不属于本次 step 的参数（如 step 不含 narrative 却给 `doc`）' +
              '会被**直接拒绝**，而不是静默忽略。',
          },
          projectDesc: { type: 'string', description: '项目描述（新建该项目时必填，≤200 字符）。' },
          // ⭐⭐ **2026-10-07 补暴露**：`template` 在 `HandoffRequest`（handoff.ts）里
          //    与 `runHandoff` 的实现里**一直都在**，但**从没进过这份 schema** ⇒
          //    模型看不到它、也就无从在"新建项目"时挑模板。
          //    实测后果：库里明明有 `company-deep-research` 这类自定义模板，
          //    新建项目却**只能**落到默认六节，且没有任何环节会问一句 ——
          //    用户 2026-10-07 就是照这个现象问上来的。
          //    ⚠️ 之所以现在才发现：`memj_template` 的说明里写着"在 `memj_handoff` 里传
          //    `template`"，两边对不上，而**没有任何机制校验"文档说要传的参数真的存在"**
          //    （`scripts/shared/prompt-ledger.mjs` 只对账**工具名**，不对账参数）。
          //
          // ⚠️ **本字段属于"参数说明"** ⇒ 按决策 124「能搬就必须搬」，说明写在这里，
          //    **不占 `MEMJ_HANDOFF_DESCRIPTION` 的 5200 预算**（那条判据见
          //    `scripts/test-prompt-split.mjs`：它是**软阈值**，不是保存硬校验）。
          //
          // ⚠️ 行为**只在新建项目那一刻有效**：项目已存在 ⇒ 本参数**被忽略**
          //    （`handoff.ts:399-403`，用户 2026-09-30 裁定"模板绝不回溯已有文档"）。
          template: {
            type: 'string',
            description:
              '⭐ **新建项目时用哪份交接文档模板**（决定建档的节名与节数）；**缺省 = `default`**。\n' +
              '🔴 **只在「新建项目」那一刻有效**：项目**已存在** ⇒ 本参数**被忽略** ⇒\n' +
              '   **模板绝不回溯已有文档**（要换结构只能新建项目，这是有意的）。\n' +
              '📋 **有哪些可选**：用 `memj_template({ action: \'list\' })` 查（每份都有 id 与节清单）。\n' +
              '⚠️ 传了不存在的 id ⇒ 工具会报错并列出可用模板，**不会静默回落**。\n' +
              '💡 **什么时候该挑**：当本次要建的项目明显属于某类已有专门模板时\n' +
              '   （例如公司深度研究用 `company-deep-research`）⇒ **先 list 再挑**，\n' +
              '   或**问用户**要用哪份；别默认套六节。',
          },
          doc: {
            type: 'string',
            description:
              'handoff 文档的叙事（markdown，按该项目的节清单写）。\n' +
              '⚠️ **节名不是固定的**——由建档时的模板决定，回执会回声本项目节名清单。\n' +
              '⭐ **给了 `docSection` 时**：这里只写**该节要变的那部分**' +
              '（`append`/`prepend` 时**不要带节标题**，工具会加）；\n' +
              '**没给 `docSection` 时**：按 `##` 节名对号入座，写了的那一节**整节替换**' +
              '（⚠️ 此时必须给出该节的**完整内容**，否则原有内容会丢）。',
          },
          // ⭐⭐ **按节写**（决策 134）——长文档的**唯一可行方式**：
          //    旧路径的最小单位是整个顶层节（实测「当前进度」28,750 字符），
          //    逐字重写超出单次输出能力；而**压缩**（归并/降级）本质是"换"与"删"，
          //    追加或整节重写都做不了。
          docSection: {
            type: 'string',
            description:
              '⭐ **只写某一节**（节名，同 `memj_read` 的 `section` 规则：子串匹配、大小写不敏感）。\n' +
              '顶层 `##` 节与 `###` 子节都可以（⚠️ 节名有歧义时会报错并列出候选）。\n' +
              '🔴 **文档很长时用它可以只产出一段**——不必逐字重写整节。\n' +
              '💡 该用哪一节：先 `memj_read({ project })`，回执里会给出**每节的字符数**。\n' +
              '⚠️ 找不到该节 ⇒ 报错并提示；**不会**猜、也不会新建。',
          },
          docOp: {
            type: 'string',
            enum: ['append', 'prepend', 'replace', 'drop'],
            description:
              '配合 `docSection` 使用，**缺省 `append`**：\n' +
              '· `append` 追加到该节**末尾**（新增进展）\n' +
              '· `prepend` 追加到该节**开头**（新增进展、放最前）\n' +
              '· `replace` **替换**该节（给出的必须是**该节完整新内容**）\n' +
              '· `drop` **删除**该节\n' +
              '🔴 **缺省是 `append` 是故意的**：忘给参数时**只会追加、不会覆盖**' +
              '（要覆盖必须显式说 `replace`）。\n' +
              // 🔴🔴 决策 223 之后这句曾**反向误导**（2026-10-09 修）：
              //   旧文案写着"**瘦身不用你做**：`memj_handoff` 会**自动**把较早的小节截走
              //   ⇒ ⛔ **不要为了"压缩"而手工 `replace`/`drop`**" ——
              //   而工具**已经不再自动归档**了，手工做它**正是现在唯一正确的做法**
              //   ⇒ 那条在**劝退模型做唯一该做的事**（比"过时"更坏：它是反向指引）。
              //   ⭐ 现在是：**瘦身就是你的事**，规则写在各节规范里（工具只报数）。
              // 🔴 **2026-10-09 补指路**：这里只讲"参数怎么用"，**完整流程不在这**
              //   （它归运行时上下文的「文档瘦身 / 归档」那一节，决策 124 的分层）。
              //   ⚠️ 但仍要点名两个**与本参数直接相关**的坑 —— 它们正是用错这个参数造成的。
              '⭐ **文档瘦身/归档由你按各节规范执行**（决策 223）：规则写在**各节规范里**' +
              '（自然语言），**工具不会替你归档**。超阈值时**就用 `replace`/`drop` 动手**。\n' +
              '⭐ **完整四步流程见运行时上下文「文档瘦身 / 归档」**；⚠️ 尤其别拿 `replace`' +
              '去改「历史进展」那种**累积容器**（它的语义是**替换整节** ⇒ 会抹掉已有指针）。\n' +
              '⚠️ 追加时 `doc` 只给正文片段、**不要带节标题**；' +
              '`drop` 后若留下空壳节，回执会报警（工具分不清"故意删空"与"误删"）。',
          },
          entries: {
            type: 'array',
            description: '要落盘的知识（会话总结出的）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true, description: '英文短名（从标题翻译），全小写英文/数字/连字符，2–48 字符。' },
                title: {
                  type: 'string',
                  required: true,
                  description:
                    '知识标题（**必填**，2–48 字符的具体名词短语）。⭐ **它是封面的字段**——' +
                    '检索时不必打开正文就能拿到标题，所以**必须自己给**。' +
                    '内部条目通常与正文首个 `###` 同句（正文里那份**可以保留**，不必删）。' +
                    '⚠️ 不要写成整句话或摘要——它是标题，`desc` 才承担"这条讲什么、何时读"。',
                },
                desc: { type: 'string', required: true, description: '检索键（不是摘要），≤200 字符。' },
                body: {
                  type: 'string',
                  required: true,
                  description:
                    '正文 markdown。' +
                    '⭐ **外部引用（`ext: true`）也要给**：那种情况写 **200 字以内的摘要**' +
                    '（说清那份库外文件讲了什么），⛔ **不要贴全文**。',
                },
                overwrite: {
                  type: 'boolean',
                  description:
                    '⭐ **同 `slug` 已存在时是否覆盖**（默认 `false`）。\n' +
                    '· 缺省 ⇒ **拒绝**并提示"已存在"（**不静默覆盖**）；\n' +
                    '· `true` ⇒ **就地替换**那条知识（不产生第二个文件）。\n' +
                    '⚠️ 这是为了防**重复写入**：同一入参重发（网络重试、分步补写）\n' +
                    '本该幂等，而原先会写出两条知识。',
                },
                kind: {
                  // ⭐⭐ 决策 215：enum 每轮现算（词表运行期可配）。
                  ...kindParam(
                    () =>
                      `形态分类（**可选**）：${kindsInline()}。` +
                      // 🔴 原文写死「**只能填这 4 个值**」—— 用户加第 5 个类型它就在撒谎。
                      '留空合法。它决定正文用哪种骨架，也便于按类型筛选。' +
                      '⚠️ 与 theme 无关：theme 是"属于谁"，kind 是"本身是什么形态"。',
                  ),
                },
                tags: { type: 'array', required: true, items: { type: 'string' }, description: '至少 1 个。' },
                theme: { type: 'array', items: { type: 'string' }, description: '要挂靠的主题 id（只能填已存在的）。' },
                themeWhy: {
                  type: 'string',
                  description:
                    '⭐ **挂了 `theme` 就要给依据**（没挂则不需要）。\n' +
                    '写法：**引一句该主题 `desc` 里的话** + 说明这条知识**怎么服务那个 desc 描述的场景**。\n' +
                    '⚠️ 工具会检查你引的那句**确实逐字出现在该主题 desc 里**（≥12 字符连续片段）；\n' +
                    '引不出来 ⇒ 回执**警告**（不拒收，但别当没看见）。\n' +
                    '🔴 **判据**：这条知识**对「该主题 desc 描述的场景下的别的项目」有用**吗？\n' +
                    '只对本项目成立（讲的是本项目自己的某次改动/接口/缺陷/实测数据）⇒ **别挂**。',
                },
                global: { type: 'boolean', description: '是否申请加入全局（只登记提名；封面 global 保持 false，批准时才置位，待用户批准）。' },
                ref: {
                  type: 'string',
                  description:
                    '⭐ **只引用不搬动时必填**：库外文档的**绝对路径**（须与 `ext: true` 同时给）。' +
                    '⚠️ **落库条目不要填它**——那种情况 `ref` 由工具按 `<slug>-<uuid8>.md` 自动生成。',
                },
                ext: {
                  type: 'boolean',
                  description:
                    '⭐ `true` = **外部引用**（**只建封面、不搬动库外文件**，正文永远留在原处）。' +
                    '⚠️ 与 `adopt` 的区别：`adopt` 是**入库**（把正文收进库）；本字段是**只引用**。' +
                    '⚠️ 置 `true` 时必须给 `ref`（绝对路径）；`body` **仍要填**，' +
                    '但写的是 **200 字以内的摘要**（⛔ 不是全文）——正文一律留在库外那个文件里。',
                },
              },
            },
          },
          newThemes: {
            type: 'array',
            description: '本次要新建的主题（id + desc）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                desc: { type: 'string', required: true, description: '主题描述，≤200 字符。' },
              },
            },
          },
          // ⭐⭐ **准挂表**（决策 111）：只补挂列出的快照，省略 = 不挂。
          linkedSnapshots: {
            type: 'array',
            items: { type: 'string' },
            description:
              '**只补挂这些快照**（别项目 entry id 数组，用 memj_snapshots 取）。' +
              '🔴 **省略 = 一条都不挂**（fail-closed）：先逐条判断"它确实和本次相关吗"，' +
              '把相关的列进来；不相关的**不要列**。⚠️ 回执会回声实际补挂了哪几条。',
          },
          adopt: {
            type: 'array',
            description: '入库外部文档（copy = 工具自己读全文；extract = 用 body 作为正文）。',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                slug: { type: 'string', required: true },
                title: {
                  type: 'string',
                  required: true,
                  description:
                    '入库条目的标题（**必填**，2–48 字符）。⚠️ **外部引用也要自己写**——' +
                    '以前靠"读正文首个 `#`"现算，那要求每次检索都打开外部文件。',
                },
                ref: { type: 'string', required: true, description: '外部文档的绝对路径。' },
                mode: { type: 'string', required: true, enum: ['copy', 'extract'] },
                body: { type: 'string', description: "mode='extract' 时的正文。" },
                desc: { type: 'string', required: true },
                kind: {
                  ...kindParam(() => `形态分类（可选），同 entries[].kind。可选：${selectableKindList('、')}。`),
                },
                tags: { type: 'array', required: true, items: { type: 'string' } },
                theme: { type: 'array', items: { type: 'string' } },
                global: { type: 'boolean' },
                overwrite: {
                  type: 'boolean',
                  description:
                    '⭐ 同 `slug` 已存在时是否覆盖（默认 `false`）。语义与 `entries[].overwrite` 相同。',
                },
              },
            },
          },
          confirmCreate: { type: 'boolean', description: '确认新建项目（命中相似 id 时必须带 true）。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              createdProject: { type: 'boolean', required: true },
              createdThemes: { type: 'array', required: true, items: { type: 'string' } },
              snapshotCount: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as { ok: boolean; message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute(args, exec) {
          const r = await runHandoff(args as Parameters<typeof runHandoff>[0], {
            sessionId: sessionIdOf(exec.agent),
            // ⭐ 轮次号（决策 112）：读记录的有效期是"一个完整轮次"。
            turn: turnOf(ctx, exec.agent),
            config,
          })
          // 🔴🔴 **校验失败必须"抛"，不能只返回 `ok:false`**（2026-09-19 真实实例验收抓到的 bug）。
          //    工具管线的 `isError` **只由抛异常产生**（见 `ToolExecutionFailure`）——
          //    返回 `{ok:false}` 会被当成**一次成功的工具调用**，
          //    模型看到的是"工具跑完了"，而**不是"我错了、要改"**。
          //    ⚠️ 这与本项目"失败要显式、不能静默"的一贯立场完全一致：
          //    拒了却不吭声，等于没拒。
          if (!r.ok) {
            throw new Error(r.message)
          }

          // ⭐⭐⭐ **记一笔"这个会话在做哪个项目"**（2026-09-22 用户要求）。
          //
          // 🔴 **为什么这条判据最强**：`memj_handoff` 的入参里**明写着 `project`**
          //    —— 是**模型自己声明**的在做哪个项目，而且它**真的写了那个项目的文档**。
          //    比 `doc-reads`（读了文档）与 `get-handoff`（人要了上下文）**都直接**。
          //
          // 🔴 **为什么必须记**：用户实测报告 —— 某会话**做过 5 次 `memj_handoff`**
          //    （含一次"建立项目"的交接），但自动判定**判不出项目**，
          //    因为这条路径**以前什么都不写**。
          //
          // ⚠️ **失败不影响工具**：交接已经写成功了，那是主职责。
          // ⚠️ **取最新一次**：用户裁定"符合预期"（会话中途换项目 ⇒ 认最近那个）。
          try {
            const pid = typeof (args as { project?: unknown }).project === 'string'
              ? ((args as { project: string }).project).trim()
              : ''
            if (pid !== '') {
              const sid = sessionIdOf(exec.agent)
              await appendDocRead(sid, {
                project: pid,
                turn: turnOf(ctx, exec.agent),
                readAt: new Date().toISOString(),
                full: true,
                sections: [],
                via: 'handoff',
              })
            }
          } catch {
            /* 只是判定用的线索，记不上不该让工具失败 */
          }

          // ⭐⭐ **英文召回索引：落盘成功后触发一次后台重建**（设计文档 §9.3）。
          //
          // 🔴 **fire-and-forget —— 不 await、不抛**：索引是**派生数据**，
          //    它失败**不该影响 handoff 成败**（与上面"记 doc-read"同款处置）。
          // ⚠️ 总开关关着时 `trigger` 内部**立刻返回**（不读库、不调模型）。
          // ⚠️ 重建里只翻「新增 / `descHash` 过期」的条目 ⇒ 通常只有几条。
          try {
            triggerEnIndexRebuild(ctx, config, 'handoff')
          } catch {
            /* 索引重建失败不影响交接 */
          }

          // 🔴 **只返回 schema 声明过的字段**。
          //    `output.schema` 是 `additionalProperties: false`，多带字段会被
          //    运行时校验直接拒收（整次调用失败，报 "value.X is not a declared property"）。
          //    `issues` / `similarProjects` / `similarThemes` 的**内容已写进 `message`**，
          //    不必也不该另开字段透出。
          return {
            ok: r.ok,
            message: r.message,
            createdProject: r.createdProject,
            createdThemes: r.createdThemes,
            snapshotCount: r.snapshotCount,
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // memj_promote —— 归属推进（辅助）
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_promote',
    () =>
      defineTool({
        name: 'memj_promote',
        description: MEMJ_PROMOTE_DESCRIPTION,
        parameters: {
          refs: {
            type: 'array',
            items: { type: 'string' },
            description:
              '要推进/修改的封面 id（UUID）数组。⚠️ **项目/主题级操作（`action`）不需要它**。',
          },
          addThemes: {
            type: 'array',
            items: { type: 'string' },
            description:
              '要**追加**的主题 id 数组。⚠️ **只能填已存在的主题 id**——本工具**不新建主题**' +
              '（新建主题请走 memj_handoff 的 newThemes）。',
          },
          removeThemes: {
            type: 'array',
            items: { type: 'string' },
            description:
              '⭐ **要移除**的主题 id 数组（**挂错了用这个**，决策 114）。' +
              '⚠️ 与 `addThemes` 同为**累加语义**：只动 `theme`，**不碰** `project` / `global`。',
          },
          setFields: {
            type: 'object',
            additionalProperties: false,
            description:
              '⭐ **改封面的字段**（决策 114）。⚠️ **只改你给的字段**，没给的保持不变——' +
              '**不是**整份替换。',
            properties: {
              title: { type: 'string', description: '新标题（2–48 字符）。' },
              desc: { type: 'string', description: '新描述（≤200，检索键）。' },
              tags: { type: 'array', items: { type: 'string' }, description: '新标签（至少 1 个）。' },
              kind: {
                ...kindParam(
                  () =>
                    `形态分类（受控词表：${selectableKindList('、')}）。` +
                    '⚠️ **这是 `kind` 的修改通道**（以前写完只能手工改库文件）。',
                ),
              },
            },
          },
          setGlobal: {
            type: 'boolean',
            description:
              '`true` = **登记待批提名**（封面 `global` 保持 false，批准时才置位；工具不会自己批准）；`false` = **取消** 并清掉提名、把 `global` 置回 false。',
          },
          action: {
            type: 'object',
            additionalProperties: false,
            description:
              '⭐ **项目 / 主题级操作**（决策 114）。⚠️ 与 `refs` 互斥——它作用于项目/主题本身，不是单个封面。',
            properties: {
              kind: {
                type: 'string',
                enum: [
                  'setProjectFields',
                  'setProjectDesc',
                  'renameProject',
                  'deleteProject',
                  'setThemeFields',
                  'setThemeDesc',
                  'renameTheme',
                  'deleteTheme',
                  'deleteEntry',
                ],
                description:
                  '要做的操作。🔴 `delete*` **只允许删空容器**（旗下还有知识/引用 ⇒ 拒绝，' +
                  '**不级联删**）；`rename*` 是**先建后删**（中途失败不丢数据）。' +
                  '⭐ 注意：**只改显示名请用 `setProjectFields` / `setThemeFields`**' +
                  '（它们改的是 `title`，**不动 id**，因而不影响任何引用）。',
              },
              id: { type: 'string', description: '目标 id（项目 / 主题 / 封面）。' },
              newId: { type: 'string', description: '`rename*` 时的新 id。' },
              title: {
                type: 'string',
                description:
                  '⭐ **显示名**（决策 115）：`setProjectFields` / `setThemeFields` 用。' +
                  '⚠️ 它**不是 id**——改它不影响任何引用。空串 = 清空（回落成显示 id）。',
              },
              desc: { type: 'string', description: '`setProject(Theme)Fields` / `setProjectDesc` / `setThemeDesc` 的新描述（≤200）。' },
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              updated: { type: 'array', required: true, items: { type: 'string' } },
            },
          },
          render: (_args, value) => {
            const v = value as { message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute(args) {
          const { refs, addThemes, removeThemes, setFields, setGlobal, action } = args as {
            refs?: string[]
            addThemes?: string[]
            removeThemes?: string[]
            setFields?: { title?: string; desc?: string; tags?: string[]; kind?: string }
            setGlobal?: boolean
            action?: { kind?: string; id?: string; newId?: string; title?: string; desc?: string }
          }

          // ══════════════════════════════════════════════════════════════
          // ⭐⭐ **项目 / 主题级操作**（决策 114 / 115）——与 `refs` 是两条路
          // ══════════════════════════════════════════════════════════════
          if (action !== undefined && typeof action.kind === 'string' && action.kind !== '') {
            const id = (action.id ?? '').trim()
            const newId = (action.newId ?? '').trim()
            const desc = action.desc ?? ''
            const title = action.title ?? ''
            if (id === '') return { ok: false, message: '`action.id` 不能为空。', updated: [] }
            let r: Awaited<ReturnType<typeof deleteEntry>>
            switch (action.kind) {
              case 'setProjectFields':
                r = await setProjectFields(id, {
                  ...(action.title !== undefined ? { title } : {}),
                  ...(action.desc !== undefined ? { desc } : {}),
                })
                break
              case 'setProjectDesc': r = await setProjectDesc(id, desc); break
              case 'renameProject': r = await renameProject(id, newId); break
              case 'deleteProject': r = await deleteProject(id); break
              case 'setThemeFields':
                r = await setThemeFields(id, {
                  ...(action.title !== undefined ? { title } : {}),
                  ...(action.desc !== undefined ? { desc } : {}),
                })
                break
              case 'setThemeDesc': r = await setThemeDesc(id, desc); break
              case 'renameTheme': r = await renameTheme(id, newId); break
              case 'deleteTheme': r = await deleteTheme(id); break
              case 'deleteEntry': r = await deleteEntry(id); break
              default:
                return {
                  ok: false,
                  message:
                    `未知的 action.kind：\`${action.kind}\`。\n` +
                    '可用：setProjectFields / setProjectDesc / renameProject / deleteProject / ' +
                    'setThemeFields / setThemeDesc / renameTheme / deleteTheme / deleteEntry。',
                  updated: [],
                }
            }
            if (!r.ok) return { ok: false, message: r.message, updated: [] }
            return { ok: true, message: r.message, updated: [id] }
          }

          // ── 封面级操作 ──
          const ids = (refs ?? []).map((s) => s.trim()).filter((s) => s !== '')
          const hasCoverAction =
            (addThemes ?? []).length > 0 ||
            (removeThemes ?? []).length > 0 ||
            setFields !== undefined ||
            setGlobal !== undefined
          if (ids.length === 0) {
            return {
              ok: false,
              message:
                '要给 `refs`（封面 id 数组，做封面级操作），' +
                '或给 `action`（做项目/主题级操作）。',
              updated: [],
            }
          }
          if (!hasCoverAction) {
            return {
              ok: false,
              message:
                '至少给一个动作：`addThemes` / `removeThemes` / `setFields` / `setGlobal`。',
              updated: [],
            }
          }

          const snapshot = await scanLibrary()
          const updated: string[] = []
          const lines: string[] = []

          // 🔴 **不新建主题**（决策 80）：填了不存在的主题 id ⇒ 报错并指路。
          const newOnes = (addThemes ?? []).map((t) => t.trim()).filter((t) => t !== '')
          const unknown = newOnes.filter((t) => !snapshot.themeIds.includes(t))
          if (unknown.length > 0) {
            return {
              ok: false,
              message:
                `主题不存在：${unknown.map((t) => `\`${t}\``).join('、')}。\n` +
                '⚠️ 本工具**不新建主题**——新建主题请用 `memj_handoff` 的 `newThemes`。\n' +
                '⭐ **理由与模式无关**：新建主题是**跨条目、跨项目的聚合判断**，' +
                '**只有写项目文档那一次调用才有这个视角**，而本工具是事后/独立操作。\n' +
                `库里现有的主题：${snapshot.themeIds.length > 0 ? snapshot.themeIds.map((t) => `\`${t}\``).join('、') : '（暂无）'}`,
              updated: [],
            }
          }

          for (const id of ids) {
            const found = snapshot.covers.find((c) => c.cover.id === id)
            if (found === undefined) {
              // ⭐⭐ **归档条目要说"已归档"，不能说"库里没有"**（决策 133 / 用户裁定 ③）。
              //    🔴 这是一个**真实的遗漏**：`snapshot` 是默认快照（**不含归档**），
              //       所以归档条目会落到上面那个 `undefined` 分支 ⇒ 回执说"库里没有这张封面"
              //       ——**撒谎**，它就在库里。必须再含归档地探一次，才能区分
              //       "真的不存在"与"存在但被归档"。
              const state = await probeCoverState(id)
              if (state === 'archived') {
                lines.push(`- \`${id}\`：该条目**已归档**，不可编辑（请先在「归档」标签页恢复它）。`)
              } else {
                lines.push(`- \`${id}\`：库里没有这张封面，跳过。`)
              }
              continue
            }

            // ⭐⭐ 决策 114：**逐项走 `edit.ts` 的共享实现**——
            //    与网页 API 是同一份代码，不是两套。
            const applied: string[] = []
            if (newOnes.length > 0 || (removeThemes ?? []).length > 0) {
              const r = await editEntryThemes(id, {
                add: newOnes,
                ...(removeThemes !== undefined ? { remove: removeThemes } : {}),
              })
              if (!r.ok) { lines.push(`- \`${id}\`：${r.message}`); continue }
              if (newOnes.length > 0) applied.push(`追加主题 [${newOnes.join(', ')}]`)
              if ((removeThemes ?? []).length > 0) applied.push(`移除主题 [${removeThemes!.join(', ')}]`)
            }
            if (setFields !== undefined) {
              // ⚠️ `kind` 来自 schema 的 enum；非法值不该到这（但仍按 `isEntryKind` 判，
              //    空串是合法的"改回未分类"）。
              const rawKind = setFields.kind
              const kind: EntryKind | '' | undefined =
                rawKind === undefined ? undefined : rawKind === '' ? '' : (isEntryKind(rawKind) ? rawKind : undefined)
              if (rawKind !== undefined && kind === undefined) {
                lines.push(`- \`${id}\`：\`kind\` 非法（\`${rawKind}\`），跳过。`)
                continue
              }
              const r = await setEntryFields(id, {
                ...(setFields.title !== undefined ? { title: setFields.title } : {}),
                ...(setFields.desc !== undefined ? { desc: setFields.desc } : {}),
                ...(setFields.tags !== undefined ? { tags: setFields.tags } : {}),
                ...(kind !== undefined ? { kind } : {}),
              })
              if (!r.ok) { lines.push(`- \`${id}\`：${r.message}`); continue }
              applied.push('改字段')
            }
            if (setGlobal !== undefined) {
              const r = await setEntryGlobal(id, setGlobal)
              if (!r.ok) { lines.push(`- \`${id}\`：${r.message}`); continue }
              applied.push(setGlobal ? '登记 global 提名（封面 global 仍为 false）' : '取消 global')
            }

            updated.push(id)
            lines.push(`- \`${id}\`：${applied.join('；')}。`)
          }

          await rebuildDerivedLayers()
          return {
            ok: true,
            message:
              `已处理 ${updated.length} 张封面（**累加语义：原有归属全部保留**）：\n${lines.join('\n')}\n\n` +
              (setGlobal === true
                ? '⚠️ 只是**登记提名**（封面 `global` 保持 `false`）——需要人在 /memj-review 或网页里**批准**后才置位进 GLOBAL。'
                : '⚠️ 添加主题免批准，已当场生效。'),
            updated,
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // ⭐⭐ memj_update —— 更新一条已有知识（决策 119）
  //
  // 🔴 **它补的是"改正文"这个缺口**：在此之前改正文只能走 handoff 的
  //    `overwrite`（整条替换、必须重贴全文）。
  // ⚠️ **与 memj_promote 的分工**：那个只碰元数据、不碰正文；要动 body 用这里。
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_update',
    () =>
      defineTool({
        name: 'memj_update',
        description: MEMJ_UPDATE_DESCRIPTION,
        parameters: {
          id: { type: 'string', required: true, description: '封面 UUID（从 memj_search 拿）。' },
          body: {
            type: 'string',
            description:
              '⭐ **新正文**（给了就替换）。⚠️ 只对**内部条目**有效——' +
              '外部引用（ext）的正文在库外，本工具不动它。',
          },
          fields: {
            type: 'object',
            additionalProperties: false,
            description: '可选：同时改封面字段（同 `entries[].*` 的规格）。⚠️ 只改给的字段。',
            properties: {
              title: { type: 'string', description: '新标题（2–48 字符）。' },
              desc: { type: 'string', description: '新描述（≤200，检索键）。' },
              tags: { type: 'array', items: { type: 'string' }, description: '新标签（至少 1 个）。' },
              kind: {
                ...kindParam(() => `形态分类（受控词表：${selectableKindList('、')}）。`),
              },
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as { message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute(args) {
          const { id, body, fields } = args as {
            id?: string
            body?: string
            fields?: { title?: string; desc?: string; tags?: string[]; kind?: string }
          }
          const entryId = (id ?? '').trim()
          if (entryId === '') return { ok: false, message: '`id` 不能为空。' }
          if (body === undefined && fields === undefined) {
            return { ok: false, message: '至少要给 `body`（新正文）或 `fields`（封面字段）之一。' }
          }
          // `kind` 来自 schema 的 enum；空串是合法的"改回未分类"。
          const rawKind = fields?.kind
          const kind: EntryKind | '' | undefined =
            rawKind === undefined ? undefined : rawKind === '' ? '' : (isEntryKind(rawKind) ? rawKind : undefined)
          if (rawKind !== undefined && kind === undefined) {
            // 🔴 校验走 `isEntryKind`（动态），文案却写死四值 ⇒ 报错会**暗示新类型非法**。
            return {
              ok: false,
              message: `\`kind\` 非法：\`${rawKind}\`（只能是 ${selectableKindList('、')} 之一，或留空）。`,
            }
          }
          const r = await updateEntry(entryId, {
            ...(body !== undefined ? { body } : {}),
            ...(fields !== undefined
              ? {
                  fields: {
                    ...(fields.title !== undefined ? { title: fields.title } : {}),
                    ...(fields.desc !== undefined ? { desc: fields.desc } : {}),
                    ...(fields.tags !== undefined ? { tags: fields.tags } : {}),
                    ...(kind !== undefined ? { kind } : {}),
                  },
                }
              : {}),
          })
          // 🔴 失败必须**抛**（`isError` 只由抛异常产生）——同 `memj_handoff` 的教训。
          if (!r.ok) throw new Error(r.message)
          return { ok: true, message: r.message }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // memj_rebuild —— 重建派生层 + 封面校验
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_rebuild',
    () =>
      defineTool({
        name: 'memj_rebuild',
        description: MEMJ_REBUILD_DESCRIPTION,
        parameters: {
          project: { type: 'string', description: '只重建涉及该项目的部分；不给则全量。' },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              themes: { type: 'integer', required: true },
              projects: { type: 'integer', required: true },
              globalApproved: { type: 'integer', required: true },
              invalidCovers: { type: 'integer', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as { message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute() {
          // ⚠️ 与写入校验**处置不同**（§3.9.3）：这里**跳过非法封面并记录**，
          //    不阻断重建——一次手改的笔误不该让整个库重建不了。
          //
          // ⭐⭐ **一次 `scanLibrary()` 同时拿"全部封面"与"非法封面"**（2026-09-18）：
          //    原先分别调 `validateAllCovers()` 与 `rebuildDerivedLayers()`，
          //    而前者内部也扫一遍库 ⇒ 白扫两次。
          // ⭐⭐ **含归档地扫一次**（决策 133）：一次拿到「活跃封面数 / 归档封面数 / 非法问题」。
          //    🔴 为什么要报归档数：默认快照**不含归档封面**，于是体检行的"N 张合法"
          //       会比用户在库文件里数到的**少**（他数的是全部封面块）。
          //       不解释的话，这条本该最可信的数字**看起来像算错了**。
          //    ⚠️ `issues` 不过滤：归档封面的格式问题**照报**（用户要求"硬校验保持一致"）。
          // ⭐⭐ **含历史地扫**（决策 136）：历史条目也是**合法封面块**，
          //    它们若不被计入，体检行的"N 张合法"会比用户数到的**少**
          //    ⇒ 与"归档数要单独报"同一条理由（**数字不许悄悄变少**）。
          const snapshot = await scanLibrary({ includeArchived: true, includeHistory: true })
          const issues = snapshot.issues
          const activeCovers = snapshot.covers.filter((c) => (c.cover.archivedAt ?? '') === '')
          const archivedCount = snapshot.covers.length - activeCovers.length
          // ⭐ 历史条目：**单列一个口径**（它们是"被截走的原文"，不是知识）。
          const historyCount = activeCovers.filter((c) => c.cover.kind === 'history').length
          const knowledgeCount = activeCovers.length - historyCount
          const stats = await rebuildDerivedLayers()
          // ✅ **恒常的体检结论**（决策 122）——**不管有没有非法封面都出这一行**。
          //    🔴 为什么必须"恒常"：这条回执是 `memj_rebuild` 相对"自己写探针调内部函数"
          //    的**可感知差别**。写成"有非法才报"的话，绝大多数情况（全合法）下
          //    走工具与走探针的输出**看不出区别** ⇒ 失去"优先用工具"的动机。
          //    ⚠️ 口径：只数**活跃**封面（归档的不算活跃）——归档数另行注明。
          const legal = activeCovers.length - issues.length
          const lines = [
            `派生层已重建：${stats.themes} 个主题、${stats.projects} 个项目 frontmatter 被更新、` +
              `${stats.globalApproved} 条已生效的全局知识。`,
            `✅ **封面校验**：${legal} 张合法` +
              (issues.length > 0 ? `、${issues.length} 张**非法**（重建时已跳过）。` : '（全部合法）。') +
              // ⚠️ **只在真有归档时才加这一句**：否则会改变绝大多数回执的字面，
              //    让既有断言/对照全部失效（本项目吃过"改回执措辞"的亏）。
              (archivedCount > 0
                ? ` ⚠️ 另有 **${archivedCount} 张已归档**（不在上面的活跃计数里）。`
                : '') +
              // ⭐⭐ **历史条目另报一个口径**（决策 136）：它们**不在检索里**，
              //    但不报的话，"活跃封面数"与用户数到的**对不上**（同归档数那条理由）。
              //    ⚠️ 同样**只在非零时才加**（否则会改掉绝大多数回执的字面）。
              (historyCount > 0
                ? ` ⭐ 其中 **${historyCount} 张是历史归档**（\`kind: history\`，**不参与检索**；其余 ${knowledgeCount} 张是知识）。`
                : ''),
          ]
          // 🔴 **校验报告只报给人**（决策 42 / §4.2 description 原文）：
          //    LLM 这边**只得到"有几处"与"去哪看"**，**不列明细**——
          //    明细走 `/memj-review` 与网页 UI。
          if (issues.length > 0) {
            lines.push(
              '⚠️ 非法封面明细**给人处理**——请看 `/memj-review`，或网页 UI 的封面错误列表。',
            )
          }
          return {
            ok: true,
            message: lines.join('\n'),
            themes: stats.themes,
            projects: stats.projects,
            globalApproved: stats.globalApproved,
            invalidCovers: issues.length,
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // ⭐⭐⭐ memj_template —— 交接文档模板（决策 204 / 205）
  //
  // 🔴🔴 **create / delete 走【两段式确认】**（用户 2026-09-30 裁定走 (b) 方案）：
  //    第一次调用（不给 `confirm`）**什么都不做**，只回一份「待确认」回执；
  //    用户在主会话明确同意后，模型带 `confirm: true` 重调一次才执行。
  //    ⭐ 与 `memj_handoff` 的 `confirmCreate`（相似 id 确认）**同一套路**。
  //    ⚠️ `list` **不需要确认**（只读、零副作用）——否则模型连"有哪些模板"都看不了。
  //
  // ⚠️ **模板只影响【新建项目】**：已有文档记着自己的节名，与模板**已解耦**
  //    ⇒ 改模板、删模板都**不影响任何已有文档**（决策 204）。
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_template',
    () =>
      defineTool({
        name: 'memj_template',
        description: MEMJ_TEMPLATE_DESCRIPTION,
        parameters: {
          action: {
            type: 'string',
            description: "要做什么：'list' 列出全部模板（不需确认）/ 'create' 新建或覆盖 / 'delete' 删除。",
          },
          template: {
            type: 'object',
            // ⚠️ `type:'object'` 节点**必须显式给 `additionalProperties`**（文件头第 9 行那条铁律）。
            additionalProperties: false,
            description:
              '`create` 时给。⭐ `desc` 必填（**这一节要干嘛**，会写进该节标题下的规范块）；' +
              '⭐ **归档规则也写在 `desc` 里**（自然语言）：想让某一节自动瘦身，就在它那段规范里' +
              '写清"超过多少字符、把什么归档成什么类型、原处留什么"。⚠️ **把数字写死**' +
              '（如"超过 20000 字符"）—— 因为工具会把实际字数报给模型，有确切数字才对照得上。',
            properties: {
              id: {
                type: 'string',
                required: true,
                description: '模板 id（全小写英文/数字/连字符，2–48 字符；同时是文件名）。',
              },
              title: { type: 'string', description: '给人看的名字。' },
              sections: {
                type: 'array',
                required: true,
                description: '节定义，**顺序即文档里的顺序**。',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    name: { type: 'string', required: true, description: '节名（`## ` 后面那个词）。' },
                    desc: {
                      type: 'string',
                      required: true,
                      // ⭐ 2026-10-05（用户裁定）：**上限取消**（200 字对"书写规范"偏紧）。
                      //    ⚠️ 与知识封面的 `desc` **不是一回事** —— 那个是检索键，仍然是 200。
                      description:
                        '⭐ **这一节的书写规范**（必填）—— 它会写进该节标题下的规范块。' +
                        '**没有字数上限**（不占截断配额；超过 2000 字只给提醒，不阻断保存）。',
                    },
                    // 🔴🔴 **决策 223 删掉了 `truncate` 字段（2026-10-09 从这里也删干净）**：
                    //   它已从 `TemplateSection` 接口删除、`renderTemplateDoc` 不渲染、
                    //   `parseTemplateDoc` 不读 ⇒ 之前 schema 里**还留着它**，
                    //   模型能传、**传了被静默丢掉**（不报错、不生效）。
                    //   ⚠️ 与"不再维护但透传"的 `frontmatter.truncateSections` **不是一回事** ——
                    //      那个是**存量数据**（要保住），这个是**给模型的入口**（必须撤掉，
                    //      否则等于告诉模型"这个旋钮有用"）。
                    //   ⭐ 判据：**参数 schema 里不该留"传了也不生效"的字段**。
                  },
                },
              },
            },
          },
          id: {
            type: 'string',
            description: '`delete` 时要删的模板 id。内置 `default` 不可删。',
          },
          confirm: {
            type: 'boolean',
            description:
              '⭐ **用户同意后才传 true**。不给 ⇒ 本工具**只回一份待确认回执、什么都不做**（两段式确认）。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as { message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute(args) {
          const a = args as { action?: string; template?: unknown; id?: string; confirm?: boolean }
          const req = {
            action: (typeof a.action === 'string' ? a.action.trim() : '') as 'list' | 'create' | 'delete',
            template: a.template,
            id: typeof a.id === 'string' ? a.id : '',
            confirm: a.confirm === true,
          }
          const decision = decideTemplateTool(req)
          if (decision.kind === 'reject') return { ok: false, message: decision.message }
          if (decision.kind === 'needs-confirm') return { ok: true, message: decision.message }

          const { listTemplates, normalizeTemplate, saveTemplate, deleteTemplate, validateTemplate } =
            await import('./templates.ts')

          if (req.action === 'list') {
            const all = await listTemplates()
            const lines = [`共 ${all.length} 份模板：`, '']
            for (const t of all) {
              const errs = validateTemplate(t)
              lines.push(
                `- \`${t.id}\`（${t.title}）— ${t.sections.length} 节` +
                  (t.id === 'default' ? '｜**内置，不可删**' : '') +
                  (errs.length > 0 ? `\n  ⚠️ 该模板不合法：${errs.join('；')}` : ''),
              )
              for (const s of t.sections) {
                // 🔴 决策 223：不再标"（可自动截断）"——归档规则已改成 `desc` 里的自然语言。
                lines.push(`  · \`${s.name}\` —— ${s.desc}`)
              }
            }
            lines.push(
              '',
              '⭐ 要在新建项目时用它：在 `memj_handoff` 里传 `template: "<id>"`。',
              '⚠️ **模板只影响新建项目**；已有文档记着自己的节名，不受模板影响。',
            )
            return { ok: true, message: lines.join('\n') }
          }

          if (req.action === 'create') {
            const t = normalizeTemplate(req.template)
            if (t === undefined) {
              return { ok: false, message: '模板形状不合法（缺 `id`，或 `sections` 全为空）。' }
            }
            if (t.id === 'default') {
              return { ok: false, message: '`default` 是内置模板，不可覆盖（可以另建一个 id）。' }
            }
            const errs = await saveTemplate(t)
            if (errs.length > 0) {
              return {
                ok: false,
                message: `模板**未写入**（校验没过）：\n${errs.map((e) => `  · ${e}`).join('\n')}`,
              }
            }
            return {
              ok: true,
              message:
                `✅ 模板 \`${t.id}\`（${t.title}）已保存，共 ${t.sections.length} 节。\n` +
                // 🔴 决策 223：不再判"有没有声明可自动截断的节"（那个标记已废除）。
                //    ⚠️ 但**归档这件事仍然值得提一句** —— 它现在是**规范里的自然语言**，
                //       而用户很容易漏写 ⇒ 提醒他"想让某节瘦身就把规则写进那一节的规范里"。
                '⭐ **归档规则写在各节的书写规范里**（自然语言）：想让某一节自动瘦身，' +
                '就在它那段规范里写清"超过多少字符、归档成什么类型、原处留什么"。\n' +
                '⭐ 在新建项目时用：`memj_handoff` 里传 `template: "' + t.id + '"`。\n' +
                '⚠️ **不影响任何已有文档**。',
            }
          }

          // delete
          const okDel = await deleteTemplate(req.id ?? '')
          return {
            ok: okDel,
            message: okDel
              ? `✅ 模板 \`${req.id}\` 已删除。\n⭐ **没有任何已有文档受到影响** —— 它们记着自己的节名。`
              : `模板 \`${req.id}\` 不存在（或不可删）。`,
          }
        },
      }),
  )

  // ══════════════════════════════════════════════════════════════════════
  // ⭐⭐⭐ memj_normalize_tags —— 标签规范化（决策 162）
  //
  // 🔴🔴 **为什么是【独立工具】而不是在沉淀时自动做**：
  //    我第一版把归一**硬编码进 `handoff` 写入口**（静态规则表查表替换），
  //    用户当场否掉：*"不如还是把规范的动作交给 llm，但是跟沉淀动作解耦出来。
  //    等沉淀完了，再专门对沉淀的内容专门处理。"*
  //    ⭐ 两条理由（都是我事后才想清的）：① **沉淀时不该替模型做判断**
  //      （它会以为自己写对了）；② **静态表的新同义词永远合不进来**。
  // ══════════════════════════════════════════════════════════════════════
  safeRegister(
    'memj_normalize_tags',
    () =>
      defineTool({
        name: 'memj_normalize_tags',
        description: MEMJ_NORMALIZE_TAGS_DESCRIPTION,
        parameters: {
          since: {
            type: 'string',
            description:
              '只处理此时间之后更新过的条目（ISO 8601，如 `2026-09-28`）。不给则用水位线。',
          },
          full: {
            type: 'boolean',
            description:
              '无视水位线，全库重跑（较贵）。⚠️ 只有它能把"没有 updatedAt 的老条目"纳入。',
          },
          includeBody: {
            type: 'string',
            enum: ['none', 'truncated', 'full'],
            description:
              '给裁决模型多少正文：`truncated`（默认，每条前 1000 字符）/ `none` / `full`。',
          },
          preview: {
            type: 'boolean',
            description: '`true` = 只看不改（默认 false = 直接改）。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
              scanned: { type: 'integer', required: true },
              pending: { type: 'integer', required: true },
              changed: { type: 'integer', required: true },
              previewOnly: { type: 'boolean', required: true },
            },
          },
          render: (_args, value) => {
            const v = value as { message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute(args) {
          const { normalizeTags } = await import('./tag-normalize.ts')
          const a = args as {
            since?: string
            full?: boolean
            includeBody?: 'none' | 'truncated' | 'full'
            preview?: boolean
          }
          const r = await normalizeTags(ctx, config, {
            ...(a.since !== undefined && a.since.trim() !== '' ? { since: a.since.trim() } : {}),
            ...(a.full === true ? { full: true } : {}),
            ...(a.includeBody !== undefined ? { includeBody: a.includeBody } : {}),
            ...(a.preview === true ? { preview: true } : {}),
          })
          return {
            ok: r.ok,
            message: r.message,
            scanned: r.scanned,
            pending: r.pending.length,
            changed: r.affected.length,
            previewOnly: r.previewOnly,
          }
        },
      }),
  )
  // ══════════════════════════════════════════════════════════════════════
  // ⭐⭐⭐ memj_score_turn —— 轮末复盘：给"本来能帮上忙"的知识加分（决策 177）
  // ══════════════════════════════════════════════════════════════════════
  //
  // 🔴🔴 **它刻意【不是】给主会话模型调的**（用户裁定走**甲方案**）：
  //    由插件的 `agent/turn-stopping` 钩子起一个子代理来调它。
  //    ⚠️ 但工具本身**不检查调用方**（那样会多一道语义判据）；
  //       防线在钩子的**四道门**上（尤其"本会话不是子代理"那道 —— 防递归）。
  //
  // ⚠️ **为什么参数要显式给 `session` + `turn`**：
  //    子代理的 `exec.agent.session.id` 是**子会话**的 id，
  //    而它要评的是**父会话的某一轮** ⇒ 必须显式传进来。
  safeRegister(
    'memj_score_turn',
    () =>
      defineTool({
        name: 'memj_score_turn',
        description: MEMJ_SCORE_TURN_DESCRIPTION,
        parameters: {
          session: {
            type: 'string',
            description: '要复盘的那个会话 id（`session-<uuid>`）。⚠️ 不是当前子会话的 id。',
          },
          turn: {
            type: 'integer',
            description: '要复盘第几轮（该轮已结束）。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              ok: { type: 'boolean', required: true },
              message: { type: 'string', required: true },
            },
          },
          // ⭐ 回执**就是** `message`（它已含完整过程：批数/耗时/最高分/加分明细）。
          render: (_args, value) => {
            const v = value as { message: string }
            return [{ type: 'text', text: v.message }]
          },
        },
        async execute(args) {
          const a = args as { session?: string; turn?: number }
          const sessionId = typeof a.session === 'string' ? a.session.trim() : ''
          const turn = typeof a.turn === 'number' ? a.turn : -1
          if (sessionId === '' || turn < 0) {
            return { ok: false, message: '参数不完整：需要 `session`（会话 id）与 `turn`（轮次号）。' }
          }
          // ⭐ 项目判定走统一入口（`resolveProject`）—— 与热知识注入**同一份判据**，
          //    不另写一份（本项目铁律：同一判据只有一份实现）。
          const { resolveProject } = await import('./hot-watch.ts')
          const r = await resolveProject(ctx, sessionId)
          const { scoreTurn } = await import('./score-turn.ts')
          const out = await scoreTurn(ctx, config, { sessionId, turn, project: r.project })
          return { ok: out.ok, message: out.message }
        },
      }),
  )
}

/** 读主题 desc（小工具，避免循环依赖）。 */
async function loadThemeDesc(themeId: string): Promise<string> {
  const { loadThemeFrontmatter } = await import('./store.ts')
  const fm = await loadThemeFrontmatter(themeId)
  return fm?.desc ?? ''
}
