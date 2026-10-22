/**
 * 库根与路径解析（方案 §2.2 / §2.5）。
 *
 * ```
 * ~/.dsh-memj/                    # ★ 整个库 = 一个目录，拷走即迁移
 * ├─ projects/HANDOFF-<项目>.md   # 项目层：唯一写入源头（六节叙事 + 底部封面清单）
 * ├─ entries/<slug>-<uuid8>.md    # 内部条目正文（一条知识一个文档）
 * ├─ themes/THEME-<id>.md         # 主题层：派生
 * ├─ GLOBAL.md                    # 全局层：派生
 * ├─ reads/session-<id>.jsonl     # 读快照（一个会话一个文件）
 * ├─ doc-reads/session-<id>.jsonl # ⭐ 项目文档读记录（决策 112，与读快照平行）
 * ├─ nominations.json             # 待批 global 提名
 * ├─ backup/                      # ⭐⭐ 备份与版本维护（决策 135 / 136）
 *     ├─ .git/                    # git 仓库根
 *     ├─ .gitignore               # 白名单（只放行 narrative/<项目>.md）
 *     └─ HANDOFF-<项目>.md        # 正文镜像（git 维护的对象，无封面）
 * ```
 *
 * 🔴 **`backup/` 不在任何既有消费者的扫描范围内**：`scanLibrary()` 只扫 `projects/`
 *    （见 `store.ts`），所以新增这个目录**对既有逻辑零影响**。
 *
 * ⭐⭐ **镜像不再放子目录**（决策 136，用户裁定）：以前是 `backup/narrative/`，
 *    现在直接在 `backup/` 根下 —— 因为**台账（`backup/snapshot/`）已删除**，
 *    备份目录里只剩镜像一类东西，再套一层子目录没有收益（只有更长的路径）。
 *
 * 🔴 **为什么是用户主目录**（§2.2 的三选一）：
 *  - 放工作区 ⇒ 与「取用不靠物理路径」冲突，且没法整体迁移；
 *  - 放 `$DSH_HOME` ⇒ 绑死具体安装，换版本要搬，且多实例各一份又回到同步老路；
 *  - `~/.dsh-memj/` ⇒ 脱离工作区与实例，**拷一个目录即完成迁移**。
 *
 * @module dsh-memj/paths
 */

import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * ⭐⭐⭐ **插件仓根**（2026-10-12 新增）——「写回源码」功能的定位基准。
 *
 * 🔴 **为什么需要它**：写回要把覆盖文本替换进 `src/*.ts` 的模板串，而这需要一个
 *   **插件自己的安装位置**。此前所有路径都只指向库根（`~/.dsh-memj`），
 *   插件**完全不知道自己源码在哪** ⇒ 写回无从下手。
 *
 * ⭐ **怎么定位**：本模块编译后在 `<仓根>/lib/*.js`（`package.json` 的 `main` 是 `lib/index.js`）
 *   ⇒ `import.meta.url` 往上一级就是仓根。**这是最可靠的**——它跟着实际加载的文件走，
 *   不依赖 `process.cwd()`（那会随调用方变）、也不依赖任何配置项。
 *
 * ⚠️ **边界**：本函数**只给"写回源码"用**，不要把库内数据路径改到这里——
 *   库根（`libraryRoot()`）与插件仓**是两回事**（前者是用户数据、后者是交付物）。
 *   本项目的铁律：**用户数据放库根，绝不写进插件仓**。
 * @returns 插件仓根绝对路径。
 */
export function pluginRoot(): string {
  // `lib/paths.js` → 上一级 = 仓根。⚠️ 用 fileURLToPath 而不是手工切字符串，
  // 否则 Windows 的盘符与 URL 编码（空格成 %20）会出错。
  const here = fileURLToPath(import.meta.url)
  return resolve(join(here, '..', '..'))
}

/**
 * 库根：`$MEMJ_DATA_DIR`（为空则回落 `~/.dsh-memj`）。
 *
 * ⚠️ **空白环境变量视为未设置**——沿用 `dsh-home-paths` 对 `$DSH_HOME` 的同一约定，
 * 避免 `MEMJ_DATA_DIR=` 这种写法把库根解析成空串。
 * @returns 库根绝对路径。
 */
export function libraryRoot(): string {
  const override = process.env['MEMJ_DATA_DIR']
  if (override !== undefined && override.trim() !== '') return resolve(override.trim())
  return join(homedir(), '.dsh-memj')
}

