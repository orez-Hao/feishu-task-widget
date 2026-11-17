#!/usr/bin/env node
// 给 p2p-chats.json 里未命名的私聊补上对方姓名（靠最近消息的 sender + 联系人接口）
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { api } from './lib/api.mjs'
import { whoAmI, userNames } from './lib/im.mjs'
import { TOOL_DIR } from './lib/auth.mjs'

const FILE = join(TOOL_DIR, 'p2p-chats.json')
const store = JSON.parse(readFileSync(FILE, 'utf8'))
const me = await whoAmI()
let fixed = 0

for (const c of store.chats) {
  if (c.name && !c.name.startsWith('(')) continue
  try {
    const d = await api('/open-apis/im/v1/messages', {
      query: { container_id_type: 'chat', container_id: c.chatId, page_size: 10, sort_type: 'ByCreateTimeDesc' },
    })
    const others = (d.items || [])
      .map((m) => (m.sender?.id?.open_id || ''))
      .filter((id) => id && id !== me.openId)
    if (!others.length) continue
    const map = await userNames(others)
    const name = [...new Set([...map.values()].filter(Boolean))].join(' / ')
    if (name) {
      c.name = name
      fixed++
      console.log('  ' + c.chatId + ' → ' + name)
    }
  } catch (e) {
    console.log('  ' + c.chatId + ' 失败: ' + e.message.slice(0, 80))
  }
}
store.updatedAt = new Date().toISOString()
writeFileSync(FILE, JSON.stringify(store, null, 1), 'utf8')
console.log('补名完成：' + fixed + ' 个；累计 ' + store.chats.length + ' 个私聊')
console.log(store.chats.map((c) => c.name).join(' | '))
