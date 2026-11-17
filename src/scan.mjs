#!/usr/bin/env node
// 飞书消息扫描：把「跟我相关的消息」拉成本地 digest，供任务提炼使用
// 用法：
//   node src/scan.mjs                       # 扫最近 24 小时
//   node src/scan.mjs --hours 72            # 扫最近 3 天
//   node src/scan.mjs --since 2026-11-12T09:00:00+08:00 --until 2026-11-12T18:00:00+08:00
//   node src/scan.mjs --chats 项目A,固件     # 只看名字含这些词的会话
//   node src/scan.mjs --context 15          # 锚点前后各取多少条（默认 10）
//   node src/scan.mjs --self-test           # 离线自检，不联网
import { mkdir, writeFile } from 'node:fs/promises'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL_DIR } from './lib/auth.mjs'
import { listChats, listMessages, memberNames, whoAmI, pickRelevant, decorate, normalize, userNames } from './lib/im.mjs'

const argv = process.argv.slice(2)
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}
const has = (name) => argv.includes('--' + name)

if (has('self-test')) {
  runSelfTest()
  process.exit(0)
}

const now = Date.now()
const until = arg('until') ? toMs(arg('until')) : now
const since = arg('since')
  ? toMs(arg('since'))
  : until - Number(arg('hours', 24)) * 3600 * 1000
const context = Number(arg('context', 10))
const maxPerChat = Number(arg('max-per-chat', 800))
const maxTotal = Number(arg('max-total', 4000))
const chatFilter = String(arg('chats', ''))
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
const label = arg('label', '')

const me = await whoAmI()
const aliases = [me.name, ...String(arg('alias', '')).split(',')]
  .map((s) => (s || '').trim())
  .filter(Boolean)

let chats = await listChats()

// 飞书不返回私聊会话列表：并入 p2p-discover.mjs 发现的私聊（按私聊规则全量读取）
const p2pFile = join(TOOL_DIR, 'p2p-chats.json')
if (existsSync(p2pFile)) {
  try {
    for (const c of JSON.parse(readFileSync(p2pFile, 'utf8')).chats || []) {
      if (chats.some((x) => x.chatId === c.chatId)) continue
      chats.push({ chatId: c.chatId, name: c.name || '', mode: 'p2p', type: 'p2p', external: false, userCount: 2 })
    }
  } catch {
    // 文件坏了就别管
  }
}
if (chatFilter.length) {
  chats = chats.filter(
    (c) => chatFilter.some((k) => (c.name || '').includes(k) || c.chatId.includes(k)),
  )
}
chats.sort((a, b) => (a.mode === 'p2p' ? -1 : 0) - (b.mode === 'p2p' ? -1 : 0))

const sections = []
const errors = []
let budget = maxTotal
let keptTotal = 0
let anchorTotal = 0

for (const chat of chats) {
  if (budget <= 0) {
    errors.push('已达总条数上限 ' + maxTotal + '，后续会话未扫描')
    break
  }
  const isP2P = chat.mode === 'p2p'
  let fetched
  try {
    fetched = await listMessages(chat.chatId, {
      startSec: Math.floor(since / 1000),
      endSec: Math.floor(until / 1000),
      max: Math.min(maxPerChat, budget),
    })
  } catch (err) {
    errors.push(`${chat.name || chat.chatId}：${err.message}`)
    continue
  }
  if (!fetched.messages.length) continue

  const names = new Map()
  if (isP2P) {
    try {
      for (const [k, v] of await memberNames(chat.chatId)) names.set(k, v)
    } catch {
      // p2p 成员接口不稳定，退回按发送者解析
    }
    const missing = fetched.messages.map((m) => m.senderOpenId).filter((id) => id && !names.get(id))
    if (missing.length) for (const [k, v] of await userNames(missing)) if (!names.get(k)) names.set(k, v)
  }
  if (!isP2P) {
    try {
      for (const [k, v] of await memberNames(chat.chatId)) names.set(k, v)
    } catch (err) {
      errors.push(`${chat.name || chat.chatId} 成员列表失败：${err.message}`)
    }
  }
  const { keep, anchor } = pickRelevant(fetched.messages, {
    meOpenId: me.openId,
    aliases,
    isP2P,
    context,
  })
  if (!keep.size) continue

  const msgs = decorate(
    fetched.messages.filter((m) => keep.has(m.id)),
    { meOpenId: me.openId, names, anchor },
  )
  budget -= msgs.length
  keptTotal += msgs.length
  anchorTotal += anchor.size
  sections.push({
    chatId: chat.chatId,
    name: chat.name || (isP2P ? '(私聊)' : '(未命名群)'),
    mode: chat.mode,
    userCount: chat.userCount,
    external: chat.external,
    truncated: fetched.truncated,
    anchorCount: anchor.size,
    messages: msgs,
  })
}