/** 项目文档目录（唯一写入源头）。 */
export function projectsDir(): string {
  return join(libraryRoot(), 'projects')
}

/** 内部条目正文目录。 */
export function entriesDir(): string {
  return join(libraryRoot(), 'entries')
}

/** 主题派生文档目录。 */
export function themesDir(): string {
  return join(libraryRoot(), 'themes')
}

/** 全局层派生文档。 */
export function globalDocPath(): string {
  return join(libraryRoot(), 'GLOBAL.md')
}

/** 读快照目录。 */
export function readsDir(): string {
  return join(libraryRoot(), 'reads')
}

/**
 * ⭐ **项目文档读记录目录**（决策 112）。
 *
 * 🔴 **为什么不复用 `reads/`**：读快照的语义是"**跨项目证据**"
 * （参与新建主题的闸门判定），且它的结构是**知识封面专用**
 * （`entryId`/`theme`/`owner`）——装不下一份项目文档。
 * 混在一起会让"读过别项目知识"与"读过本项目文档"互相污染。
 */
export function docReadsDir(): string {
  return join(libraryRoot(), 'doc-reads')
}

/** 提名文件。 */
export function nominationsPath(): string {
  return join(libraryRoot(), 'nominations.json')
}

/**
 * ⭐⭐ **主动召回的调用日志目录**（2026-09-27 新增）。
 *
 * 🔴🔴 **为什么必须有它**（用户原话：*"主动召回注入有专门的日志吗？我觉得应该要维护个
 *    日志记录每次得调用详情，不然调试起来太麻烦了。"*）：
 *    在此之前，召回的结论**只在内存里**（`activeState.last` 那几个 Map）——
 *    ⚠️ 于是有**三重丢失**：① 重启即失；② `last` 只留**最近一次**（前几次被覆盖）；
 *    ③ 连"三个总控分数"（`need`/`sufficient`/`search_intent`）**算完就丢**。
 *    实测后果：用户报"看不到注入"时，只能**解压会话日志反推**——因为插件自己什么都没记。
 *
 * ⚠️ **为什么不复用 `reads/`**（同 `docReadsDir` 的理由）：
 *    那个的语义是"**跨项目证据**"（参与新建主题的闸门），结构是**知识封面专用**；
 *    混在一起会让"读过什么知识"与"召回判了什么"互相污染。
 */
export function recallLogDir(): string {
  return join(libraryRoot(), 'recall-log')
}

/**
 * 某会话的**主动召回日志**：`recall-log/session-<id>.jsonl`（一行一次调用）。
 * @param sessionId - 会话 id。
 * @returns 日志文件绝对路径。
 */
export function recallLogPath(sessionId: string): string {
  return join(recallLogDir(), `session-${safeName(sessionId)}.jsonl`)
}

/**
 * ⭐⭐⭐ **知识评分日志目录**：`<库根>/score-log/`（决策 177）。
 *
 * 🔴 **为什么不复用 `recall-log/`**（同 `docReadsDir` / `recallLogDir` 的理由）：
 *    那个的语义是"**主动召回**（实时、逐 step）判了什么"；
 *    这个是"**轮末复盘评分**（逐 turn）给谁加了分"。
 *    两者**时机、判据、频率都不同** ⇒ 混在一起会让"召回判了什么"与"复盘评了什么"互相污染，
 *    而且排障时无法按类型过滤。
 */
export function scoreLogDir(): string {
  return join(libraryRoot(), 'score-log')
}

/**
 * 某会话的**评分日志**：`score-log/session-<id>.jsonl`（一行一次评分）。
 * @param sessionId - 会话 id。
 * @returns 日志文件绝对路径。
 */
export function scoreLogPath(sessionId: string): string {
  return join(scoreLogDir(), `session-${safeName(sessionId)}.jsonl`)
}

