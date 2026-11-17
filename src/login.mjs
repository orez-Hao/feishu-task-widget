#!/usr/bin/env node
// 飞书个人身份登录：本地起一个回调服务，授权后把 user_access_token / refresh_token 存到 .state/
// 用法：node .tools\feishu\login.mjs [--no-open] [--port 3000]
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadConfig,
  exchangeCode,
  exchangeCodeV2,
  buildAuthorizeUrl,
  writeState,
  readState,
  DOMAIN,
  STATE_FILE,
  STATE_DIR,
} from './lib/auth.mjs'

const args = process.argv.slice(2)
const noOpen = args.includes('--no-open')
const portArg = args.indexOf('--port')
const timeoutArg = args.indexOf('--timeout')
const waitMinutes = timeoutArg >= 0 ? Number(args[timeoutArg + 1]) || 10 : 10

const cfg = loadConfig()
if (!cfg.appId || !cfg.appSecret) {
  console.error('✖ 没找到应用凭证。')
  console.error('  请把下面两行写进 .env（仓库根目录或 ~/.feishu-task-widget/.env）：')
  console.error('    FEISHU_APP_ID=cli_xxxxxxxx')
  console.error('    FEISHU_APP_SECRET=xxxxxxxx')
  process.exit(1)
}

let redirect
try {
  redirect = new URL(cfg.redirectUri)
} catch {
  console.error(`✖ FEISHU_REDIRECT_URI 不是合法 URL：${cfg.redirectUri}`)
  process.exit(1)
}

// 手动兜底：浏览器没能回调到本地时，把授权后地址里的 code 直接交过来
//   node login.mjs --code <code>
const codeArg = args.indexOf('--code')
if (codeArg >= 0) {
  const code = args[codeArg + 1]
  if (!code) {
    console.error('✖ --code 后面要跟授权码')
    process.exit(1)
  }
  try {
    const codeFlow = process.env.FEISHU_AUTH_FLOW === 'v1' ? 'v1' : 'v2'
    const token =
      codeFlow === 'v2'
        ? await exchangeCodeV2(code, redirect.toString(), cfg)
        : await exchangeCode(code, redirect.toString(), cfg)
    writeState(token)
    console.log('✔ 已用授权码换取令牌并保存')
    console.log(`  refresh_token：${token.refresh_token ? '已获取' : '未获取（缺 offline_access）'}`)
    process.exit(0)
  } catch (e) {
    console.error(`✖ ${e.message}`)
    process.exit(1)
  }
}
const port = portArg > 0 ? Number(args[portArg + 1]) : Number(redirect.port || 80)
const callbackPath = redirect.pathname || '/callback'

const state = Math.random().toString(36).slice(2, 12)
// 新版授权（v2）才能调用 im/v1/messages；设 FEISHU_AUTH_FLOW=v1 可退回旧版
const flow = process.env.FEISHU_AUTH_FLOW === 'v1' ? 'v1' : 'v2'
// 授权页版本可单独指定（新版授权页对重定向 URL 校验更严）
const authorizeFlow = process.env.FEISHU_AUTHORIZE === 'v1' ? 'v1' : flow
const authorizeUrl = buildAuthorizeUrl({
  cfg,
  state,
  flow: authorizeFlow,
  redirectUri: redirect.toString(),
  scopes: process.env.FEISHU_SCOPES || cfg.scopes || '',
})
// 落盘一份，方便没弹出浏览器时手工打开
try {
  writeFileSync(join(STATE_DIR, 'last-authorize-url.txt'), authorizeUrl, 'utf8')
} catch {}