const stamp = new Date(until).toISOString().replace(/[:.]/g, '-').slice(0, 19)
const outDir = arg('out', join(TOOL_DIR, 'out', 'im', stamp))
await mkdir(outDir, { recursive: true })

const meta = {
  generatedAt: new Date().toISOString(),
  label: label || undefined,
  me: { openId: me.openId, name: me.name },
  window: { from: new Date(since).toISOString(), to: new Date(until).toISOString() },
  contextLines: context,
  stats: {
    chatsScanned: chats.length,
    chatsWithHits: sections.length,
    messagesKept: keptTotal,
    anchors: anchorTotal,
  },
  errors,
}

await writeFile(join(outDir, 'digest.json'), JSON.stringify({ ...meta, chats: sections }, null, 1), 'utf8')
await writeFile(join(outDir, 'digest.md'), renderMarkdown(meta, sections), 'utf8')

if (has('json')) {
  console.log(JSON.stringify({ outDir, ...meta }, null, 1))
} else {
  console.log(`✔ 扫描完成：${meta.stats.chatsScanned} 个会话，命中 ${sections.length} 个，锚点 ${anchorTotal} 条，保留消息 ${keptTotal} 条`)
  console.log(`  窗口：${meta.window.from} → ${meta.window.to}`)
  console.log(`  输出：${outDir}`)
  if (errors.length) {
    console.log(`  ⚠ ${errors.length} 条错误：`)
    for (const e of errors.slice(0, 5)) console.log('    - ' + e)
    if (looksLikeScopeError(errors.join('\n'))) printScopeHint()
  }
}

// ---------- 渲染 ----------

function fmt(ts) {
  const d = new Date(ts)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

function renderMarkdown(meta, sections) {
  const lines = []
  lines.push('# 飞书消息 digest')
  lines.push('')
  lines.push(`- 窗口：${meta.window.from} → ${meta.window.to}`)
  lines.push(`- 我：${meta.me.name || ''}（${meta.me.openId}）`)
  lines.push(
    `- 统计：会话 ${meta.stats.chatsScanned} / 命中 ${meta.stats.chatsWithHits}，锚点 ${meta.stats.anchors}，保留 ${meta.stats.messagesKept} 条`,
  )
  lines.push('- 规则：私聊全取；群里取 @我 或提到我名字的消息，前后各 ' + meta.contextLines + ' 条')
  lines.push('- 标记：<<锚点>> = 触发这条的原始消息；[我] = 我自己发的')
  lines.push('')
  for (const s of sections) {
    const kind = s.mode === 'p2p' ? '私聊' : `群${s.external ? '(外部)' : ''}`
    lines.push(`## ${kind}：${s.name}` + (s.anchorCount ? ` · 锚点 ${s.anchorCount} 条` : ''))
    lines.push('')
    for (const m of s.messages) {
      const who = m.self ? '[我]' : m.from
      const mark = m.anchor ? ' <<锚点>>' : ''
      const text = String(m.text || '').replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 600)
      lines.push(`- ${fmt(m.t)} ${who}：${text}${mark}`)
    }
    if (s.truncated) lines.push('- …（该会话消息过多，已截断）')
    lines.push('')
  }
  return lines.join('\n')
}

function looksLikeScopeError(text) {
  return /99991672|131006|permission|权限|im:message|im:chat/i.test(text)
}

function printScopeHint() {
  console.log('')
  console.log('  → 看起来是权限没开。到 https://open.feishu.cn/app/<你的app>/auth 添加：')
  console.log('     im:chat:readonly（读会话/成员）、im:message:readonly（读消息）')
  console.log('     发布并等管理员审批，然后重跑 1-授权登录.cmd')
}

function toMs(v) {
  if (/^\d+$/.test(v)) {
    const n = Number(v)
    return n > 1e12 ? n : n * 1000
  }
  const t = Date.parse(v)
  if (Number.isNaN(t)) {
    console.error('✖ 无法解析时间：' + v)
    process.exit(1)
  }
  return t
}

// ---------- 离线自检 ----------

