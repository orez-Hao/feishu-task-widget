#!/usr/bin/env node
// 把提炼出的任务合并进提醒清单（幂等：同一条锚点消息只算一条任务）
// 用法：
//   node src/apply.mjs --file tasks.json        # tasks.json 是任务数组
//   node src/apply.mjs --file - < tasks.json    # 从 stdin 读
//   node src/apply.mjs --done <taskId>          # 手工标记完成
//   node src/apply.mjs --board <taskId>:<card>  # 记录已建的任务板卡片
//   node src/apply.mjs --open                   # 只打印未完成清单
import { readFileSync } from 'node:fs'
import { mergeTasks, readStore, saveStore, setStatus, openList, formatTask, STORE } from './lib/reminders.mjs'

const argv = process.argv.slice(2)
const arg = (n) => {
  const i = argv.indexOf('--' + n)
  return i >= 0 ? argv[i + 1] : undefined
}
const fail = (msg) => {
  console.error('✖ ' + msg)
  process.exit(1)
}
const printOpen = (store) => {
  const open = openList(store)
  if (!open.length) return console.log('（当前没有未完成任务）')
  console.log('')
  console.log('--- 未完成 ' + open.length + ' 条 ---')
  for (const t of open) console.log(formatTask(t))
  const needBoard = open.filter((t) => !t.boardTaskId)
  if (needBoard.length) console.log('\n需要建任务板卡片：' + needBoard.map((t) => t.id).join(' '))
}

if (argv.includes('--open')) {
  printOpen(readStore())
  process.exit(0)
}

if (arg('done')) {
  const out = setStatus(arg('done'), 'done')
  if (!out.ok) fail(out.error)
  console.log('✔ 已标记完成：' + out.task.title)
  printOpen(readStore())
  process.exit(0)
}

if (arg('board')) {
  const [id, cardId] = String(arg('board')).split(':')
  const store = readStore()
  const t = store.tasks.find((x) => x.id === id)
  if (!t) fail('没有这条任务：' + id)
  t.boardTaskId = cardId
  t.boardAt = new Date().toISOString()
  saveStore(store)
  console.log('✔ ' + t.title + ' → 任务板 ' + cardId)
  process.exit(0)
}

const file = arg('file')
if (!file) {
  console.error('用法：node src/apply.mjs --file tasks.json （或 --open / --done <id> / --board <id>:<card>）')
  process.exit(1)
}

const raw = file === '-' ? readFileSync(0, 'utf8') : readFileSync(file, 'utf8')
let incoming
try {
  incoming = JSON.parse(raw)
} catch (e) {
  fail('tasks.json 不是合法 JSON：' + e.message)
}
if (!Array.isArray(incoming)) incoming = incoming.tasks || []
if (!incoming.length) {
  console.log('没有新任务。')
  printOpen(readStore())
  process.exit(0)
}

const merged = mergeTasks(incoming)
console.log('✔ 新增 ' + merged.added + ' 条，合并 ' + merged.updated + ' 条，清单共 ' + merged.open + ' 条未完成')
console.log('  存储：' + STORE)
printOpen(readStore())
