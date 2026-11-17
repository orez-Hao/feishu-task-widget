// 飞书 IM 读取：会话列表、会话历史、消息内容解析、@我 检测
import { api } from './api.mjs'

const CHAT_PAGE = 100
const MSG_PAGE = 50

/**
 * 当前授权的用户是谁；open_id 用于判断「@我」。
 * 接口失败时退回环境变量 FEISHU_SELF_OPEN_ID / FEISHU_SELF_NAME。
 */
export async function whoAmI() {
  try {
    const d = await api('/open-apis/authen/v1/user_info')
    return { openId: d.open_id, unionId: d.union_id, userId: d.user_id, name: d.name || '' }
  } catch (err) {
    if (process.env.FEISHU_SELF_OPEN_ID) {
      return {
        openId: process.env.FEISHU_SELF_OPEN_ID,
        name: process.env.FEISHU_SELF_NAME || '',
        note: 'user_info 调用失败，用环境变量代替：' + err.message,
      }
    }
    throw err
  }
}

/** 我所在的全部会话（私聊 p2p + 群组 group）。需要 im:chat:readonly */
export async function listChats() {
  const items = []
  let pageToken
  for (let i = 0; i < 100; i++) {
    const q = { page_size: CHAT_PAGE }
    if (pageToken) q.page_token = pageToken
    const d = await api('/open-apis/im/v1/chats', { query: q })
    items.push(...(d.items || []))
    if (!d.has_more || !d.page_token) break
    pageToken = d.page_token
  }
  return items.map((c) => ({
    chatId: c.chat_id,
    name: c.name || '',
    mode: c.chat_mode || '', // p2p / group
    type: c.chat_type || '', // private / public
    external: !!c.external,
    ownerId: c.owner_id || '',
    userCount: c.user_count,
  }))
}

/** 群成员 open_id → 姓名。需要 im:chat:readonly */
export async function memberNames(chatId) {
  const map = new Map()
  let pageToken
  for (let i = 0; i < 20; i++) {
    const q = { member_id_type: 'open_id', page_size: 100 }
    if (pageToken) q.page_token = pageToken
    const d = await api(`/open-apis/im/v1/chats/${chatId}/members`, { query: q })
    for (const m of d.items || []) map.set(m.member_id, m.name || '')
    if (!d.has_more || !d.page_token) break
    pageToken = d.page_token
  }
  return map
}

/** open_id 批量解析姓名（contact:user.base:readonly）。失败返回空 Map，调用方自行兜底 */
export async function userNames(openIds) {
  const map = new Map()
  const ids = [...new Set((openIds || []).filter(Boolean))]
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50)
    try {
      const d = await api('/open-apis/contact/v3/users/batch', {
        query: { user_ids: batch.join(','), user_id_type: 'open_id' },
      })
      for (const u of d.items || []) if (u.open_id) map.set(u.open_id, u.name || '')
    } catch {
      // 权限或频率问题，跳过
    }
  }
  return map
}

/**
 * 拉取一个会话在时间窗内的消息（按时间升序）。
 * 需要 im:message:readonly。startSec/endSec 为秒级时间戳。
 */
export async function listMessages(chatId, { startSec, endSec, max = 800 } = {}) {
  const items = []
  let pageToken
  let truncated = false
  for (let i = 0; i < 200; i++) {
    const q = {
      container_id_type: 'chat',
      container_id: chatId,
      page_size: MSG_PAGE,
      sort_type: 'ByCreateTimeAsc',
    }
    if (startSec) q.start_time = String(startSec)
    if (endSec) q.end_time = String(endSec)
    if (pageToken) q.page_token = pageToken
    const d = await api('/open-apis/im/v1/messages', { query: q })
    items.push(...(d.items || []))
    if (items.length >= max) {
      truncated = items.length > max
      items.length = max
      break
    }
    if (!d.has_more || !d.page_token) break
    pageToken = d.page_token
  }
  return { messages: items.map(normalize), truncated }
}

function idOf(id) {
  if (!id) return { openId: '', userId: '', unionId: '' }
  if (typeof id === 'string') return { openId: id, userId: '', unionId: '' }
  return { openId: id.open_id || '', userId: id.user_id || '', unionId: id.union_id || '' }
}