function runSelfTest() {
  const assert = (cond, name) => {
    if (!cond) {
      console.error('✖ 自检失败：' + name)
      process.exit(1)
    }
    console.log('✔ ' + name)
  }
  const raw = (id, ts, openId, type, content, mentions = []) => ({
    message_id: id,
    chat_id: 'oc_test',
    create_time: String(ts),
    msg_type: type,
    body: { content: typeof content === 'string' ? JSON.stringify(content) : JSON.stringify(content) },
    sender: { id: { open_id: openId }, sender_type: 'user' },
    mentions,
  })
  const ME = 'ou_me'
  const WANG = 'ou_wang'

  const meMsg = normalize(raw('m1', 1000, ME, 'text', { text: '我发的' }))
  assert(meMsg.text === '我发的' && meMsg.senderOpenId === ME, 'text 解析')

  const atMsg = normalize(
    raw('m2', 2000, WANG, 'text', { text: '@_user_1 麻烦明天前确认方案' }, [
      { key: '@_user_1', id: { open_id: ME }, name: '测试者' },
    ]),
  )
  assert(atMsg.text.includes('@测试者') && atMsg.mentions[0].openId === ME, '@ 替换为姓名')

  const postMsg = normalize(
    raw('m3', 3000, WANG, 'post', {
      zh_cn: {
        title: '周会纪要',
        content: [[{ tag: 'text', text: '决议：' }, { tag: 'at', user_name: '测试者', user_id: ME }]],
      },
    }),
  )
  assert(postMsg.text.includes('周会纪要') && postMsg.text.includes('@测试者'), 'post 富文本拍平')

  // 群聊：13 条普通消息，第 7 条 @我 → 期望保留 ±10 条 = 全部
  const groupMsgs = []
  for (let i = 0; i < 13; i++) {
    const at = i === 7 ? [{ key: '@_user_1', id: { open_id: ME }, name: '测试者' }] : []
    groupMsgs.push(
      normalize(
        raw('g' + i, 1000 + i, i === 6 ? ME : WANG, 'text', { text: (at.length ? '@_user_1 ' : '') + '消息' + i }, at),
      ),
    )
  }
  const p2 = pickRelevant(groupMsgs, { meOpenId: ME, aliases: ['测试者'], isP2P: false, context: 10 })
  assert(p2.anchor.size === 1 && p2.anchor.has('g7'), '群聊只以 @我 的消息为锚点')
  assert(p2.keep.size === 13, '锚点前后各 10 条上下文（本例覆盖全部 13 条）')

  const p3 = pickRelevant(groupMsgs, { meOpenId: ME, aliases: ['测试者'], isP2P: false, context: 1 })
  assert(p3.keep.size === 3 && p3.keep.has('g6') && p3.keep.has('g8'), 'context=1 时保留锚点±1（3 条，含我自己那条）')

  const selfRaw = normalize(
    raw('s1', 5000, ME, 'text', { text: '@_user_1 我自己记一下' }, [
      { key: '@_user_1', id: { open_id: ME }, name: '测试者' },
    ]),
  )
  const p7 = pickRelevant([selfRaw], { meOpenId: ME, aliases: [], isP2P: false, context: 10 })
  assert(p7.anchor.size === 0, '我自己发的消息即使 @我 也不当锚点')

  const quiet = groupMsgs.map((m) => ({ ...m, mentions: [], text: '闲聊' }))
  const p4 = pickRelevant(quiet, { meOpenId: ME, aliases: ['测试者'], isP2P: false, context: 10 })
  assert(p4.keep.size === 0, '没 @我 也没提名字 → 群聊零命中')

  const named = quiet.map((m, i) => (i === 2 ? { ...m, text: '这个让测试者跟进一下' } : m))
  const p5 = pickRelevant(named, { meOpenId: ME, aliases: ['测试者'], isP2P: false, context: 2 })
  assert(p5.anchor.size === 1 && p5.keep.size === 5, '正文出现姓名也算锚点（±2 = 5 条）')

  const p6 = pickRelevant(groupMsgs, { meOpenId: ME, aliases: [], isP2P: true, context: 10 })
  assert(p6.keep.size === 13, '私聊全量保留')

  const dec = decorate(groupMsgs.slice(6, 8), { meOpenId: ME, names: new Map([[WANG, '王五']]), anchor: new Set(['g7']) })
  assert(dec[0].from === '我' && dec[1].from === '王五' && dec[1].anchor === true, '姓名解析、「我」标记与锚点标记')

  console.log('\n全部自检通过')
}