/**
 * ⭐⭐⭐ **知识评分表**：`<库根>/hot/scores.json`（决策 177）。
 *
 * ⚠️ **它放在 `hot/` 下**（与 `persona/entries/selection/sessions` 同目录）——
 *    因为它服务的是**热知识注入**（用户裁定：*"这个功能其实是属于热知识注入的板块"*），
 *    与 `hot/` 其余文件的**生命周期、归属（按项目）都一致**。
 *
 * 🔴 **它是 source data、不是 derived data**（同 `tags/vocabulary.json` 的道理，
 *    但**更弱一档**）：分数是**积累出来的**，删了要重新攒；
 *    ⚠️ 但它**有天然的自我修复**（每轮复盘都会重新加分）⇒ 丢了不会永久损失，
 *    只是"前 20 名"会空一阵子。⇒ ⭐ **不必像词表那样严防"重建"**，
 *    但**也不要主动删**（那会让功能退化成"从零开始"）。
 */
export function scoreFilePath(): string {
  return join(hotDir(), 'scores.json')
}

/**
 * ⭐⭐⭐ **标签规范词表目录**：`<库根>/tags/`（决策 162）。
 *
 * 🔴🔴 **它与 `recall/`（英文召回索引）是【两种数据】，健康检查的方式完全不同**：
 *
 * | | `recall/en-index.json` | `tags/vocabulary.json` |
 * |---|---|---|
 * | 怎么来 | **纯投影**（重翻一遍就能重建） | **积累的判断**（人和 LLM 的裁决） |
 * | 丢了怎么办 | 重跑就有 | 🔴 **永久丢失** |
 * | 所以 | "全量重建 + diff" | ⚠️ **只能增量对账，绝不能重建** |
 *
 * ⇒ 它是 **source data，不是 derived data**。⚠️ 别照抄 `en-index` 那套"重建"逻辑
 * （那会把积累的裁决**静默抹掉**，而且看起来像"修好了"）。
 */
export function tagsDir(): string {
  return join(libraryRoot(), 'tags')
}

/**
 * 标签规范词表的唯一落盘位置：`tags/vocabulary.json`（决策 162）。
 *
 * ⚠️ **`lastRunAt`（水位线）与词表【同一个文件】**（用户 2026-09-28 裁定）——
 * 它俩要么一起更新、要么一起不动：若分两个文件，就会出现
 * "水位线推了、词表没落盘" ⇒ **那批新 tag 永久跳过**（下次水位线已经越过它们了）。
 */
export function tagVocabularyPath(): string {
  return join(tagsDir(), 'vocabulary.json')
}

/**
 * ⭐⭐⭐ 自动规范化的**记账**位置：`tags/auto-state.json`（决策 167）。
 *
 * 🔴 **为什么要有它**：决策 165 的"三层门"里，门②/门③ 靠**读会话日志**判断，
 *    而两者都失效 —— 门② 是**会话级**判据（一旦落过知识就永远为真，
 *    ⇒ **之后每一轮都起子代理**）；门③ 去查父会话里的 `memj_normalize_tags`
 *    调用，而**那次调用在子会话里**（⇒ 父会话永远看不到 ⇒ **去重恒不生效**）。
 *
 * ⭐ **用户给的判据**（2026-09-28）：*"应该是只有有知识沉淀的轮次才跑啊，
 *    这个需要插件用脚本去校验。"*
 *    ⇒ 改成**插件自己在落知识那一刻记一笔**（**轮次**为单位），不再事后读日志猜。
 *
 * ⚠️ 它是**优化去重**用的：损坏/丢失的最坏后果只是"多起一次子代理"，
 *    ⇒ 读取一律回空、**绝不让轮次结束失败**。
 */
export function tagAutoStatePath(): string {
  return join(tagsDir(), 'auto-state.json')
}

// ───────────────────────────────────────────────────────────────────────────
// ⭐⭐ 备份与版本维护（决策 135）
//
// 🔴 **为什么三类路径必须收在这里**：本项目"两份实现必然漂移"的老坑。
//    备份模块、git 模块、探针都要拼这些路径 ⇒ 只允许有一处实现。
// ───────────────────────────────────────────────────────────────────────────

/**
 * 备份根目录：`<库根>/backup/`（决策 135 / 136）。
 *
 * ⭐ **它既是数据目录、也是 git 仓库的根**（`.git` 就在它里面）
 * ⇒ 整个 `backup/` 是一个**可整体搬走 / 可整体删除**的单元。
 */
export function backupDir(): string {
  return join(libraryRoot(), 'backup')
}

