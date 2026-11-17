#!/usr/bin/env node
// 发现「真人」私聊会话：飞书不提供会话列表接口，用消息搜索(chat_type=p2p_chat)反推 chat_id，
// 再按消息 sender_type 过滤掉机器人/通知会话。
// 用法：node p2p-discover.mjs [--days 60] [--max-resolve 200] [--queries "a,b"]
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { api } from './lib/api.mjs'
import { whoAmI } from './lib/im.mjs'
import { TOOL_DIR } from './lib/auth.mjs'

const argv = process.argv.slice(2)
const arg = (n, d) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d
}
const FILE = join(TOOL_DIR, 'p2p-chats.json')
const days = Number(arg('days', 60))
const maxResolve = Number(arg('max-resolve', 200))
const queries = String(
  arg('queries', '的,收到,明天,确认,可以,谢谢,进度,方案,时间,怎么样,吗,好,我,你,这个,问题'),
)
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)

const me = await whoAmI()
const store = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : { chats: [] }
const byId = new Map(store.chats.map((c) => [c.chatId, c]))

const now = Math.floor(Date.now() / 1000)
const start = String(now - days * 86400)
const end = String(now)

const msgIds = new Set()
for (const q of queries) {
  let token
  for (let page = 0; page < 5; page++) {
    try {
      const body = { query: q, chat_type: 'p2p_chat', start_time: start, end_time: end }
      if (token) body.page_token = token
      const d = await api('/open-apis/search/v2/message', { method: 'POST', body })
      for (const id of d.items || []) msgIds.add(id)
      if (!d.has_more || !d.page_token) break
      token = d.page_token
    } catch (e) {
      console.error('搜索 "' + q + '" 失败：' + e.message.slice(0, 100))
      break
    }
  }
}
console.log('搜索命中消息 ID：' + msgIds.size)

let resolved = 0
let humanChats = 0
let botChats = 0
for (const id of [...msgIds].slice(0, maxResolve)) {
  let it
  try {
    const m = await api('/open-apis/im/v1/messages/' + id)
    it = (m.items || [])[0]
  } catch {
    continue
  }
  resolved++
  if (!it?.chat_id) continue
  const isBot = (it.sender?.sender_type || 'user') !== 'user'
  if (isBot) {
    botChats++
    continue // 机器人/通知会话不要
  }
  humanChats++
  const prev = byId.get(it.chat_id) || { chatId: it.chat_id, name: '' }
  prev.lastMessageAt = Math.max(prev.lastMessageAt || 0, Number(it.create_time) || 0)
  prev.chatType = it.chat_type || prev.chatType || ''
  let name = prev.name
  if (!name) {
    try {
      const d = await api('/open-apis/im/v1/chats/' + it.chat_id + '/members', {
        query: { member_id_type: 'open_id', page_size: 20 },
      })
      name = (d.items || [])
        .filter((m) => m.member_id !== me.openId)
        .map((m) => m.name)
        .filter(Boolean)
        .join(' / ')
    } catch {}
  }
  prev.name = name || '(未命名私聊)'
  byId.set(it.chat_id, prev)
}
console.log(`解析 ${resolved} 条：真人私聊 ${humanChats} 次命中，机器人会话 ${botChats} 次（已剔除）`)

const human = [...byId.values()].filter((c) => !/^\(未命名私聊\)$/.test(c.name || '') || c.lastMessageAt)
human.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
store.chats = human
store.updatedAt = new Date().toISOString()
writeFileSync(FILE, JSON.stringify(store, null, 1), 'utf8')
console.log('真人私聊累计：' + store.chats.length + ' 个')
for (const c of store.chats) {
  console.log('  - ' + (c.name || '') + '  ' + c.chatId + (c.lastMessageAt ? '  最近 ' + new Date(c.lastMessageAt).toLocaleString() : ''))
}
