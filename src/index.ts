/**
 * dsh-memj 的 host 端入口。
 *
 * 注册四件事：
 *  1. **静态协议** —— `ctx.systemPrompt.section()`（§6 全文，逐字节恒定）；
 *  2. **六个工具** —— `memj_info` / `search` / `read` / `handoff` / `promote` / `rebuild`；
 *  3. **斜杠命令** —— `/memj-handoff`、`/memj-review`（逐个 try 注册）；
 *  4. **路由** —— `/plugins/dsh-memj/api/*`（人侧界面用）。
 *
 * ── 路由为什么必须带包名 ────────────────────────────────────────────────────
 * `dsh-client-modules` 注册了**宽前缀** `/plugins`。匹配规则是
 * **exact 先查 + longest-prefix-wins** ⇒ 我们注册 `/plugins/dsh-memj`（更长）**必胜**。
 * 只注册与 `/plugins` 等长或更短的 prefix 会被 serveBundle 吃掉。
 *
 * @module dsh-memj
 */

import type { Context } from '@deepseek-ai/cordis'
import type { WebServer } from '@deepseek-ai/dsh-host-webserver'
// 下列 type-only import 是**声明合并的来源**，删掉就会丢 `ctx.systemPrompt` /
// `ctx.tools` / `ctx.commands` 等成员与事件类型。
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'
// ⭐⭐⭐ **本插件自己的 `MessageSourceMap` 条目**（0.2.0 起 kind 是 `plugin:dsh-memj`）。
//
// 🔴 **这一行的作用只有一个：把那次 module augmentation 钉进编译程序。**
//    本行**没有运行时效果**（type-only import 会被完全擦除），
//    但**少了它，`plugin:dsh-memj` 就只靠 `tsconfig.json` 的
//    `include: ["src"]` 兜着** —— 一旦有人把 include 收窄成显式清单，
//    augmentation 会**静默失效**（各处写的都是字符串字面量，照样编得过）。
//
// ⚠️ **实测教训（2026-10-08 全量核实时查出）**：`message-source.ts` 的文件头
//    **原文就写着"本文件被 `index.ts` 以 `import type` 引入"**，
//    而当时**全仓 0 个消费者**（`grep -r message-source src/` 无命中）——
//    **注释写了规矩、代码没照做**，正是本项目反复栽的那个形态
//    （同族：风险 52「'两处必须同源'这类注释要配一条断言，否则它只是愿望」）。
//    ⇒ 修法就是这一行：**让注释描述的事实真的成立**，而不是把注释改弱去迁就现状。
import type {} from './message-source.ts'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Config, DEFAULT_CONFIG, type MemjConfig } from './config.ts'
import { ensureLibraryDirs, libraryRoot } from './store.ts'
// ⭐ 决策 208：`default` 模板也落盘（文件不存在时写一份出来，幂等、不覆盖用户改动）。
import { ensureDefaultTemplateFile } from './templates.ts'
// ⭐⭐⭐ 决策 215：知识类型词表的启动预热（`isEntryKind` 读的是进程内当前值）。
import { loadKinds } from './kinds.ts'
import { fillKindMarkers, setCurrentKindDefs } from './schema.ts'
import { PROTOCOL_SECTION_ORDER, PROTOCOL_TEXT, protocolText } from './protocol.ts'
// ⭐⭐ 运行时上下文（决策 124）：走 `context()`，**改它不破前缀缓存**。
import { CONTEXT_NAME, CONTEXT_ORDER, CONTEXT_TEXT } from './context.ts'
import { registerCommands } from './commands.ts'
import { registerTools } from './tools.ts'
// ⭐⭐ 热知识注入（热知识方案 §6.2）：两个钩子（看门狗 + 补注）。
import { registerHotInjection } from './hot-watch.ts'
// ⭐⭐⭐ 轮次结束时的自动标签规范化（决策 165）。
import { registerTagAutoNormalize } from './tag-auto.ts'
// ⭐⭐⭐ 轮末自动知识评分（决策 177）。
import { registerAutoScore } from './score-auto.ts'
// ⭐⭐⭐ 轮末上报上下文占用率（决策 226）—— 让模型能知道"上下文用了多少"。
import { registerContextReport } from './context-auto.ts'
// ⭐⭐⭐ 「文档内提问」的轮末同步（2026-10-14）——把阅读会话的问答追加进 chat 条目。
import { registerReadingSync } from './reading-sync.ts'
// ⭐⭐⭐ 「文档内提问」的入口（2026-10-14）与上下文注入。
import { readingAskDeps, type AskDeps } from './reading-ask.ts'
import { installDocContext, registerDocContext } from './reading-context.ts'
// ⭐⭐ 英文召回索引（设计文档 §9；B 方案：召回只读它）
import { registerEnIndex } from './en-index.ts'
// ⭐⭐ 主动注入（设计文档 §5/§7）：触发 + 注入两个钩子。
import { registerActiveInjection } from './active-inject.ts'
// ⭐ host 侧硬校验闸门（决策 103）。
import { registerGate } from './gate.ts'
// 🔴 **必须静态导入**（曾经是 `await import('./api.ts')`）：见下方 apiHandler 里的说明。
import { handleApi } from './api.ts'
// ⭐⭐⭐ 提示词运行期覆盖层（本次新增）：启动时预热缓存 + 各取值点读它。
import { promptText, refreshPromptCacheSync, registerPromptDefault } from './prompts.ts'

export const name = 'dsh-memj'

/**
 * 需要的服务。
 *
 * ⚠️ **缺任何一个，`ctx.inject` 的回调就永不执行且无报错**——
 * 表现为"插件加载了但工具/命令一个都没有"。见下方 `diag`。
 *
 * 🔴🔴 **`webServer` 必须留在这里，且[不能]改成可选**（2026-10-19 核过，别动）：
 *    `dsh-headless` 明确不挂 HTTP server（其 patch 原话：*"It mounts no Host,
 *    HTTP server, Web Runtime, or browser plugin"*，`webserver` 行只在
 *    `dsh-web-app` 的 patch 里）⇒ 在 `--profile headless` 下这条永不满足。
 *    ⚠️ 后果是**整个 inject 回调不执行**：工具/命令/协议/热知识/主动注入/评分
 *    **全部不注册、且没有任何报错**。
 *    ⭐ **这是【有意】的能力边界**：memj 的**知识写入面**（`memj_handoff` 等 8 个工具）
 *    与**人侧界面**（`/plugins/dsh-memj/` 的十几个页面）是同一个交付物，
 *    拆开没有意义；而 headless 是"一次性任务"场景，本来就没有人侧界面。
 *    ⇒ **不要把 `webServer` 改成可选**来"让 memj 在 headless 里能加载"：
 *      那样加载出来的是一半插件（工具能用、设置页全 404），比干脆不加载更难排查。
 *    📌 若将来真要让 headless 用 memj 的工具面，正确做法是**再开一份只含工具/命令的
 *      轻量入口**（另立 `inject` 数组），而不是让现有入口降级。
 */
export const inject: string[] = ['webServer', 'systemPrompt', 'tools', 'commands']

/** 插件在路由表里的路径前缀（**必须带包名**）。 */
const PLUGIN_BASE = '/plugins/dsh-memj'