/**
 * 某项目的**正文镜像**路径：`backup/HANDOFF-<项目>.md`。
 *
 * ⭐⭐ **不再有 `narrative/` 子目录**（决策 136，用户裁定）：
 *    台账（`backup/snapshot/`）已删除，备份目录里只剩镜像一类东西
 *    ⇒ 再套一层子目录没有收益。
 *
 * ⚠️ **与活跃文档同名、不同目录**（`projects/HANDOFF-<项目>.md`）——
 * 靠目录区分，不引入第二套命名规则。
 * @param projectId - 项目 id。
 * @returns 绝对路径。
 */
export function backupNarrativePath(projectId: string): string {
  return join(backupDir(), `HANDOFF-${safeName(projectId)}.md`)
}

/**
 * 某会话的读快照文件：`reads/session-<id>.jsonl`（§3.8.1）。
 * @param sessionId - 会话 id。
 * @returns 快照文件绝对路径。
 */
export function readLogPath(sessionId: string): string {
  return join(readsDir(), `session-${safeName(sessionId)}.jsonl`)
}

/**
 * ⭐ 某会话的**项目文档读记录**：`doc-reads/session-<id>.jsonl`（决策 112）。
 * @param sessionId - 会话 id。
 * @returns 读记录文件绝对路径。
 */
export function docReadLogPath(sessionId: string): string {
  return join(docReadsDir(), `session-${safeName(sessionId)}.jsonl`)
}

/** 某项目的 handoff 文档路径。 */
export function projectDocPath(projectId: string): string {
  return join(projectsDir(), `HANDOFF-${safeName(projectId)}.md`)
}

/** 某主题的派生文档路径。 */
export function themeDocPath(themeId: string): string {
  return join(themesDir(), `THEME-${safeName(themeId)}.md`)
}

/**
 * 内部条目的正文路径（库内相对路径，§2.5）。
 *
 * **库里存的 `ref` 就是这个相对形式**（`entries/<slug>-<uuid8>.md`），
 * 迁移时不受任何影响。
 * @param slug - 英文短名。
 * @param uuid - 完整 UUID（取前 8 位入文件名）。
 * @returns 相对库根的路径，**始终用正斜杠**。
 */
export function entryRelPath(slug: string, uuid: string): string {
  return `entries/${entryFileName(slug, uuid)}`
}

/**
 * 条目文件名：`<slug>-<uuid前8位>.md`（§3.4）。
 * @param slug - 英文短名。
 * @param uuid - 完整 UUID。
 * @returns 文件名。
 */
export function entryFileName(slug: string, uuid: string): string {
  const safeSlug = slug.trim() === '' ? 'entry' : slug.trim()
  return `${safeSlug}-${uuid.slice(0, 8)}.md`
}

/**
 * 把库内相对路径解析成绝对路径。
 *
 * ⚠️ **拒绝逃逸出库根**——外部的 `ref` 可能来自人手改的文档，
 * 不校验会让 `../../` 读到库外。
 * @param rel - 库内相对路径。
 * @returns 绝对路径；逃逸或为空时返回 `undefined`。
 */
export function resolveInsideLibrary(rel: string): string | undefined {
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '')
  if (normalized.length === 0) return undefined
  // 逐段检查深度，避免 `a/../..` 这类绕过。
  let depth = 0
  for (const segment of normalized.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      depth -= 1
      if (depth < 0) return undefined
      continue
    }
    depth += 1
  }
  return join(libraryRoot(), ...normalized.split('/').filter((s) => s !== '' && s !== '.'))
}

/**
 * 解析封面 `ref` 指向的正文绝对路径（§3.3 / §3.6）。
 *
 * - **内部条目**：库内相对路径 ⇒ 拼到库根；
 * - **外部引用**（`ext: true`）：`ref` 是绝对路径，**必须落在 `extRoots()` 之内**
 *   （安全评审 F3：0.1.5 是"原样使用"⇒ 内容可以指挥工具去读任意文件）。
 * @param ref - 封面上的 ref。
 * @param ext - 是否为外部引用。
 * @returns 绝对路径；**内部路径逃逸、外部路径越界、非绝对路径**都返回 `undefined`。
 */
export function resolveRef(ref: string, ext: boolean): string | undefined {
  if (!ext) return resolveInsideLibrary(ref)
  const raw = ref.trim()
  // ⚠️ `ext` 的语义是"**绝对路径**"（§3.3）—— 相对路径没有基准目录，谈不上解析。
  if (raw === '' || !isAbsolute(raw)) return undefined
  return extRoots().some((root) => isInsidePath(raw, root)) ? raw : undefined
}

