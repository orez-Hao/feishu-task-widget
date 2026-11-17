#!/usr/bin/env node
// 飞书任务便签 · 网页版（备用形态；桌面便签见 desktop/）
//   node src/web.mjs            → 起服务并打开浏览器 http://127.0.0.1:3123/
//   node src/web.mjs --no-open
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { STORE, state, setStatus } from './lib/reminders.mjs'
import { PKG_ROOT } from './lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE = join(PKG_ROOT, 'desktop', 'web.html')
const PORT = Number(process.env.NOOK_PORT || 3123)
const HOST = '127.0.0.1'

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 64 * 1024) reject(new Error('请求体过大'))
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })

const json = (res, code, payload) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(payload))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://' + HOST + ':' + PORT)
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      return res.end(readFileSync(PAGE))
    }
    if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, state())
    if (req.method === 'POST' && url.pathname === '/api/status') {
      const body = await readBody(req)
      const out = setStatus(String(body.id || ''), body.status === 'done' ? 'done' : 'open')
      return json(res, out.ok ? 200 : 404, out)
    }
    return json(res, 404, { ok: false, error: '没有这个地址：' + url.pathname })
  } catch (err) {
    return json(res, 500, { ok: false, error: String(err && err.message ? err.message : err) })
  }
})

server.listen(PORT, HOST, () => {
  const url = 'http://' + HOST + ':' + PORT + '/'
  console.log('飞书任务便签（网页版）：' + url)
  console.log('数据源：' + STORE)
  if (!process.argv.includes('--no-open')) {
    try {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore' }).unref()
    } catch {
      console.log('（打开浏览器失败，手动访问上面的地址即可）')
    }
  }
})