/**
 * ⭐ **loader 树里的 entry id —— 与包名不是一回事**（2026-09-19 实测踩到）。
 *
 * 本插件的 bundle patch（`cordis.patch.yml`）写的是
 * `insert: [{ id: memj, name: dsh-memj }]` ⇒ **条目 id 是 `memj`**，
 * 而 `dsh-memj` 是**包名**。
 *
 * 🔴 **为什么必须区分**：设置面板（决策 97）要往 profile 的 `cordis.patch.yml`
 * 写一条 `- id: <这个值>` 的 config 覆盖；**写错 id 的后果极隐蔽**——
 * boot 时只打一行 `patch: entry "dsh-memj" not found` 警告，
 * 配置**静默不生效**，而面板还显示"已保存"。
 */
const PLUGIN_ENTRY_ID = 'memj'

/** API 前缀（人侧界面用）。 */
const API_BASE = `${PLUGIN_BASE}/api`

/** 构建期由 tsdown `define` 注入的版本号。 */
declare const __DSH_MEMJ_VERSION__: string | undefined

/** 取版本号；未注入时退回 '0.0.0'。 */
function pluginVersion(): string {
  return typeof __DSH_MEMJ_VERSION__ === 'string' ? __DSH_MEMJ_VERSION__ : '0.0.0'
}

/**
 * 网页资源的产物目录。
 *
 * ⚠️ **没有官方 helper**：实测 tsdown 原样保留 `import.meta.url`，
 * 且在 `link:` 安装下解析到真实源码路径 ⇒ 资源必须落在**产物目录** `lib/web/`。
 */
const WEB_ROOT = fileURLToPath(new URL('./web/', import.meta.url))

/** 扩展名 → MIME。官方静态兜底**未导出**可复用的 helper，这里自己写一张小表。 */
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** 单个静态文件大小上限。 */
const MAX_STATIC_BYTES = 4 * 1024 * 1024

/** 看起来像资源文件的路径（这些**不做** SPA 回退）。 */
const ASSET_EXT_RE = /\.[a-z0-9]{1,8}$/i

/**
 * 服务一个网页静态文件；未知的**页面路径**回退到 `index.html`。
 *
 * ⚠️ **回退只对"像页面"的路径生效**：`/favicon.ico`、`/app.js.map` 这类
 * **带扩展名但文件不存在**的请求必须**直接 404**——否则浏览器会把
 * `index.html` 当成图标/脚本，控制台刷 404 且可能误解析。
 * （官方静态兜底不做 SPA fallback；这个回退是我们自己加的，所以要自己把握边界。）
 * @param pathname - 请求路径名。
 * @param res - 响应对象。
 */