/**
 * ⭐⭐⭐ **外部引用允许的根**（安全评审 F3，2026-10-22）。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────────────
 * `ext: true` 的封面**把"读哪个文件"的控制权交给了内容**：`ref` 就是绝对路径，
 * 而 `ref` 写在**库里的文档**里（可由历史会话、导入的库、外部文档写进来）。
 * 0.1.5 的实现是**原样使用**（`if (ext) return ref`）⇒ 一条形如
 * （yaml 里写）`ref: C:\\Users\\<你>\\.ssh\\id_rsa` + `ext: true` 的封面，
 * 下次 `memj_read` 就把它**整篇**读进模型上下文（实测可行）。
 *
 * ⇒ 改成**白名单**：
 * · 库根（`~/.dsh-memj`）永远允许（引用自己库里的文件无害）；
 * · 其它根由 **`MEMJ_EXT_ROOTS`**（`path.delimiter` 分隔）显式授权。
 *
 * 🔴 **默认拒绝 = 有意的破坏性变更**：装了 0.1.5 且真在用 `ext` 引用库外文件的人，
 *    升级后那些条目会读不到。**必须**在升级说明里写清"要设 `MEMJ_EXT_ROOTS`"——
 *    让用户"突然读不到"而不给原因，比原来的问题更糟（见 `tools.ts` 的回执措辞）。
 *
 * @returns 允许的根目录（已 `resolve`，库根排在第一位）。
 */
export function extRoots(): string[] {
  const raw = (process.env.MEMJ_EXT_ROOTS ?? '').trim()
  const roots: string[] = [libraryRoot()]
  if (raw !== '') {
    for (const piece of raw.split(delimiter)) {
      const one = piece.trim()
      if (one !== '') roots.push(resolve(one))
    }
  }
  return roots
}

