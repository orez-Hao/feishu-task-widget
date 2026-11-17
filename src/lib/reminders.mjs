// 飞书提醒清单的统一读写层：CLI（apply/set）、网页版（web）、桌面便签、MCP 插件共用
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR, REMINDERS_DIR, TZ } from './config.mjs'

export const TOOL_DIR = DATA_DIR
export const OUT_DIR = REMINDERS_DIR
export const STORE = join(OUT_DIR, 'tasks.json')
export { TZ }

const dayFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ })

export function dayOf(iso) {
  if (!iso) return ''
  const d = iso instanceof Date ? iso : new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : dayFmt.format(d)
}
export const today = () => dayOf(new Date().toISOString())

export function readStore() {
  if (!existsSync(STORE)) return { version: 1, tasks: [], updatedAt: '' }
  try {
    return JSON.parse(readFileSync(STORE, 'utf8'))
  } catch (e) {
    throw new Error('reminders/tasks.json 解析失败：' + e.message)
  }
}

export function saveStore(store) {
  store.updatedAt = new Date().toISOString()
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  writeFileSync(STORE, JSON.stringify(store, null, 1), 'utf8')
}

export function openList(store) {
  return store.tasks
    .filter((t) => t.status === 'open')
    .sort((a, b) => {
      if (a.due !== b.due) {
        if (!a.due) return 1
        if (!b.due) return -1
        return a.due < b.due ? -1 : 1
      }
      return (b.priority === 'high') - (a.priority === 'high')
    })
}

// 统一排版：open.md / daily-<日期>.md 都由这里生成
export function formatTask(t) {
  const bits = []
  if (t.due) bits.push('截止 ' + t.due)
  if (t.priority === 'high') bits.push('高优先')
  if (t.requester) bits.push(t.requester + ' 提')
  if (t.source?.chat) bits.push('来源「' + t.source.chat + '」')
  const head = '- [' + t.id + '] ' + t.title
  const lines = [bits.length ? head + '  （' + bits.join(' · ') + '）' : head]
  if (t.action) lines.push('  - 要做什么：' + t.action)
  if (t.quote) lines.push('  - 原话：' + String(t.quote).replace(/\s*\n\s*/g, ' '))
  if (t.boardTaskId) lines.push('  - 任务板：' + t.boardTaskId)
  return lines.join('\n')
}

export function writeLists(store) {
  const open = openList(store)
  const ts = new Date().toLocaleString('zh-CN', { timeZone: TZ })
  writeFileSync(
    join(OUT_DIR, 'open.md'),
    ['# 未完成飞书任务（' + ts + '）', '', ...open.map(formatTask)].join('\n') + '\n',
    'utf8',
  )
  const date = today()
  writeFileSync(
    join(OUT_DIR, 'daily-' + date + '.md'),
    ['# 飞书任务提醒 · ' + date, '', '当前未完成 ' + open.length + ' 条（' + ts + ' 更新）', '', ...open.map(formatTask)].join('\n') + '\n',
    'utf8',
  )
  return { open: open.length, done: store.tasks.filter((t) => t.status === 'done').length }
}

export function withDerived(t) {
  return { ...t, scanDate: dayOf(t.firstSeen), doneDate: t.status === 'done' ? dayOf(t.doneAt) : '' }
}

export function state() {
  const store = readStore()
  const tasks = store.tasks.map(withDerived)
  return {
    ok: true,
    now: new Date().toISOString(),
    tz: TZ,
    today: today(),
    updatedAt: store.updatedAt,
    counts: {
      open: tasks.filter((t) => t.status === 'open').length,
      done: tasks.filter((t) => t.status === 'done').length,
    },
    tasks,
  }
}

export function setStatus(id, status) {
  const store = readStore()
  const t = store.tasks.find((x) => x.id === id)
  if (!t) return { ok: false, error: '没有这条任务：' + id }
  if (status === 'done') {
    t.status = 'done'
    t.doneAt = new Date().toISOString()
  } else {
    t.status = 'open'
    delete t.doneAt
  }
  saveStore(store)
  const c = writeLists(store)
  return { ok: true, task: withDerived(t), counts: c }
}

// ---------- 合并（apply.mjs 与 MCP 插件共用） ----------

export function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null
  const title = String(t.title || '').trim()
  if (!title) return null
  const src = t.source || {}
  const anchorIds = [src.anchorId, ...(t.anchorIds || [])].filter(Boolean).map(String)
  if (!anchorIds.length) anchorIds.push('t:' + title)
  return {
    title,
    action: String(t.action || '').trim(),
    requester: String(t.requester || '').trim(),
    owner: String(t.owner || '我').trim(),
    due: t.due ? String(t.due).slice(0, 10) : '',
    priority: ['high', 'normal', 'low', 'unknown'].includes(t.priority) ? t.priority : 'normal',
    confidence: typeof t.confidence === 'number' ? t.confidence : undefined,
    quote: String(t.quote || '').slice(0, 400),
    source: {
      chat: String(src.chat || ''),
      chatId: String(src.chatId || ''),
      anchorId: String(src.anchorId || ''),
      anchorTime: Number(src.anchorTime || 0),
    },
    anchorIds,
  }
}

export function makeId(t) {
  const key = (t.anchorIds[0] || t.title) + '|' + t.title
  let h = 0
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0
  return 'f' + h.toString(36) + key.length.toString(36)
}

/** 合并一批任务：同一条锚点消息只算一条（幂等） */
export function mergeTasks(incoming) {
  const store = readStore()
  const now = new Date().toISOString()
  let added = 0
  let updated = 0
  for (const raw of incoming) {
    const norm = normalizeTask(raw)
    if (!norm) continue
    const hit = store.tasks.find((t) => (t.anchorIds || []).some((a) => norm.anchorIds.includes(a)))
    if (hit) {
      hit.lastSeen = now
      hit.quote = norm.quote || hit.quote
      hit.due = norm.due || hit.due
      hit.priority = norm.priority || hit.priority
      hit.occurrences = (hit.occurrences || 1) + 1
      for (const a of norm.anchorIds) {
        if (!(hit.anchorIds || []).includes(a)) {
          hit.anchorIds = hit.anchorIds || []
          hit.anchorIds.push(a)
        }
      }
      updated++
      continue
    }
    norm.id = norm.id || makeId(norm)
    norm.status = 'open'
    norm.firstSeen = now
    norm.lastSeen = now
    norm.occurrences = 1
    store.tasks.push(norm)
    added++
  }
  saveStore(store)
  const counts = writeLists(store)
  return { added, updated, open: counts.open, done: counts.done }
}
