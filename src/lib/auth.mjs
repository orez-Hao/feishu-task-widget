// 飞书授权：读取应用凭证、维护 user_access_token（自动刷新）
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PKG_ROOT, DATA_DIR, STATE_DIR, STATE_FILE, ENV_CANDIDATES } from './config.mjs'

// 老代码把 TOOL_DIR 当"可写数据目录"，这里指向 DATA_DIR（默认 ~/.feishu-task-widget）
export { PKG_ROOT, DATA_DIR, STATE_DIR, STATE_FILE }
export const TOOL_DIR = DATA_DIR

export const DOMAIN = process.env.FEISHU_DOMAIN || 'https://open.feishu.cn'
// 新版用户授权的授权页在 accounts 域名下
export const ACCOUNTS_DOMAIN = process.env.FEISHU_ACCOUNTS_DOMAIN || 'https://accounts.feishu.cn'

/** 解析一个简易 .env（KEY=VALUE，# 注释，允许引号） */
function parseEnv(text) {
  const out = {}
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    out[key] = val
  }
  return out
}

function envCandidates() {
  return ENV_CANDIDATES
}

/** 逐个候选文件读取，先到先得；进程环境变量优先级最高 */
export function loadConfig() {
  let appId = process.env.FEISHU_APP_ID || process.env.APP_ID
  let appSecret = process.env.FEISHU_APP_SECRET || process.env.APP_SECRET
  let redirectUri = process.env.FEISHU_REDIRECT_URI
  let scopes = process.env.FEISHU_SCOPES
  let source = appId ? 'process.env' : undefined

  if (!appId || !appSecret) {
    for (const file of envCandidates()) {
      if (!existsSync(file)) continue
      let parsed
      try {
        parsed = parseEnv(readFileSync(file, 'utf8'))
      } catch {
        continue
      }
      appId ||= parsed.FEISHU_APP_ID || parsed.APP_ID
      appSecret ||= parsed.FEISHU_APP_SECRET || parsed.APP_SECRET
      redirectUri ||= parsed.FEISHU_REDIRECT_URI
      scopes ||= parsed.FEISHU_SCOPES
      if (appId && appSecret && !source) source = file
      if (appId && appSecret) break
    }
  }
  return {
    appId,
    appSecret,
    redirectUri: redirectUri || 'http://localhost:3000/callback',
    scopes: (scopes || '').replace(/^["']|["']$/g, '').trim(),
    source,
  }
}

export function readState() {
  if (!existsSync(STATE_FILE)) return null
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

export function writeState(state) {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8')
}

async function postJson(path, payload, bearer) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const res = await fetch(DOMAIN + path, { method: 'POST', headers, body: JSON.stringify(payload) })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`飞书返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`)
  }
}

/** 应用级 app_access_token（换取/刷新用户令牌时要用） */
async function getAppAccessToken(cfg) {
  const json = await postJson('/open-apis/auth/v3/app_access_token/internal', {
    app_id: cfg.appId,
    app_secret: cfg.appSecret,
  })
  if (!json.app_access_token) {
    throw new Error(
      `获取 app_access_token 失败：${json.msg || JSON.stringify(json)}。请检查 App ID / App Secret 是否正确。`,
    )
  }
  return json.app_access_token
}

/**
 * 用授权码换取 user_access_token（飞书 v1 OIDC 流程，与官方 lark-mcp 一致）。
 * @see https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/oidc-access_token/create
 */
export async function exchangeCode(code, _redirectUri, cfg = loadConfig()) {
  const appToken = await getAppAccessToken(cfg)
  const json = await postJson(
    '/open-apis/authen/v1/oidc/access_token',
    { grant_type: 'authorization_code', code },
    appToken,
  )
  if (json.code !== 0 || !json.data?.access_token) {
    throw new Error(`换取用户令牌失败（${json.code}）：${json.msg || JSON.stringify(json).slice(0, 300)}`)
  }
  return normalizeToken(json.data, cfg)
}

async function refreshUserToken(refreshTokenValue, cfg = loadConfig()) {
  const appToken = await getAppAccessToken(cfg)
  const json = await postJson(
    '/open-apis/authen/v1/oidc/refresh_access_token',
    { grant_type: 'refresh_token', refresh_token: refreshTokenValue },
    appToken,
  )
  if (json.code !== 0 || !json.data?.access_token) {
    throw new Error(
      `刷新用户令牌失败（${json.code}）：${json.msg || 'refresh_token 可能已过期，请重新登录'}`,
    )
  }
  return normalizeToken(json.data, cfg)
}

function normalizeToken(data, cfg, flow = 'v1') {
  const now = Date.now()
  return {
    app_id: cfg.appId,
    flow,
    access_token: data.access_token,
    refresh_token: data.refresh_token || '',
    expires_at: now + (Number(data.expires_in) || 7200) * 1000,
    refresh_expires_at:
      now + (Number(data.refresh_token_expires_in || data.refresh_expires_in) || 30 * 86400) * 1000,
    scope: data.scope || '',
    obtained_at: now,
  }
}