async function serveWeb(
  pathname: string,
  res: import('node:http').ServerResponse,
): Promise<void> {
  const rel = pathname.slice(PLUGIN_BASE.length).replace(/^\/+/, '')
  const looksLikeAsset = ASSET_EXT_RE.test(rel)
  const candidates =
    rel.length === 0 ? ['index.html'] : looksLikeAsset ? [rel] : [rel, 'index.html']

  for (const candidate of candidates) {
    // 目录穿越防护：拼出来的路径必须仍在 WEB_ROOT 内。
    const url = new URL(`./${candidate}`, `file:///${WEB_ROOT.replace(/\\/g, '/')}/`)
    const abs = fileURLToPath(url)
    if (!abs.startsWith(WEB_ROOT)) continue
    try {
      const content = await readFile(abs)
      if (content.length > MAX_STATIC_BYTES) continue
      res.writeHead(200, {
        'Content-Type': MIME[extname(abs).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      })
      res.end(content)
      return
    } catch {
      // 试下一个候选。
    }
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(
    rel.length === 0 || !looksLikeAsset
      ? 'dsh-memj: web asset not built (run `pnpm run build`)'
      : `dsh-memj: no such asset: ${rel}`,
  )
}

export { Config }
// ⚠️ `DEFAULT_CONFIG` 必须一并导出：`apply()` 的默认参数用它，
//    且离线测试与探针需要一份**不经过 schemastery 校验**的现成配置。
export { DEFAULT_CONFIG } from './config.ts'

/**
 * 把启动诊断写进库根的小文件。
 *
 * 🔴 必要性：`ctx.inject` 的回调**等所有列出的服务就绪才执行**，缺一个就
 * **永不执行且没有任何报错**。这是"插件看起来加载了、但工具/命令/注入全没有"
 * 的头号原因。`ctx.logger` 的输出不一定落在能读到的地方，**写文件最可靠**。
 * @param stage - 阶段名。
 * @param config - 配置（提供库根）。
 */
function diag(stage: string, config: MemjConfig): void {
  void (async () => {
    try {
      const root = libraryRoot()
      await mkdir(root, { recursive: true })
      await appendFile(
        join(root, '.startup-diag.txt'),
        `${new Date().toISOString()} ${stage}\n`,
        'utf8',
      )
    } catch {
      /* 诊断失败不能影响插件 */
    }
  })()
}

/**
 * 挂载协议、工具、命令与路由。
 *
 * 配置走**第二参**（已校验 + 填好默认值），不是 `ctx.config`。
 * @param ctx - 插件上下文。
 * @param config - 已解析的插件配置。
 */
export function apply(ctx: Context, config: MemjConfig = DEFAULT_CONFIG): void {
  const version = pluginVersion()
  diag(`apply-start v${version} root=${libraryRoot()}`, config)

  // ⭐⭐⭐ 「文档内提问」的两个跨作用域句柄（2026-10-14）。
  //
  //  · `readingAsk` —— `/reading/ask` 的依赖（要开真会话 ⇒ 必须在这里装配）。
  //    ⚠️ 它定义在 `ctx.inject([...])` 回调里，而 `apiHandler` 在**外层**要用 ⇒
  //       用闭包变量传递（装配失败时保持 `undefined`，那条路由回 500，其余不受影响）。
  //  · `docContextRefresh` —— 刷新 `context()` 的同步缓存。
  //    🔴 **建完绑定后必须调它**：否则同一会话的下一轮注入会查不到刚建的绑定
  //       ⇒ 文档上下文静默丢失（`text()` 查 Map 查不到 ⇒ 返回空串 ⇒ 不注入）。
  let readingAsk: AskDeps | undefined
  let docContextRefresh: (() => Promise<void>) | undefined

  // 库目录在启动时就建好——首次使用时不必再判存在性。
  void ensureLibraryDirs().catch(() => {})

  // ⭐⭐ **确保 `default` 模板已落盘**（决策 208：默认模板也可被用户编辑）。
  //    🔴 **幂等**：文件已存在就**不碰**（否则每次重启都会把用户的改动覆盖回内置值）。
  //    ⚠️ **best-effort**：写不出来也不该影响启动（回落内置值即可）。
  void ensureDefaultTemplateFile().catch(() => {})

  // ⭐⭐⭐ **预热"当前生效的知识类型词表"**（决策 215）。
  //
  // 🔴🔴 **为什么必须在这里做、且不能省**：
  //    `isEntryKind()` 是**同步**函数、有 **18 个调用点**（含两个纯函数
  //    `parse.ts` / `store.ts`），所以它读的是 `schema.ts` 里那份**进程内当前值**。
  //    ⇒ 不预热的话，**用户加的类型在启动后第一次解析时不被认**（要等某个触发点去刷新），
  //      表现为"我明明加了，模型填了却被判非法"。
  // ⚠️ **失败不阻断启动**：读不到文件 ⇒ 那份当前值保持**内置默认**
  //    （`schema.ts` 的初值就是内置 id）—— 那正是"还没配过"的常态。
  void loadKinds()
    .then((defs) => setCurrentKindDefs(defs))
    .catch(() => {})

  // ⭐⭐⭐ **预热提示词覆盖缓存**（本次新增）。
  //
  // 🔴🔴 **必须是"同步预热"，不能用 async**：取值点在 DSH 的**装配路径**上
  //    （`text: () => …` 与工具描述 getter），**不允许 async**；而 `apply()` 本身同步，
  //    异步预热会与首次装配**竞态** ⇒ 用户会看到"我明明改了、这一轮没生效"。
  //    ⭐ 覆盖表只有几 KB，同步读的代价可忽略。
  // ⚠️ **失败不阻断启动**：读不到覆盖表 = 全部走源码默认值（那正是"还没改过"的常态）。
  //
  // ⚠️ **登记两个常驻通道的默认值**（展示页要并排显示"默认 vs 当前"）。
  registerPromptDefault('section:memj:protocol', PROTOCOL_TEXT)
  registerPromptDefault('context:memj:usage-guidance', CONTEXT_TEXT)
  diag(`prompt-overrides-loaded count=${refreshPromptCacheSync()}`, config)

  const webServer = ctx.get('webServer') as WebServer

  // ── 等依赖就绪后再做注册（工具/命令/协议都要用它们）──
  ctx.inject(['systemPrompt', 'tools', 'commands'], (scoped) => {
    diag('inject-callback-ran', config)

    // ── 1. 静态协议：内容逐字节恒定，故不会触发 node 0 重写 ──
    if (config.injectProtocol) {
      try {
        scoped.systemPrompt.section({
          name: 'memj:protocol',
          order: PROTOCOL_SECTION_ORDER,
          // ⚠️ provider 每次 assembly 都会被调用，但下游**按内容字符串比较**收口
          //    ⇒ 返回同一字符串 = 空提交 = 无事件。
          //    本函数只返回常量，绝不含运行时数字（那会导致永不命中缓存）。
          //
          // ⭐⭐⭐ **本次新增：走 `promptText` 取覆盖值** —— 设置页的【提示词】子页
          //    保存后，这里下一次装配即读到新值（**无需重启**）。
          //    ⚠️ 覆盖层只改"这一段的文本"，**不改本段的注册位置/order** ⇒
          //       它仍然是 node 0、仍然破缓存（这是协议通道的固有代价，见展示页的警示）。
          text: () => promptText('section:memj:protocol', protocolText()),
        })
        diag('protocol-registered', config)
      } catch (err) {
        diag(`protocol-THREW ${err instanceof Error ? err.message : String(err)}`, config)
      }
    }

    // ── 1b. ⭐⭐ 运行时上下文（决策 124）：指导文本走 `context()` ──
    //     🔴 **为什么单开这条通道**：它落在 **user 角色、尾部 append**，
    //     ⇒ **改它不破前缀缓存**（协议与工具描述都会破，见方案 §2）。
    //     ⚠️ `text` 必须是**函数**才会每次装配重算；返回常量即"同值不发"。
    try {
      // ⭐⭐⭐ **DSH 0.2.1 新增的 `required` 必须显式传**（2026-10-19，对照 0.2.0→0.2.1 查出）。
      //
      // 🔴🔴 **不传会怎样**：0.2.1 引入 `suppressRuntimeContext()`（**给 `includeRuntimeContext:false`
      //    或子作用域用的**）——它会把**所有没标 `required` 的 context 一律摘掉**。
      //    而本插件这条 context **就是它的全部使用指导**（触发条件 / 挂靠判据 / 归档流程 /
      //    写作规范指路）⇒ 一旦被摘，**模型仍然有 8 个工具，但再也不知道什么时候该用、
      //    该填什么字段、以及那套"归错比多建更糟"的判据** —— 失安静默，且表现为
      //    "memj 忽然不好用了"。
      //
      // ⭐ **为什么是 `required: true` 而不是保持可选**：
      //    它的语义本就是"操作型上下文"（operational context，与官方 sandbox/approval
      //    那几条同类）—— 不是"锦上添花的动态信息"。一条被抑制就失去意义的指导，
      //    正是 `required` 存在的理由。
      //
      // ⚠️ **为什么用 `as` 而不是直接写字面量**：本仓的类型来自 0.1.5 的
      //    `dsh-system-prompt`，那里**没有** `required` 字段 ⇒ 直接写会 typecheck 失败。
      //    而**多传一个旧版本不认识的字段是无害的**（旧版本只读它认识的键）。
      //    ⇒ 用"并集类型 + 条件展开"让两版共用一份实现，与 `client/index.tsx` 的
      //      `SessionListStateShape` 同一手法（那里也是跨版本并集）。
      //    ⚠️ 别改成 `@ts-expect-error` —— 那样在 0.2.1 类型装上后会变成"多余的抑制"。
      const contextSpec = {
        name: CONTEXT_NAME,
        order: CONTEXT_ORDER,
        // ⭐⭐⭐ **本次新增：走 `promptText` 取覆盖值**（同协议通道）。
        //    ⚠️ `context()` 落在 user 角色、按内容比较收口 ⇒ **改它不破前缀缓存**
        //       （与本页展示的"破缓存=否"一致）。
        //
        // ⭐⭐⭐ **决策 217：填 `{{kindCatalog}}` 插槽** —— 知识类型目录**每轮现拼**。
        //    🔴 **为什么必须在这里填、而不是把表写进 `CONTEXT_TEXT`**：
        //      `promptText` 取的是**覆盖层优先**的那一份（用户可在设置页编辑），
        //      而覆盖值是**固定快照** ⇒ 表写在正文里就会**过时**
        //      （用户在【知识类型】页加了类型，模型读到的还是旧表）。
        //    ✅ 做成插槽后：**正文可编辑、目录永远新鲜** —— 两件事不再冲突。
        //    ⚠️ `prompts.ts` 的 `slots` 校验（双向）保证这个插槽不会被误删/写错名字。
        //
        // 🔴 **0.2.1 的 `interpolate` 不要关**：正文里的 `{{kindCatalog}}` 在**这里**
        //    就已经被 `fillKindMarkers()` 填掉了，宿主拿到的文本里没有插槽。
        //    ⚠️ 而 `context.ts` 顶部早就记着这个坑（`{{}}` 是有主语法、memj 用不了，
        //    所以类型目录用的是 HTML 注释标记）⇒ **这里不需要改动**。
        text: () => fillKindMarkers(promptText('context:memj:usage-guidance', CONTEXT_TEXT)),
        // ⭐ 只在运行时存在、旧版本会忽略（见上面的说明）。
        required: true,
      } as Parameters<typeof scoped.systemPrompt.context>[0] & { required?: boolean }
      scoped.systemPrompt.context(contextSpec)
      diag('context-registered', config)
    } catch (err) {
      diag(`context-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 2. 工具（内部已逐个 try，一个失败不影响其余）──
    registerTools({ ctx: scoped as unknown as Context, config, version })
    diag('tools-registered', config)

    // ── 2b. ⭐⭐ host 侧硬校验闸门（决策 103 / §3.11.6）──
    //     为什么放在工具之后：闸门靠 `exec.name` 匹配，与注册顺序无关；
    //     放在这里是为了让"注册失败"不影响工具本身。
    try {
      registerGate({ ctx: scoped as unknown as Context })
      diag('gate-registered', config)
    } catch (err) {
      diag(`gate-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3. 斜杠命令 ──
    registerCommands({ ctx: scoped as unknown as Context, config })
    diag('commands-registered', config)

    // ── 3b. ⭐⭐ 热知识注入（热知识方案 §6.2）──
    //     🔴 **只有总开关打开才挂钩子**——关着的时候**一个监听器都不挂**
    //        （零开销、也不出现在任何事件链上）。
    registerHotInjection({ ctx: scoped as unknown as Context, config })
    diag('hot-injection-registered', config)

    // ── 3c. ⭐⭐ 英文召回索引（设计文档 §9）──
    //     🔴 **只有总开关打开才注册**——关着的时候**不读库、不调模型**（零开销）。
    //     ⚠️ 本函数只做**启动兜底**（索引缺失/封面数对不上才重建）；
    //        "落盘时重建"由 `handoff.ts` 落盘成功后触发。
    try {
      registerEnIndex({ ctx: scoped as unknown as Context, config })
      diag('en-index-registered', config)
    } catch (err) {
      diag(`en-index-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3d. ⭐⭐ 主动注入（设计文档 §5/§7）──
    //     🔴 **只有总开关打开才挂钩子**（同热知识的处置：关着时零开销、
    //        也不出现在任何事件链上）。
    //     ⚠️ 它挂 `llm/stream`（触发 + 攒思考）与 `agent/pre-step`（注入）两个钩子，
    //        与热知识注入**叠加**但互不知情 —— 去重靠"还在不在窗口里"（§7.4①）。
    try {
      // ⭐ **如实报"挂上了没有"**：开关关着时本函数**不挂钩子**并返回 false
      //    ⇒ 诊断行必须区分这两种情况（无条件打一行"已注册"是**假绿**）。
      const hooked = registerActiveInjection({ ctx: scoped as unknown as Context, config })
      diag(hooked ? 'active-injection-registered' : 'active-injection-skipped(disabled)', config)
    } catch (err) {
      diag(`active-injection-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3e. ⭐⭐⭐ 轮次结束时的自动标签规范化（决策 165）──
    //     🔴 **只有开关打开才挂钩子**（同热知识/主动注入的处置：关着时
    //        **一个监听器都不挂**、零开销，也不出现在事件链上）。
    //     ⚠️ 形态照 `registerHotInjection`（它直接 `ctx.on(...)`，
    //        不套 `ctx.effect`）——**与既有实现保持一致**，不另造写法。
    try {
      const hooked = registerTagAutoNormalize({ ctx: scoped as unknown as Context, config })
      diag(hooked ? 'tag-auto-registered' : 'tag-auto-skipped(disabled)', config)
    } catch (err) {
      diag(`tag-auto-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3f. ⭐⭐⭐ 轮末自动知识评分（决策 177；用户裁定）──
    //     🔴 **只有开关打开才挂钩子**（同上面三处：关着时**一个监听器都不挂**）。
    //     ⚠️ 它与 `tag-auto` 挂**同一个事件**（`agent/turn-stopping`）——
    //        两者互不知情、各判各的门；⭐ 都只做"读 + 发起"，绝不 await（serial 钩子）。
    try {
      const hooked = registerAutoScore({ ctx: scoped as unknown as Context, config })
      diag(hooked ? 'score-auto-registered' : 'score-auto-skipped(disabled)', config)
    } catch (err) {
      diag(`score-auto-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3h. ⭐⭐⭐ 「文档内提问」的轮末同步（2026-10-14）──
    //    🔴 **没有总开关**（刻意）：它不是"可选增强"，而是「阅读提问」这条链路的
    //       **必要一半**——不挂的话 chat 条目建出来永远是空的。
    //    ⚠️ 但**零成本**：第一道门（`findBySession`）对非阅读会话直接返回，
    //       而 `bindings.jsonl` 在没人用过阅读功能时根本不存在（读一次 undefined）。
    //    ⚠️ 它挂 `agent/turn-stopping`（与本项目其他 5 处同一事件）⇒
    //       **钩子只发起、绝不 await**（serial 钩子，见 `reading-sync.ts` 的纪律）。
    try {
      const hooked = registerReadingSync(scoped as unknown as Context)
      diag(hooked ? 'reading-sync-registered' : 'reading-sync-skipped(no-session-query)', config)
    } catch (err) {
      diag(`reading-sync-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3i. ⭐⭐⭐ 「文档内提问」的入口与上下文注入（2026-10-14）──
    //    两件事：① 给 `/reading/ask` 装配依赖（要开真会话）；
    //          ② 注册 `context()` 把「被提问条目的全文」注入那个会话。
    //    ⚠️ ② 的 `text()` **必须按 sessionId 过滤**（`context()` 是全局注册的，
    //       不过滤会让所有会话都被塞进同一条文档）⇒ `installDocContext`
    //       自管同步缓存（bindings + 条目正文预热进内存 Map）。
    try {
      // ⚠️ 分两步（顺序有依赖）：
      //   ① `installDocContext()` 只建**同步缓存**并返回 `refresh`（它不自己注册）；
      //   ② 用**同一个 `scoped`** 注册 `context()` ——
      //      🔴 不能在里面再 `ctx.inject([...])`：回调里拿到的 `scoped`
      //         没有 `.inject` 方法（`probe-host.mjs` 抓到过
      //         `ctx.inject is not a function`）⇒ 直接 `scoped.systemPrompt.context(...)`。
      const doc = installDocContext()
      docContextRefresh = doc.refresh
      registerDocContext(scoped, {
        docOf: (id) => doc.index.get(id),
        entryBody: (id) => doc.bodies.get(id),
        entryTitle: (id) => doc.titles.get(id),
      })
      // 🔴🔴 **`readingAsk` 必须用【外层 `ctx`】装配，不能用 `scoped`**（真机踩到）：
      //     第一版用 `scoped` ⇒ `agents.create()` 建出的 agent **tokenUsage 全 0、
      //     title 为 null** ⇒ 模型一次都没被调用（`followup` 提交了但轮次从未开始）。
      //     ⭐ 根因：`scoped` 是 `ctx.inject` 回调的作用域，它随回调结束而失效；
      //       而 `apiHandler` 那条路用的是**外层 `ctx`**（`ctx.get(n)`）
      //       ⇒ 两边不是同一个生命周期，用 scoped 建的 agent 没有活的驱动器。
      //     ⚠️ 只有 `registerDocContext` 必须用 `scoped`（`systemPrompt` 只在那儿）。
      readingAsk = readingAskDeps(ctx, () => {
        if (docContextRefresh !== undefined) void docContextRefresh()
      })
      diag('reading-ask-registered', config)
    } catch (err) {
      diag(`reading-ask-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }

    // ── 3j. ⭐⭐⭐ 轮末上报上下文占用率（决策 226；2026-10-12 用户裁定）──
    //     ⭐ **它把"占用率"这个事实交给模型** ⇒ 「到 60% 就异步沉淀」这类规则
    //        从此**可以写在提示词里**（此前做不到：模型拿不到那个数）。
    //     🔴 **只用 `agent.inject()`**（不唤醒、不额外烧一轮）；
    //        ⛔ 用 `followup()` 会让"每轮报一次"变成"每轮多跑一轮"。
    //     🔴 **只有开关打开才挂钩子**（同上面四处：关着时**一个监听器都不挂**）。
    //     ⚠️ 它与 `tag-auto` / `score-auto` 挂**同一个事件**（`agent/turn-stopping`）——
    //        三者互不知情、各判各的门；⭐ 本模块**同步完成、无 I/O 等待**（不起子代理）。
    try {
      const hooked = registerContextReport({ ctx: scoped as unknown as Context, config })
      diag(hooked ? 'context-report-registered' : 'context-report-skipped(disabled)', config)
    } catch (err) {
      diag(`context-report-THREW ${err instanceof Error ? err.message : String(err)}`, config)
    }
  })

  // ── 4. 路由 ──
  ctx.effect(() => {
    const disposers: Array<() => void> = []

    const apiHandler = async (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ): Promise<void> => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
      const method = (req.method ?? 'GET').toUpperCase()
      // ⭐⭐⭐ **写通道来源闸**（安全评审 F1）——**必须排在读 body 之前**：
      //     先收下一个 1 MB 的跨站 POST 再拒，等于把上面那条 413 限额也变成了攻击面。
      //     ⚠️ 它只管"这个请求是不是面板自己发的"，不管"调用者是谁"（见 `http-guard.ts` 的说明）。
      const verdict = checkWriteOrigin(method, req.headers)
      if (!verdict.ok) {
        res.writeHead(verdict.status ?? 403, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify({ ok: false, error: verdict.error ?? '拒绝写入' }))
        return
      }
      let rawBody = ''
      if (method !== 'GET' && method !== 'HEAD') {
        const chunks: Buffer[] = []
        let total = 0
        for await (const chunk of req) {
          const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : (chunk as Buffer)
          total += buf.length
          if (total > 1024 * 1024) {
            res.writeHead(413, { 'Content-Type': 'application/json; charset=utf-8' })
            res.end(JSON.stringify({ ok: false, error: 'request body too large' }))
            return
          }
          chunks.push(buf)
        }
        rawBody = Buffer.concat(chunks).toString('utf8')
      }
      if (method === 'HEAD') {
        res.writeHead(204)
        res.end()
        return
      }
      try {
        // 🔴 **这里原本是 `await import('./api.ts')`，已改为文件顶部的静态 import。**
        //
        // 原因（2026-09-19 实测踩到）：动态 import 会让打包器把 `api.ts` 拆成
        // **带内容哈希的独立 chunk**（`api-<hash>.js`），而运行中的 DSH 进程内存里持有的是
        // **启动那一刻的 `index.js`**（引用旧哈希）。`pnpm run build` 的 `clean: true`
        // 会删掉旧 chunk ⇒ 动态 import 报 `Cannot find module '.../api-XXXX.js'`，
        // **所有 API 路由 500**。
        //
        // ⚠️ 更坑的是**表现具有欺骗性**：静态页面（`serveWeb`）是**每次请求现读磁盘**的，
        // 所以页面会立刻变新、只有 API 是坏的 ⇒ 看起来"构建已生效"。
        //
        // 改成静态导入后，`api.ts` 会被内联进 `index.js` 主 chunk，
        // 不再存在"旧进程引用已删除 chunk"的问题（版本不一致仍应重启，但不会再 500）。
        const result = await handleApi(
          {
            version, config, baseUrl: ctx.baseUrl, pluginId: PLUGIN_ENTRY_ID,
            // ⭐⭐ 服务查询适配器（2026-09-22）：`get-handoff` 那条判据要读会话日志
            //     （`ctx.get('sessionQuery')`）。⚠️ 只传一个**取值函数**，
            //     不把整个 `ctx` 漏进 API 层（那条边界见 `ApiDeps.getService` 的注释）。
            getService: (n: string) => ctx.get(n as never),
            // ⭐⭐⭐ 「文档内提问」（2026-10-14）：`/reading/ask` 要**开真实会话**，
            //    而那需要 `workspaceRegistry` / `agents` / `agentPresets` /
            //     `agentDefaultModel` 四样服务 ⇒ 只能在有 `ctx` 的地方装配好塞进来。
            //    ⚠️ 装配失败**不影响其他路由**（`handleApi` 里 `readingAsk === undefined`
            //       时只让 `/reading/ask` 回 500）。
            //    ⚠️ 条件展开：`exactOptionalPropertyTypes` 下不能显式传 undefined。
            ...(readingAsk !== undefined ? { readingAsk } : {}),
          },
          method,
          url.pathname,
          rawBody,
          url.searchParams,
        )
        // ⭐⭐ **`raw` 分支：按字节回**（2026-10-19，`/asset` 读图片用）。
        //    🔴 **必须在 JSON 分支【之前】**：图片是二进制，走 `JSON.stringify`
        //       会变成 `{"type":"Buffer","data":[…]}` —— HTTP 200、Content-Type 也对，
        //       但**图片打不开**。这个失败比"路由没注册返回 HTML"更难查（两者都裂图）。
        if (result.raw !== undefined) {
          res.writeHead(result.status, {
            'Content-Type': result.raw.contentType,
            'Content-Length': String(result.raw.bytes.length),
            'Cache-Control': result.raw.cacheControl ?? 'no-store',
          })
          res.end(result.raw.bytes)
          return
        }
        res.writeHead(result.status, {
          'Content-Type': 'application/json; charset=utf-8',
          'Cache-Control': 'no-store',
        })
        res.end(JSON.stringify(result.body))
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
        res.end(
          JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
        )
      }
    }

    // ⚠️ 此列表里**不得有重复项**，也不要带尾斜杠——`webServer.register`
    //    对重复的 (kind, path) **直接 throw**，会把插件整个挂掉。
    for (const path of [
      `${API_BASE}/health`,
      `${API_BASE}/projects`,
      `${API_BASE}/themes`,
      `${API_BASE}/covers`,
      // ⭐⭐ 归档清单（决策 133）——归档页两个子页的数据源（`?kind=entry|project`）。
      //    🔴 **漏了这行就会静默失败**：请求会落到下面的 SPA 兜底、返回 **HTML**，
      //       前端 `JSON.parse` 报错 ⇒ 归档页显示"加载失败"，而服务端**毫无异常**。
      //       ⚠️ 本项目已有专门的测试盯着这一点（`test-web-api.mjs` 的【0】路由注册一致性）。
      `${API_BASE}/archived`,
      `${API_BASE}/nominations`,
      `${API_BASE}/approve`,
      `${API_BASE}/reject`,
      `${API_BASE}/rebuild`,
      // ⭐ 详情数据源（§8.2：按 id 取，不靠前端拼路径）
      `${API_BASE}/entry`,
      // ⭐⭐⭐ **正文里的图片**（2026-10-19）——`/asset?entry=<id>&path=<相对路径>`。
      //    🔴 **漏了这行就静默失败**：请求落到 SPA 兜底、返回 **HTML** ⇒
      //       浏览器把它当图片 ⇒ 图**全裂**，而服务端**毫无异常**、HTTP 也 200。
      //       ⚠️ 这是本项目第 N 次踩同一个形状（`/models`、`/archived`、`/jev-status`…），
      //          靠的仍是 `test-web-api.mjs`【0】那条路由一致性检查当场抓。
      `${API_BASE}/asset`,
      `${API_BASE}/project`,
      // ⭐ 主题详情（决策 106，与 `/project` 对称）——供主题页右栏
      `${API_BASE}/theme`,
      // ⭐ 非法封面的原始块（供修复表单预填，§8.6）
      `${API_BASE}/block`,
      // ⭐ 修复写通道（§8.6 / 决策 88/89/91）——**只有人能调**
      `${API_BASE}/fix-cover`,
      `${API_BASE}/fix-ref`,
      // ⭐ 设置（§8.8 / 决策 97）——改当前 profile 的 `cordis.patch.yml`
      `${API_BASE}/settings`,
      // ⭐⭐ 英文召回索引（设计文档 §9.2）：翻译模型的**下拉框数据源**
      //    🔴 **漏了这行会静默失败**：请求落到 SPA 兜底、返回 **HTML**，
      //       前端 `JSON.parse` 报错 ⇒ 模型下拉框永远空着，而服务端**毫无异常**。
      `${API_BASE}/models`,
      // ⭐⭐ JEV 凭据就绪探针（本次新增）——供设置面板的 jev 通路提示用。
      //    🔴 漏注册 ⇒ 请求落到 SPA 兜底、返回 HTML ⇒ 前端 json 解析失败、
      //       jev 未配置提示永远出不来，而服务端毫无异常（同 `/models` 那类老坑）。
      `${API_BASE}/jev-status`,
      // ⭐⭐⭐ **决策模型（JEV）配置页的三个动作**（用户 2026-10-07 要求）。
      //    🔴 **漏注册 ⇒ 请求落到 SPA 兜底、返回 HTML** ⇒ 前端 `JSON.parse` 报错，
      //       而服务端**毫无异常**（同 `/models`、`/archived` 那类老坑）。
      //    ⚠️ 本轮**真的漏了这三个**，是 `test-web-api.mjs` 的【0】路由注册一致性
      //       当场抓到的（**不是靠记性**）—— 那条测试就是为这类事存在的。
      `${API_BASE}/jev/key`,
      `${API_BASE}/jev/key/clear`,
      `${API_BASE}/jev/test`,
      // ⭐⭐ 英文召回索引的**「检查并补全」**（用户 2026-09-26 要求）
      //    🔴 同上：漏注册 ⇒ 请求返回 HTML ⇒ 按钮报"检查失败"，而服务端毫无异常。
      `${API_BASE}/index-check`,
      // ⭐⭐ 备份与版本维护（决策 135）——探测 git 环境 / 初始化仓库
      //    🔴 **漏了这两行会静默失败**：请求落到 SPA 兜底、返回 HTML，
      //       前端 JSON.parse 报错 ⇒ 设置卡片"检测环境失败"，而服务端毫无异常。
      `${API_BASE}/backup/status`,
      `${API_BASE}/backup/setup`,
      // ⭐⭐ 封面删改通道（决策 114）——与 `memj_promote` 工具同一实现
      `${API_BASE}/edit`,
      // ⭐⭐ 热知识（热知识方案 §8.4）——热知识页三个子导航的数据源
      //    🔴 **漏了这几行会静默失败**：请求落到 SPA 兜底、返回 HTML，
      //       前端 JSON.parse 报错 ⇒ 页面显示"加载失败"，而服务端毫无异常。
      //       ⚠️ 本项目已因同一原因踩过两次（`/archived` 与 `/backup/*`）。
      `${API_BASE}/hot`,
      `${API_BASE}/hot/projects`,
      `${API_BASE}/hot/persona`,
      `${API_BASE}/hot/selection`,
      `${API_BASE}/hot/bind`,
      `${API_BASE}/hot/item`,
      `${API_BASE}/hot/global`,
      // ⭐⭐ 主动注入的实时状态（设计文档 §10.4）——同上：漏了会**静默返回 HTML**。
      `${API_BASE}/active`,
      // ⭐⭐⭐【提示词】子页（2026-09-29 新增）——**同上**：
      //    🔴 我第一版加了 API 分支却**没在这里注册** ⇒ `test-web-api.mjs` 当场抓住
      //    （"这些请求会落到 SPA 兜底、返回 HTML 而不是 JSON"）——这正是本段开头
      //    那句警告的情形，也是本项目已踩过两次的老坑（`/archived` 与 `/backup/*`）。
      `${API_BASE}/prompts`,
      `${API_BASE}/prompt`,
      `${API_BASE}/prompt/save`,
      `${API_BASE}/prompt/reset`,
      `${API_BASE}/prompt/history`,
      // ⭐ 回退到某一版历史（"备份回退"的第二个方向）。
      `${API_BASE}/prompt/restore`,
      // ⭐⭐⭐ 写回源码（2026-10-12 新增）——**同一个坑又踩了一次**：
      //    我加了 `api.ts` 的分支却漏了这里 ⇒ `test-web-api.mjs` 当场抓住
      //    （"未注册：/prompt/writeback —— 会落 SPA 兜底、返回 HTML"）。
      //    ⭐ 这条断言**每次都跑**，所以"两份清单"不会静默漂开——留在这里当样例。
      `${API_BASE}/prompt/writeback`,
      // ⭐⭐⭐【模板】子页（决策 204/205）——**同上**：
      //    🔴 漏了这三行 ⇒ 模板页"加载失败"（请求落 SPA 兜底返回 HTML），
      //       而服务端毫无异常。本项目已因同一原因踩过三次。
      `${API_BASE}/templates`,
      `${API_BASE}/template/save`,
      `${API_BASE}/template/delete`,
      // ⭐⭐⭐【知识类型词表】（2026-10-05 收敛）——**前端所有 kind 下拉的唯一数据源**。
      //    🔴 **实测：漏注册当场被既有断言抓到**（`test-web-api` 的"路由注册一致性"报
      //      `⚠️ 未注册：/kinds —— 这些请求会落到 SPA 兜底、返回 HTML 而不是 JSON！`）。
      //    ⭐ 这正是本条注释开头说的那类事故 —— **不是靠记性，是靠那条断言**。
      `${API_BASE}/kinds`,
      // ⭐⭐ 决策 215：类型表的**写通道**（保存整张表 / 删一条）。
      //    🔴 与 `/kinds` 一样 —— **漏注册会静默落到 SPA 兜底返回 HTML**
      //      （`test-web-api` 的"路由注册一致性"会当场抓到）。
      `${API_BASE}/kind/save`,
      // ⭐⭐ 2026-10-05：**单条**保存（设置页改成"收起列表 + 每条各自保存"后新增）。
      //    ⚠️ 与上面几条一样 —— **漏注册会静默落到 SPA 兜底返回 HTML**
      //      （`test-web-api` 的"路由注册一致性"会当场抓到）。
      `${API_BASE}/kind/upsert`,
      `${API_BASE}/kind/delete`,
      // ⭐⭐⭐「文档内提问」（2026-10-14）——**同一个坑第四次**：
      //    我加了 `api.ts` 的分支却漏了这里 ⇒ `test-web-api` 当场抓住
      //    （"未注册：/reading/ask —— 会落 SPA 兜底、返回 HTML 而不是 JSON"）。
      //    🔴 **它比前几次更毒**：前端拿不到 JSON 会报"提问失败"，
      //       而服务端其实**已经建好了会话和 chat 条目**（分支执行了、只是响应丢了）
      //       ⇒ 用户会重复点，每点一次就多开一个会话。
      //    ⭐ 这条断言**每次都跑** ⇒ "两份清单"不会静默漂开。
      `${API_BASE}/reading/ask`,
      // ⭐⭐「文档内提问」第 6 期：阅读页画**段落标记**的数据源（一次回全部绑定）。
      //    🔴 **同一个坑的第五次**：漏注册 ⇒ 段落标记全部不显示
      //      （前端拿到 HTML ⇒ JSON.parse 失败 ⇒ 静默无标记），而服务端毫无异常。
      `${API_BASE}/reading/bindings`,
      // ⭐⭐「文档内提问」第 6 期：**服务端算好的块清单**（含 blockId + 纯文本）。
      //    🔴 **它存在的唯一理由**：前端只有渲染后的 DOM（`**` 已被吃掉）⇒
      //      自己算哈希与后端对不上 ⇒ 段落标记永远不显示（库内实测：
      //      原文 `1mpx8by` vs 渲染后 `191ccmm`）。
      //    ⚠️ 同样是"两份清单"的坑：漏注册 ⇒ 块清单拿不到 ⇒ **标记与工具条全废**。
      `${API_BASE}/reading/blocks`,
      // ⭐⭐⭐ **面板内升级**（2026-10-20，用户要求）——查新版 / 执行升级 / 看进度。
      //    🔴 **漏注册 ⇒ 请求落到 SPA 兜底、返回 HTML** ⇒ 前端 JSON.parse 失败
      //       ⇒ 头部的「检测到有新版本」永远不出现，而服务端**毫无异常**。
      //       这是本项目第 N 次踩同一个形状（`/models`、`/archived`、`/asset`…）。
      `${API_BASE}/update`,
      `${API_BASE}/upgrade`,
      `${API_BASE}/upgrade/status`,
      // ⚠️ 探针路由**不在这里**注册——它有自己的 handler，见下面单独的
      //    `webServer.register`。🔴 我第一版**两处都注册了** ⇒
      //    `duplicate exact route` ⇒ **整个插件 apply 抛错、实例起不来**
      //    （正是本段开头那句注释警告的情形）。
    ]) {
      disposers.push(webServer.register({ kind: 'exact', path, handler: apiHandler }))
    }

    // ── 人侧页面（§10 的 `web/`）──
    // ⚠️ `prefix` 必须**比 `/plugins` 长**，否则会被 dsh-client-modules 的
    //    宽前缀吃掉（见文件头）。这里 `/plugins/dsh-memj` 更长 ⇒ 必胜。
    disposers.push(
      webServer.register({
        kind: 'prefix',
        path: PLUGIN_BASE,
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
          const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
          void serveWeb(url.pathname, res)
        },
      }),
    )

    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* 已卸载 */
        }
      }
    }
  }, 'dsh-memj: routes')
}

// ── 对外导出（探针与离线工具复用纯逻辑）──
// ⚠️ `PROTOCOL_TEXT` / `PROTOCOL_SECTION_ORDER` 一并导出：
//    探针要离线断言"协议文本与设计文档 §6 逐字节一致"，不导出就没法验。
export { PROTOCOL_TEXT, PROTOCOL_SECTION_ORDER, protocolText } from './protocol.ts'
// ⭐⭐⭐ **提示词覆盖层**（2026-09-29）一并导出：
//    测试（`scripts/test-prompt-override.mjs`）要直接验校验规则 / 覆盖优先级 /
//    运行期生效 / 恢复默认 / 历史备份这些**纯逻辑**（不必起服务）。
export * from './prompts.ts'
// ⭐⭐ 提示词目录（2026-10-12）：人读文案（分组 / 用途 / 归属）的唯一出处。
//    导出它是为了：① `api.ts` 回分组说明；② `check-prompt-specs.mjs` 做**双向覆盖校验**。
export * from './prompt-catalog.ts'
// ⭐⭐⭐ 写回源码（2026-10-12）——单独模块：它要 import `paths.ts` 的 `pluginRoot()`，
//    而 `prompts.ts` 是**叶子模块**（不 import 任何提示词源模块，见其模块头注释）
//    ⇒ 把写回逻辑塞进 `prompts.ts` 会破坏那条依赖纪律。
export * from './prompt-writeback.ts'
export * from './parse.ts'
export * from './paths.ts'
export * from './read.ts'
export * from './reads.ts'
export * from './schema.ts'
// ⭐⭐⭐ 决策 215：知识类型（`kind`）的**可配置词表**（`<库根>/kinds.md`）。
//    ⚠️ 它必须与 `schema.ts` 一起导出 —— 后者的 `ENTRY_KIND_DEFS` 自本决策起
//    **降级为"内置默认值"**，而"当前生效的那份"由本模块提供。
export * from './kinds.ts'
export * from './search.ts'
export * from './store.ts'
// ⭐⭐⭐ 「文档内提问」（2026-10-14）：锚点四元组 + 段落⇄会话绑定 + 同步游标。
//    ⚠️ 它被 `api.ts`（`/api/reading/*`）与后续的 `sync.ts` 静态 import
//    ⇒ 与 `store.ts`/`edit.ts` 同批导出（那两条也是这个理由）。
export * from './reading.ts'
// ⭐⭐⭐ **面板内升级**（2026-10-20）：`cmpVer` / `buildUpgradeArgs` / `detectProfile`
//    全是**纯函数** ⇒ `scripts/test-upgrade.mjs` 要直接调它们做离线断言
//    （版本比较的边界、`--registry=` 的等号形式、profile 探测）。
//    ⚠️ `startUpgrade` 会真的 spawn 一个子进程 ⇒ 测试**不要**调它。
export * from './upgrade.ts'
// ⭐⭐⭐ 「文档内提问」的**轮末同步**（2026-10-14）：turn/end ⇒ readSurface ⇒ 按游标取增量
//    ⇒ 只取 text block ⇒ 追加进 chat 条目。
//    ⚠️ 它被 `index.ts` 的 `apply()` 静态 import（挂 session/event 监听）
//    ⇒ 同上，必须与 `reading.ts` 同批导出。
export * from './reading-sync.ts'
// ⭐⭐⭐ 「文档内提问」的**入口与上下文注入**（2026-10-14，第 4 期）。
//    ⚠️ 它被 `api.ts` 静态 import（`/reading/ask`）与 `apply()` 静态 import
//    ⇒ 同上必须导出（测试脚本也直接从 `lib/index.js` 取这几个函数）。
export * from './reading-ask.ts'
export * from './reading-context.ts'
// ⭐⭐⭐ 决策 204/205：交接文档模板（存储 + 校验）与工具决策（两段式确认）。
export * from './templates.ts'
export * from './template-tool.ts'
// ⚠️ `settings` 一并导出：它被**静态 import** ⇒ 打包器把它内联进本 chunk
//    （`lib/settings.js` **根本不存在**，同 `api.ts` 的形态）。
//    测试脚本（`scripts/test-theme-mode.mjs`）要直接验它的路径解析与 YAML 定点改写。
export * from './settings.ts'
// ⚠️ `parseStepRequest` 一并导出（静态 import ⇒ 内联进本 chunk）：
//    测试要直接验"命令参数识别"这段纯逻辑（决策 101）。
export { parseStepRequest } from './commands.ts'
// ⚠️ `gate` 同理（静态 import ⇒ 内联进本 chunk）：
//    测试脚本（`scripts/test-gate.mjs`）要直接验闸门的纯函数与注册函数。
export * from './gate.ts'
// ⚠️ `inject`（取交接的三档渲染）同理：纯函数 + 读库，
//    测试（`scripts/test-get-handoff.mjs`）要直接验**档位差异与去重**。
export * from './inject.ts'
// ⭐⭐ **英文召回索引**（设计文档 §9）一并导出：测试要直接验
//    `descHash` / **漏翻判据** / 路由解析这些**纯逻辑**（不需要起服务）。
export * from './en-index.ts'
// ⚠️ `active-*` 一并导出（静态 import ⇒ 内联进本 chunk）：测试脚本要跑**真实入口**。
export * from './active-recall.ts'
// ⭐⭐⭐ 上下文裁取 + token 预算（用户 2026-09-26 方案）：
//     turn 级裁剪 / 候选池裁剪 / 估算器 —— 纯函数，测试脚本要直接调。
export * from './active-context.ts'
export * from './active-inject.ts'
// ⭐⭐ **热知识注入**（热知识方案）：数据层 + 判定 + 渲染 + 两个钩子
//    ⇒ 测试与探针要直接验"判定算法 / 分层去重 / 两种形态的渲染 / 缺哪条补哪条"。
export * from './hot.ts'
export * from './hot-inject.ts'
export * from './hot-watch.ts'
// ⭐⭐⭐ **标签规范化**（决策 162）：词表（source data）+ 三层算法。
//    ⚠️ 与 `tags.ts`（v1 的静态规则表，**已删除**）不同 —— 这里没有硬编码映射，
//       判断由模型做、结论积累进**词表**。
export * from './tag-vocab.ts'
export * from './tag-normalize.ts'
// ⭐⭐⭐ 轮次结束自动规范化（决策 165）：三层门是纯函数 ⇒ 测试要直接调。
export * from './tag-auto.ts'
// ⭐⭐⭐ 它的**记账**（决策 167，修正 165 的判据）—— 纯函数同样要能被测试直接调。
export * from './tag-auto-state.ts'
// ⭐⭐⭐ **子代理"发起方"登记表**（2026-09-29 用户裁定：LLM 发起的子代理继承
//    父会话项目、插件发起的不继承）。⚠️ 测试要直接调 `markPluginSpawned`
//    来模拟"插件发起"那条路 —— 否则测不出"不继承"这一半。
export * from './subagent-origin.ts'
// ⭐⭐⭐ **轮末知识评分**（决策 177）：纯函数层（窗口/档位/前 N）要能被测试直接调。
export * from './hot-score.ts'
export * from './hot-score-store.ts'
export * from './score-log.ts'
export * from './score-turn.ts'
// ⭐⭐⭐ **chat 通路**（决策 178）：它的**解析器**（越界/去重/JSON 校验）要能被测试直接调
//    —— 那是"模型输出不可信"的唯一防线，必须单独验。
export * from './score-chat.ts'
export * from './score-auto.ts'
// ⭐⭐⭐ **轮末上下文占用上报**（决策 226）：纯函数层（读测量 + 渲染文本）要能被测试直接调
//    —— ⚠️ "拿不到就静默跳过"这条是本功能的主要失败模式，必须单独验。
export * from './context-report.ts'
export * from './context-auto.ts'
// ⚠️ 形状校验函数一并导出：闸门（`gate.ts`）与 `runHandoff` **共用同一份实现**，
//    测试要直接验"两处确实是同一套规则"（§3.11.6）。
export {
  runHandoff,
  validateAllCovers,
  checkEntryShape,
  checkAdoptShape,
  checkKnowledgeShape,
  planSteps,
  HANDOFF_STEP_ORDER,
  // ⭐⭐ 决策 134：按节操作（`docSection` + `docOp`）——纯函数，测试与探针可直接验。
  applySectionOp,
  findEmptySections,
  // ⭐⭐⭐ 决策 209：叙事合并/规范化——**规范块的剥离与回填就在这两处**，
  //    所以它们必须可被测试直接验（`test-spec-block.mjs` 的 R1/R2 反证靠它）。
  mergeNarrative,
  normalizeNarrative,
  // ⭐⭐⭐ 决策 216：把模板的规范块**插进已有叙事**（建项目与存量迁移共用这一条路径）。
  //    🔴 导出它是为了**消灭第二份副本** —— 迁移脚本原先只能自己重抄一份 `insert()`。
  insertSpecBlocks,
  // ⭐⭐⭐ 决策 156：挂靠依据核对（`themeWhy` 有没有逐字引所挂主题的 desc）——纯函数。
  quoteAppearsIn,
  // ⭐⭐⭐ 决策 223：算各节字符数（**"强提醒"的原料** —— 工具不再自动归档，
  //    改成把它量不出来的那个数字报给模型）。测试要直接验它。
  measureSections,
} from './handoff.ts'
export type {
  HandoffRequest,
  HandoffResult,
  HandoffEntry,
  NewThemeRequest,
  AdoptRequest,
  HandoffStep,
  DocOp,
  SectionOpResult,
} from './handoff.ts'
// ⚠️ `handleApi` 一并导出：测试脚本要直接跑**与真实路由同一入口**的处理器
//    （`scripts/test-web-api.mjs`）。它现在是静态导入，导出即内联进主 chunk。
// ⭐⭐ `assetBaseDirOf` / `resolveAssetPath` 一并导出（2026-10-19）：
//    `scripts/test-asset.mjs` 要**直接验那两个纯函数**（越界判据、扩展名白名单），
//    不必起服务、也不必造一个真实例。⭐ 与 `handleApi` 同一理由：**测真实入口**。
export { assetBaseDirOf, handleApi, resolveAssetPath } from './api.ts'
// ⭐⭐⭐ **写通道来源闸**（安全评审 F1，2026-10-22）：请求头**只有路由层拿得到**
//     （`handleApi` 的签名里没有 `req`，那是有意的 —— API 层不该知道 HTTP 细节），
//     所以这道闸只能装在这里。
import { checkWriteOrigin } from './http-guard.ts'
// ⭐⭐ **封面删改通道**（决策 114）——实现只有一份（`edit.ts`），
//    LLM 侧（`memj_promote`）与人侧（网页 API）**共用**；
//    这里导出是为了让测试能直接验"两侧确实调的是同一套实现"。
export * from './edit.ts'
// ⭐⭐⭐ 安全评审（2026-10-22）：来源闸与不可信边界都要能被测试**直接验**
//     （与 `handleApi` 同一理由：测真实入口，不测副本）。
export * from './http-guard.ts'
export * from './untrusted.ts'
