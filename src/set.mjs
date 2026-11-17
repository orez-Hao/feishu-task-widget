#!/usr/bin/env node
// 清单读写命令行：给桌面插件（desk-widget.ps1）用，避免 PowerShell 反复解析中文 JSON
//   node src/set.mjs state [--file <path>]        # 导出当前状态（UTF-8 JSON）
//   node src/set.mjs done <taskId> [--file <path>] # 标记完成
//   node src/set.mjs open <taskId> [--file <path>] # 改回未完成
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { state, setStatus } from './lib/reminders.mjs'

const argv = process.argv.slice(2)
const fileIdx = argv.indexOf('--file')
const outFile = fileIdx >= 0 ? argv[fileIdx + 1] : ''
const args = fileIdx >= 0 ? argv.filter((a, i) => !(a === '--file' || i === fileIdx + 1)) : argv.slice()
const [mode, id] = args

let result
if (mode === 'state' || !mode) {
  result = state()
} else if (mode === 'done' || mode === 'open') {
  if (!id) {
    console.error('缺少 taskId')
    process.exit(1)
  }
  result = setStatus(id, mode)
} else {
  console.error('用法：node src/set.mjs state | done <taskId> | open <taskId> [--file <path>]')
  process.exit(1)
}

const print = args.includes('--print')
const text = JSON.stringify(result, null, 1)
if (print && result && Array.isArray(result.tasks)) {
  const open = result.tasks.filter((t) => t.status === 'open')
  const done = result.tasks.filter((t) => t.status === 'done')
  const line = (t) =>
    '- [' + t.id + '] ' + (t.due ? '[' + t.due + '] ' : '') + (t.priority === 'high' ? '!' : ' ') + t.title +
    (t.requester ? '   ← ' + t.requester : '')
  console.log('未完成 ' + open.length + ' 条，已完成 ' + done.length + ' 条')
  for (const t of open) console.log(line(t))
  for (const t of done) console.log('[已完成] ' + t.title)
} else if (print) {
  console.log(result && result.ok === false ? '✖ ' + result.error : JSON.stringify(result, null, 1))
}
if (outFile) { mkdirSync(dirname(outFile), { recursive: true }); writeFileSync(outFile, text, 'utf8') }
else if (!print && (mode === 'state' || !mode)) process.stdout.write(text + '\n')

process.exit(result.ok === false ? 1 : 0)
