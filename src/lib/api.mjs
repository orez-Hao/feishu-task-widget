// 飞书 OpenAPI 轻量客户端：统一错误处理、分页、限流重试
import { getAccessToken, DOMAIN, invalidateCache } from './auth.mjs'

const MAX_RETRY = 3
const RETRYABLE = new Set([99991400, 99991401, 1254290, 1254291]) // 频率限制类

function qs(query) {
  if (!query) return ''
  const parts = []
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
  }
  return parts.length ? `?${parts.join('&')}` : ''
}

/**
 * 调用飞书 OpenAPI，返回 data 字段。
 * @param {string} path 例如 /open-apis/bitable/v1/apps/{app}/tables
 * @param {{method?: string, query?: object, body?: any, token?: string}} opts
 */
export async function api(path, opts = {}) {
  const token = opts.token || (await getAccessToken())
  const url = DOMAIN + path + qs(opts.query)
  let attempt = 0
  for (;;) {
    attempt++
    let res, text
    try {
      res = await fetch(url, {
        method: opts.method || 'GET',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      })
      text = await res.text()
    } catch (err) {
      if (attempt >= MAX_RETRY) throw new Error(`调用飞书接口失败（网络）：${err.message}`)
      await sleep(400 * attempt)
      continue
    }

    let json
    try {
      json = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`飞书返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`)
    }

    const code = json.code
    if (code === 0 || (code === undefined && res.ok)) return json.data ?? json

    if (RETRYABLE.has(code) && attempt < MAX_RETRY) {
      await sleep(600 * attempt)
      continue
    }
    if (code === 99991663 || code === 99991661 || code === 99991668 || code === 99991679) {
      // token 失效：强制刷新一次再试
      invalidateCache()
      if (attempt < MAX_RETRY) {
        try {
          const fresh = await getAccessToken({ force: true })
          opts = { ...opts, token: fresh }
          continue
        } catch {
          // 刷不动（比如没有 refresh_token），保留原始错误往下抛
        }
      }
    }
    const msg = json.msg || json.error_description || json.error || text.slice(0, 300)
    throw new Error(`飞书接口错误 ${code}：${msg}`)
  }
}

/** 按页拉取全部结果 */
export async function apiAll(path, { query, body, method, limit = 5000 } = {}) {
  const items = []
  let pageToken
  let guard = 0
  for (;;) {
    const q = { ...(query || {}), page_size: (query && query.page_size) || 200 }
    if (pageToken) q.page_token = pageToken
    const data = await api(path, { query: q, body, method })
    const batch = data.items || data.records || []
    items.push(...batch)
    if (!data.has_more || items.length >= limit) break
    pageToken = data.page_token
    if (!pageToken) break
    if (++guard > 60) break
  }
  return items
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}
