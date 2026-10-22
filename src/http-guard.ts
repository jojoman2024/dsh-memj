/**
 * ⭐⭐⭐ **写通道来源闸**（安全评审 F1，2026-10-22）。
 *
 * ── 它修的是什么 ──────────────────────────────────────────────────────────────
 * `handleApi` 的写接口（`/prompt/save`、`/template/save`、`/settings`、
 * `/fix-cover`、`/backup/setup` …）**只认方法与 JSON 体，不认请求来源**。
 * 而本插件的 API 挂在**本机随机端口**上、**没有任何鉴权** ⇒
 * 任何一个人打开的网页都能对它发 `POST`（同源策略只挡"读响应"，**不挡"发请求"**）。
 *
 * 实测（0.1.5，真实宿主 127.0.0.1:18999）：
 *
 * ```text
 * 从 127.0.0.1:18773 的攻击页 fetch POST /plugins/dsh-memj/api/prompt/save
 *   → 200 {"ok":true,...}，且 OPTIONS 预检 0 次
 *   → 覆盖项写入库里的 prompts/overrides.json，**下一轮即进 node 0 系统提示词**
 * ```
 *
 * ── 为什么判据是这三条（而不是"加个 token"）──────────────────────────────────
 * 1. **`Sec-Fetch-Site`**：现代浏览器对**所有**请求都带它；
 *    `cross-site` / `same-site` ⇒ 一定不是本页面自己发的 ⇒ 直接拒。
 * 2. **`Origin`**：浏览器对**跨源 POST 必带**（GET/HEAD 不带）⇒ 有就必须与本机 `Host` 同源。
 *    `Origin: null`（`file://`、沙箱 iframe）同样拒 —— 那不是本面板。
 * 3. **Content-Type 不许是"简单类型"**：跨站 `<form>` 只能发
 *    `application/x-www-form-urlencoded` / `multipart/form-data` / `text/plain`；
 *    而 `fetch` 发 `application/json` 会**先预检**，本插件**不实现 OPTIONS**
 *    ⇒ 预检过不去。所以"只收 JSON"这条把**无 Origin 的老式浏览器**也挡住了。
 *
 * 🔴 **故意不加 CSRF token**：token 需要"下发—保存—回传"三处状态，
 * 而本插件的调用方只有**自己的页面**（同源）⇒ 上面三条足以判定来源，
 * 加 token 只会多一种"页面没拿到 token 就全站写不了"的故障。
 *
 * ⚠️ **它是"来源"闸，不是"权限"闸**：本机上的任何进程（curl）都能照旧写库。
 *    要挡那个，得先有一套"谁能管理本机 DSH"的凭据体系 —— 那是另一个量级的设计。
 *
 * @module dsh-memj/http-guard
 */

/** `IncomingHttpHeaders` 的形状（`string | string[] | undefined`）。 */
export type HeaderBag = Record<string, string | string[] | undefined>

/** 判定结果：`ok: false` 时带 HTTP 状态与**给人看的原因**。 */
export interface WriteGuardVerdict {
  ok: boolean
  status?: number
  error?: string
}

/** 跨站 `<form>` 能直接提交的三种 Content-Type（`fetch` 用它们也**不触发预检**）。 */
const SIMPLE_CONTENT_TYPES: readonly string[] = [
  'application/x-www-form-urlencoded',
  'multipart/form-data',
  'text/plain',
]

/** 取首值并把数组头拍平成字符串（`Host` 这类头理论上只有一个）。 */
function headerOf(bag: HeaderBag, name: string): string {
  const v = bag[name]
  if (Array.isArray(v)) return (v[0] ?? '').trim()
  return (v ?? '').trim()
}

/** 取一个 URL 的 `host[:port]`（小写）；解析不了返回 `undefined`（`Origin: null` 就走这条）。 */
function hostOfUrl(value: string): string | undefined {
  try {
    return new URL(value).host.toLowerCase()
  } catch {
    return undefined
  }
}

/**
 * 判断一次**写请求**是否来自本面板自己。
 *
 * @param method - HTTP 方法（大写或小写都行）。
 * @param headers - 请求头（`req.headers` 原样传进来即可）。
 * @returns 判定；不通过时 `status` 是建议回给调用方的状态码。
 */
export function checkWriteOrigin(method: string, headers: HeaderBag): WriteGuardVerdict {
  const m = method.toUpperCase()
  // 只读方法不必过闸（本插件的读接口是"面板自己要看数据"，改了会误伤刷新/轮询）。
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return { ok: true }

  // ① 浏览器自己标的"跨站" —— 最硬的信号，先看它。
  const site = headerOf(headers, 'sec-fetch-site').toLowerCase()
  if (site === 'cross-site' || site === 'same-site') {
    return {
      ok: false,
      status: 403,
      error: `拒绝跨站写入：Sec-Fetch-Site=${site}（本接口只接受面板自己的页面调用）`,
    }
  }

  const self = headerOf(headers, 'host').toLowerCase()

  // ② Origin：跨源 POST 必带 ⇒ 带了就必须与本机 Host 同源。
  const origin = headerOf(headers, 'origin')
  if (origin !== '') {
    const originHost = hostOfUrl(origin)
    if (originHost === undefined) {
      return { ok: false, status: 403, error: `拒绝跨源写入：Origin=${origin}（不是可识别的来源）` }
    }
    if (self === '' || originHost !== self) {
      return {
        ok: false,
        status: 403,
        error: `拒绝跨源写入：Origin=${originHost} 与 Host=${self === '' ? '(缺失)' : self} 不同源`,
      }
    }
  } else {
    // ③ 退一步看 Referer（老浏览器/某些客户端没有 Origin 但有它）。
    const referer = headerOf(headers, 'referer')
    if (referer !== '') {
      const refererHost = hostOfUrl(referer)
      if (refererHost === undefined || self === '' || refererHost !== self) {
        return {
          ok: false,
          status: 403,
          error: `拒绝跨源写入：Referer 指向 ${refererHost ?? referer}，与 Host=${self === '' ? '(缺失)' : self} 不同源`,
        }
      }
    }
  }

  // ④ "简单" Content-Type ⇒ 跨站表单能直接发 ⇒ 一律不收（本插件所有写接口都是 JSON）。
  const contentType = headerOf(headers, 'content-type').toLowerCase()
  if (contentType !== '') {
    const base = contentType.split(';')[0]?.trim() ?? ''
    if (SIMPLE_CONTENT_TYPES.includes(base)) {
      return {
        ok: false,
        status: 415,
        error: `写接口只接受 application/json（收到 ${base}：这类 Content-Type 可被跨站表单直接提交）`,
      }
    }
  }

  return { ok: true }
}