let settled = false

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`)
  console.log(`[回调] ${req.method} ${url.pathname}${url.search ? '?' + url.searchParams.toString() : ''}`)
  if (url.pathname !== callbackPath) {
    res.writeHead(404).end('not found')
    return
  }
  const code = url.searchParams.get('code')
  const returnedState = url.searchParams.get('state')
  const err = url.searchParams.get('error')

  if (settled) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end('<h2>已完成</h2>')
    return
  }
  if (err) {
    settled = true
    respond(res, false, `授权被拒绝：${err}`)
    console.error(`✖ 授权失败：${err}`)
    setTimeout(() => process.exit(1), 300)
    return
  }
  if (!code) {
    respond(res, false, '回调里没有 code，可能是重定向地址配错了。')
    return
  }
  if (returnedState !== state) {
    settled = true
    console.log(`[调试] 收到 code=${code} state=${returnedState}（期望 ${state}）`)
    respond(res, false, 'state 校验失败（链接过期或与当前进程不匹配），请重新登录。')
    console.error('✖ state 不匹配，登录已中止。')
    setTimeout(() => process.exit(1), 300)
    return
  }

  settled = true
  try {
    const token =
      flow === 'v2'
        ? await exchangeCodeV2(code, redirect.toString(), cfg)
        : await exchangeCode(code, redirect.toString(), cfg)
    writeState(token)
    const user = await fetchUser(token.access_token)
    respond(res, true, `登录成功：${user || '（已获取令牌）'}`)
    console.log('')
    console.log(`✔ 登录成功${user ? '：' + user : ''}`)
    console.log(`  令牌已保存到：${STATE_FILE}`)
    console.log(
      `  授权流程：${token.flow}；范围 ${(token.scope || '').length} 字符` +
        (/im:message/.test(token.scope || '') ? '（含 im:message）' : '（不含 im:message，消息接口仍会被拒）'),
    )
    if (!token.refresh_token) {
      console.log('  ⚠ 没有拿到 refresh_token（应用可能没开通 offline_access 权限），2 小时后需要重新登录。')
    } else {
      console.log('  refresh_token 已保存，之后会自动续期。')
    }
    setTimeout(() => process.exit(0), 400)
  } catch (e) {
    respond(res, false, e.message)
    console.error(`✖ ${e.message}`)
    settled = false
    setTimeout(() => process.exit(1), 300)
  }
})

function respond(res, ok, message) {
  const color = ok ? '#16a34a' : '#dc2626'
  res.writeHead(ok ? 200 : 400, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>飞书授权</title>` +
      `<body style="font-family:system-ui;padding:48px;text-align:center">` +
      `<h2 style="color:${color}">${ok ? '✅' : '❌'} ${escapeHtml(message)}</h2>` +
      `<p style="color:#666">可以关闭这个页面，回到对话里继续。</p></body>`,
  )
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
}

async function fetchUser(token) {
  try {
    const r = await fetch(DOMAIN + '/open-apis/authen/v1/user_info', {
      headers: { Authorization: `Bearer ${token}` },
    })
    const j = await r.json()
    return j?.data?.name || ''
  } catch {
    return ''
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    console.error(`✖ 端口 ${port} 被占用了。换一个端口：node src/login.mjs --port 3001`)
    console.error(`  （记得把开发者后台的重定向 URL 同步改成 http://localhost:3001${callbackPath}）`)
  } else {
    console.error('✖ 本地回调服务启动失败：', e.message)
  }
  process.exit(1)
})

server.listen(port, '127.0.0.1', () => {
  const prev = readState()
  console.log('─'.repeat(64))
  console.log('飞书个人身份登录')
  console.log(`  应用：${cfg.appId}`)
  console.log(`  回调：${redirect.toString()}`)
  console.log(`  授权页版本：${authorizeFlow}（令牌换取版本：${flow}）`)
  if (prev?.obtained_at && prev.refresh_token) {
    console.log(`  提示：之前登录过（${new Date(prev.obtained_at).toLocaleString()}），这次会覆盖旧令牌。`)
  }
  console.log('─'.repeat(64))
  console.log('')
  console.log('在浏览器里打开这个链接完成授权（用你自己的飞书账号）：')
  console.log('')
  console.log(authorizeUrl)
  console.log('')

  if (!noOpen) {
    try {
      spawn('cmd.exe', ['/c', 'start', '', authorizeUrl], { stdio: 'ignore', detached: true }).unref()
      console.log('（已尝试自动打开浏览器；没弹出来就手动复制上面的链接）')
    } catch {
      console.log('（自动打开浏览器失败，请手动复制上面的链接）')
    }
  }
  console.log('等待授权回调中…（5 分钟内有效，Ctrl+C 取消）')
})

setTimeout(() => {
  if (!settled) {
    console.error('✖ 等待超时，请重新运行登录。')
    process.exit(1)
  }
}, waitMinutes * 60 * 1000)