/** 富文本 post 拍平成纯文本，@ 保留为 @姓名 */
function postToText(body) {
  const node = body.zh_cn || body.en_us || body
  const lines = []
  if (node.title) lines.push(node.title)
  for (const para of node.content || []) {
    const parts = []
    for (const el of para || []) {
      if (el.tag === 'text') parts.push(el.text || '')
      else if (el.tag === 'a') parts.push(`${el.text || ''}(${el.href || ''})`)
      else if (el.tag === 'at') parts.push('@' + (el.user_name || el.user_id || ''))
      else if (el.tag === 'img') parts.push('[图片]')
      else if (el.tag === 'media') parts.push('[视频]')
      else if (el.tag === 'emotion') parts.push('[表情]')
      else if (el.tag === 'code_block') parts.push('[代码块]')
      else if (el.text) parts.push(el.text)
    }
    lines.push(parts.join(''))
  }
  return lines.join('\n').trim()
}

/** 消息正文 → 纯文本（卡片/文件等给占位符） */
export function parseContent(msgType, rawContent) {
  let body
  try {
    body = JSON.parse(rawContent || '{}')
  } catch {
    return rawContent || ''
  }
  switch (msgType) {
    case 'text':
      return body.text || ''
    case 'post':
      return postToText(body)
    case 'image':
      return '[图片]'
    case 'file':
      return `[文件 ${body.file_name || ''}]`.trim()
    case 'audio':
      return '[语音]'
    case 'media':
      return `[视频 ${body.file_name || ''}]`.trim()
    case 'sticker':
      return '[表情]'
    case 'interactive':
      return '[卡片消息]'
    case 'share_chat':
      return '[群名片]'
    case 'share_user':
      return '[个人名片]'
    case 'merge_forward':
      return '[合并转发的聊天记录]'
    case 'system':
      return body.template || '[系统消息]'
    case 'location':
      return `[位置 ${body.name || ''}]`.trim()
    case 'todo':
      return '[任务] ' + (body.summary || '')
    case 'calendar':
      return `[日程] ${body.summary || ''}`.trim()
    default:
      return `[${msgType}]`
  }
}

/** 飞书原始消息 → 统一结构 */
export function normalize(raw) {
  const sender = raw.sender || {}
  const sid = idOf(sender.id)
  const mentions = (raw.mentions || []).map((m) => {
    const mid = idOf(m.id)
    return { key: m.key || '', openId: mid.openId, name: m.name || '' }
  })
  let text = parseContent(raw.msg_type, raw.body && raw.body.content)
  for (const m of mentions) {
    if (m.key) text = text.split(m.key).join('@' + (m.name || ''))
  }
  return {
    id: raw.message_id,
    chatId: raw.chat_id,
    ts: Number(raw.create_time) || 0,
    deleted: !!raw.deleted,
    type: raw.msg_type,
    text,
    mentions,
    senderOpenId: sid.openId,
    senderType: sender.sender_type || 'user',
    threadId: raw.thread_id || '',
    parentId: raw.parent_id || '',
  }
}

/**
 * 相关性筛选。
 * - 私聊：窗口内全部消息都算
 * - 群聊：锚点 = 别人发来的、@我 或 正文含我姓名别名的消息；再各取前后 context 条
 * 返回 { keep:Set<id>, anchor:Set<id> }
 */
export function pickRelevant(messages, { meOpenId, aliases = [], isP2P = false, context = 10 } = {}) {
  const keep = new Set()
  const anchor = new Set()
  const idx = new Map(messages.map((m, i) => [m.id, i]))
  const aliasHits = (text) => aliases.filter((a) => a && text.includes(a))

  if (isP2P) {
    for (const m of messages) {
      if (m.deleted) continue
      keep.add(m.id)
    }
    return { keep, anchor }
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.deleted) continue
    if (meOpenId && m.senderOpenId === meOpenId) continue // 我自己发的不算锚点
    const atMe = m.mentions.some((x) => x.openId && meOpenId && x.openId === meOpenId)
    const named = aliasHits(m.text).length > 0
    if (!atMe && !named) continue
    anchor.add(m.id)
    const from = Math.max(0, i - context)
    const to = Math.min(messages.length - 1, i + context)
    for (let j = from; j <= to; j++) keep.add(messages[j].id)
  }
  // 保持时间序
  const ordered = new Set([...keep].sort((a, b) => (idx.get(a) ?? 0) - (idx.get(b) ?? 0)))
  return { keep: ordered, anchor }
}

/** 给筛选结果补上展示用字段，供渲染/提炼使用 */
export function decorate(messages, { meOpenId, names = new Map(), anchor = new Set() } = {}) {
  return messages.map((m) => ({
    id: m.id,
    t: m.ts,
    from: m.senderOpenId === meOpenId ? '我' : names.get(m.senderOpenId) || m.senderOpenId.slice(0, 12),
    self: m.senderOpenId === meOpenId,
    anchor: anchor.has(m.id),
    type: m.type,
    text: m.text,
  }))
}