/** 把一个路径拍成"可比较"的形状（绝对、正斜杠、去尾斜杠、小写 —— Windows 盘符大小写不敏感）。 */
function comparablePath(p: string): string {
  return resolve(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

/**
 * `target` 是否落在 `root` 之内（含 `root` 本身）。
 *
 * ⚠️ **必须按路径段比较**：字符串前缀会让 `/a/bc` 被判定为在 `/a/b` 里。
 * @param target - 待判路径。
 * @param root - 允许的根。
 * @returns 是否在内。
 */
function isInsidePath(target: string, root: string): boolean {
  const t = comparablePath(target)
  const r = comparablePath(root)
  if (r === '' || t === '') return false
  return t === r || t.startsWith(`${r}/`)
}

/**
 * ⭐⭐ **热知识注入**（`hot/`）——四类路径收在这里（与 `backup/` 同一理由）。
 *
 * 🔴 **为什么整块放进 `hot/` 而不是塞进既有文件**：
 * `scanLibrary()` **只扫 `projects/`** ⇒ 放进 `hot/` ⇒
 * **天然不进知识库列表、不进 `memj_search`、不参与任何工具调用**
 * （达成"用户画像与热知识不可见、不入工具"的要求，**零过滤代码**）。
 * ⭐ 与决策 135 的 `backup/` 是**同一手法**。
 */
export function hotDir(): string {
  return join(libraryRoot(), 'hot')
}

/** 用户画像（**多条列表**，人编；§5.2）。 */
export function hotPersonaPath(): string {
  return join(hotDir(), 'persona.json')
}

/** 逐条的「纳入 / 通道 / 形态 / 置顶」设置（§5.3）。 */
export function hotEntriesPath(): string {
  return join(hotDir(), 'entries.json')
}

/** ⭐ **逐项目**的「已选热知识清单」（§5.3b，与 `entries.json` 正交）。 */
export function hotSelectionPath(): string {
  return join(hotDir(), 'selection.json')
}

/** 会话 → 项目绑定 + 判定开关 + 最新活跃时间（§5.4）。 */
export function hotSessionsPath(): string {
  return join(hotDir(), 'sessions.json')
}

/**
 * ⭐⭐⭐ **提示词覆盖目录**（本页成为"提示词唯一源头"的落点）。
 *
 * 🔴🔴 **为什么放在库根、而不是插件仓**：
 *  - 它是**用户数据**（用户在页面上改出来的东西），而插件仓是**交付物**——
 *    交付物会被升级/覆盖，放进去等于把用户改动一起冲掉；
 *  - 库根是"拷一个目录即完成迁移"的既有语义（见本文件头）⇒ 覆盖值跟着库走。
 *
 * ⚠️ **与 `backup/` 的区别**：`backup/` 存的是**知识正文镜像**（给 git 维护用）；
 *    这里存的是**提示词覆盖值**，两者语义无关 ⇒ 不混放。
 * @returns 提示词覆盖目录绝对路径。
 */
export function promptsDir(): string {
  return join(libraryRoot(), 'prompts')
}

/** 提示词覆盖表（`{ version, overrides: { <stable-key>: { text, updatedAt } } }`）。 */
export function promptOverridesPath(): string {
  return join(promptsDir(), 'overrides.json')
}

/**
 * ⭐ **提示词改动的历史备份目录**（"分别加"——用户要求既有恢复默认、也有历史）。
 *
 * 每次保存写一个时间戳文件（`<stable-key 消毒>-<ISO>.txt`）⇒ 可回到任意一版。
 * @returns 提示词历史目录绝对路径。
 */
export function promptHistoryDir(): string {
  return join(promptsDir(), 'history')
}

/**
 * ⭐⭐ **交接文档模板目录**（决策 204）——`<库根>/templates/<id>.md`。
 *
 * 🔴 **为什么放库根而不是插件仓**：模板是**用户数据**（用户自己建、可能改、会删），
 *   而插件仓是交付物（升级会覆盖）⇒ 放库根才能跟着库走、也能被 git 维护。
 * ⚠️ **与 `prompts/` 的区别**：那里是**插件文本的覆盖值**（改措辞）；
 *    这里是**文档结构的定义**（改节名/节数/每节用途），语义不同 ⇒ 不混放。
 * @returns 模板目录绝对路径。
 */
export function templatesDir(): string {
  return join(libraryRoot(), 'templates')
}

/**
 * ⭐⭐⭐ **知识类型定义文件的绝对路径**（`<库根>/kinds.md`，决策 215）。
 *
 * ── 为什么是**一个文件**而不是"一堆小文件" ────────────────────────────────
 * 与模板（`templates/<id>.md`）**刻意不同**：类型表是一个**有序列表**，
 * 而"顺序即 UI 下拉顺序" ⇒ 拆成多文件就没法表达顺序（还得另造一个索引）。
 * ⇒ **一张表 = 一个文件**，与它"就是一张表"的心智模型一致。
 *
 * ── 为什么是这个形态（而不是塞进 `settings.json`）────────────────────────
 * 它与模板**同构**：`id` + 显示名 + "什么时候用" + "书写规范"，
 *   而模板那套（md + frontmatter + 每节一段）已经被验证可用 ⇒ **零新增认知**。
 * ⚠️ `settings.json` 存的是**标量配置**（阈值、开关），塞一个结构化列表进去
 *   会让"配置"与"内容"混在一起。
 * @returns 绝对路径。
 */
export function kindsFilePath(): string {
  return join(libraryRoot(), 'kinds.md')
}

/**
 * 一份模板文件的绝对路径。
 *
 * ⭐⭐ **2026-10-12（决策 208）：模板从 `.json` 改成 `.md`**（用户裁定"做"）。
 * 理由：模板现在**就是一份文档的雏形**（每节一个 `## ` 标题 + "这一节要干嘛"的正文），
 *   ⇒ 用 markdown 存**人可以直接读、直接手改**，与"建项目 = 复制模板"是同一个心智模型。
 *   ⚠️ 旧的 `.json` 仍**兼容读**（见 `legacyTemplatePath()`）——
 *   生产库里当时就有一份 `company-deep-research.json`。
 *
 * ⚠️ **内部自己做 `safeName` 消毒** —— 调用方**不要**再消毒一遍
 *    （两处各消一次会让"该不该消毒"变成调用方的记忆负担，本项目吃过这类漂移）。
 * @param id - 模板 id。
 * @returns 绝对路径。
 */
export function templatePath(id: string): string {
  return join(templatesDir(), `${safeName(id)}.md`)
}

/**
 * ⭐ **模板的旧路径**（`.json`）——只用于**兼容读与迁移**。
 *
 * 🔴 **为什么必须兼容读**：决策 204 的模板是 JSON 存的，而**生产库里真有存量**
 *   （`templates/company-deep-research.json`）。若不接住它 ⇒ 那份模板**静默消失**
 *   ⇒ 已存在文档虽不受影响（它们记着自己的节名），但用户会发现"我的模板没了"。
 * @param id - 模板 id。
 * @returns 旧格式的绝对路径。
 */
export function legacyTemplatePath(id: string): string {
  return join(templatesDir(), `${safeName(id)}.json`)
}

/** ⭐ `default` 模板在磁盘上的路径（决策 208：默认模板**也落盘**，可被用户编辑）。 */
export function defaultTemplatePath(): string {
  return templatePath('default')
}

/**
 * 把文件名/id 里的危险字符换掉，避免路径穿越与非法文件名。
 *
 * 项目 id 与主题 id 会直接进文件名，必须消毒。
 * @param name - 原始名字。
 * @returns 安全的文件名片段。
 */
export function safeName(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\.+$/g, '')
  return cleaned === '' ? '_' : cleaned
}

/**
 * ⭐⭐⭐ **「文档内提问」的数据目录**：`<库根>/reading/`（2026-10-14）。
 *
 * 放三样东西（都是**本功能的 source data**，不是 derived）：
 *   · `bindings.jsonl` —— 「源条目的某段落」⇄ 「chat 条目」的绑定；
 *   · `cursors.json`   —— 每个会话同步到哪个 seq（增量游标）；
 *   · `state.json`     —— 阅读位置等轻量状态。
 *
 * 🔴 **为什么不复用 `reads/` / `docReads/`**（同 `recallLogDir` 的理由）：
 *    那两个的语义是"**读过什么**"（跨项目证据 / 写叙事前置），
 *    而这里是"**哪段对话绑哪条知识**"——结构（anchor 四元组）与用途都不同，
 *    混在一起会让"读过"与"讨论过"互相污染。
 */
export function readingDir(): string {
  return join(libraryRoot(), 'reading')
}

/** 段落 ⇄ 会话绑定表：`reading/bindings.jsonl`（一行一条，可追加）。 */
export function readingBindingsPath(): string {
  return join(readingDir(), 'bindings.jsonl')
}

/** 同步游标：`reading/cursors.json`（`sessionId → capturedThroughSeq`）。 */
export function readingCursorsPath(): string {
  return join(readingDir(), 'cursors.json')
}

/** 阅读状态：`reading/state.json`。 */
export function readingStatePath(): string {
  return join(readingDir(), 'state.json')
}

/** 需要保证存在的目录全集（首次写入时创建）。 */
export function requiredDirs(): readonly string[] {
  return [
    projectsDir(),
    entriesDir(),
    themesDir(),
    readsDir(),
    docReadsDir(),
    // ⭐⭐ 主动召回日志目录（2026-09-27）：空目录无副作用，且让首次写入少一次竞态。
    recallLogDir(),
    // ⭐⭐ 知识评分日志目录（决策 177）：同上。
    scoreLogDir(),
    // ⭐ 备份目录（决策 135 / 136）：空目录无副作用，且让首次启用时少一次竞态。
    //    ⚠️ **不含 `backup/` 本身与 `.git`**——仓库由 `git init` 显式创建（见 git.ts）。
    //    ⚠️ 也**不含子目录**：镜像现在直接在 `backup/` 根下（决策 136）。
    backupDir(),
    // ⭐⭐ 热知识目录（热知识方案）：同上——空目录无副作用。
    hotDir(),
    // ⭐⭐⭐ 标签规范词表目录（决策 162）：同上。⚠️ **只在真写入时创建**——
    //    "用户从没用过这个工具" 与 "用过但词表为空" 是两件事，
    //    而一个空目录说明不了区别；真正的判据是文件在不在。
    tagsDir(),
    // ⭐⭐⭐ 提示词覆盖目录（本次新增）：同上——空目录无副作用，
    //    且让首次保存少一次竞态。⚠️ **历史子目录不在这里预建**（首次保存时建）。
    promptsDir(),
    // ⭐⭐⭐ 「文档内提问」目录（2026-10-14）：同上。
    //    ⚠️ **bindings/cursors 是真数据**（不是日志）⇒ 丢了不可再生
    //    （游标丢了只会"重跑一遍"、绑定丢了就再也指不回那段）⇒ 更要尽早建目录。
    readingDir(),
  ]
}