/**
 * 新版用户授权换令牌：POST /open-apis/authen/v2/oauth/token，返回平铺字段。
 * im/v1/messages 等较新的接口只认这套令牌，旧版换来的会报 99991695。
 */
export async function exchangeCodeV2(code, redirectUri, cfg = loadConfig()) {
  const json = await postJson('/open-apis/authen/v2/oauth/token', {
    grant_type: 'authorization_code',
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    code,
    redirect_uri: redirectUri || cfg.redirectUri,
  })
  const d = json.data || json
  if ((json.code !== undefined && json.code !== 0) || !d.access_token) {
    throw new Error(
      `换取用户令牌失败（${json.code}）：${json.error_description || json.error || json.msg || JSON.stringify(json).slice(0, 300)}`,
    )
  }
  return normalizeToken(d, cfg, 'v2')
}

/** 新版刷新令牌；refresh_token 只能用同版本签发的那条 */
export async function refreshUserTokenV2(refreshTokenValue, cfg = loadConfig()) {
  const json = await postJson('/open-apis/authen/v2/oauth/token', {
    grant_type: 'refresh_token',
    client_id: cfg.appId,
    client_secret: cfg.appSecret,
    refresh_token: refreshTokenValue,
  })
  const d = json.data || json
  if ((json.code !== undefined && json.code !== 0) || !d.access_token) {
    throw new Error(
      `刷新用户令牌失败（${json.code}）：${json.error_description || json.error || json.msg || 'refresh_token 可能已过期，请重新登录'}`,
    )
  }
  return normalizeToken(d, cfg, 'v2')
}

/** 生成授权链接：新版 accounts.feishu.cn/authen/v1/authorize，旧版 open.feishu.cn/authen/v1/index */
export function buildAuthorizeUrl({ cfg = loadConfig(), state, scopes, flow = 'v2', redirectUri } = {}) {
  const redirect = redirectUri || cfg.redirectUri
  const q = new URLSearchParams()
  if (flow === 'v1') {
    q.set('app_id', cfg.appId)
    q.set('redirect_uri', redirect)
    q.set('state', state)
    return `${DOMAIN}/open-apis/authen/v1/index?${q.toString().replace(/\+/g, '%20')}`
  }
  q.set('client_id', cfg.appId)
  q.set('redirect_uri', redirect)
  q.set('state', state)
  if (scopes) q.set('scope', scopes)
  return `${ACCOUNTS_DOMAIN}/open-apis/authen/v1/authorize?${q.toString().replace(/\+/g, '%20')}`
}

/** 内存缓存，避免每次调用都读盘/刷新 */
let cached = null

/** 应用级 tenant_access_token（应用身份，不需要用户授权） */
let tenantCache = null
export async function getTenantToken() {
  const cfg = loadConfig()
  if (!cfg.appId || !cfg.appSecret) throw new Error('缺少应用凭证（.env）')
  if (tenantCache && tenantCache.expires - Date.now() > 5 * 60 * 1000) return tenantCache.token
  const json = await postJson('/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: cfg.appId,
    app_secret: cfg.appSecret,
  })
  if (!json.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败：${json.msg || JSON.stringify(json)}`)
  }
  tenantCache = {
    token: json.tenant_access_token,
    expires: Date.now() + (Number(json.expire) || 7200) * 1000,
  }
  return tenantCache.token
}

/**
 * 取一个可用的 user_access_token；快过期时自动用 refresh_token 续期。
 * 设置 FEISHU_IDENTITY=tenant 时改用应用身份。
 * @param {{force?: boolean}} opts
 */
export async function getAccessToken(opts = {}) {
  if (process.env.FEISHU_IDENTITY === 'tenant') return getTenantToken()
  const cfg = loadConfig()
  if (!cfg.appId || !cfg.appSecret) {
    throw new Error(
      '还没有配置飞书应用凭证。请在 .env 里写入 FEISHU_APP_ID 与 FEISHU_APP_SECRET（参考 .env.example）。',
    )
  }
  const state = cached || readState()
  if (!state || !state.access_token) {
    throw new Error('还没有登录。请先运行登录：node src/login.mjs')
  }
  const stillValid = state.expires_at - Date.now() > 5 * 60 * 1000
  if (stillValid && !opts.force) {
    cached = state
    return state.access_token
  }
  if (!state.refresh_token) {
    throw new Error('用户令牌已过期且没有 refresh_token，请重新登录：node src/login.mjs')
  }
  const next =
    state.flow === 'v2'
      ? await refreshUserTokenV2(state.refresh_token, cfg)
      : await refreshUserToken(state.refresh_token, cfg)
  next.refresh_token ||= state.refresh_token
  writeState(next)
  cached = next
  return next.access_token
}

export function invalidateCache() {
  cached = null
}
