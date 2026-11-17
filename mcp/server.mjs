#!/usr/bin/env node
// feishu-task-widget 的 MCP 插件（stdio）。给 DeepSeek Harness 或任何 MCP 客户端用。
// 注册示例见 docs/DSH-PLUGIN.md。
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { DATA_DIR } from '../src/lib/config.mjs'
import { state, setStatus, mergeTasks } from '../src/lib/reminders.mjs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..')
const SRC = join(ROOT, 'src')
const DESKTOP = join(ROOT, 'desktop')
// 数据目录只由 src/lib/config.mjs 决定（.data-dir / 环境变量 / home），不在这里重复实现

const VERSION = '0.1.0'

/** 跑一个 src/ 下的脚本，收 stdout/stderr */
function run(script, args = [], { timeoutMs = 180000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [join(SRC, script), ...args], {
      cwd: ROOT,
      env: process.env,
      windowsHide: true,
    })
    let out = ''
    let err = ''
    const timer = setTimeout(() => child.kill(), timeoutMs)
    child.stdout.on('data', (d) => (out += d.toString()))
    child.stderr.on('data', (d) => (err += d.toString()))
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: 1, out: '', err: e.message })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? 1, out: out.trim(), err: err.trim() })
    })
  })
}

const text = (s) => ({ content: [{ type: 'text', text: s }] })
const fail = (s) => ({ content: [{ type: 'text', text: s }], isError: true })

/** 跑脚本并把结果原文返回；失败时把 stderr 一起带出去 */
async function runOrReport(script, args, emptyText) {
  const r = await run(script, args)
  if (r.code !== 0) return fail('命令失败：' + script + ' ' + args.join(' ') + '\n' + (r.err || r.out || '(无输出)'))
  return text(r.out || emptyText || '(完成，无输出)')
}

const tools = [
  {
    name: 'feishu_status',
    description: '检查飞书接入状态：应用凭证是否就绪、当前以谁的身份登录、令牌还有多久过期。开始任何操作前先调它。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    handler: async () => runOrReport('index.mjs', ['status']),
  },
  {
    name: 'feishu_scan',
    description: '扫描最近 N 小时的飞书消息（私聊全取 + 群里 @我/提到我），生成给模型阅读的 digest。返回 digest 的路径与正文（过长会截断）。',
    inputSchema: {
      type: 'object',
      properties: {
        hours: { type: 'number', description: '回溯小时数，默认 24' },
        maxLines: { type: 'number', description: '返回 digest 正文最多多少行，默认 400' },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      const hours = Number(args.hours || 24)
      const maxLines = Number(args.maxLines || 400)
      const r = await run('scan.mjs', ['--hours', String(hours), '--json'])
      if (r.code !== 0) return fail('扫描失败：' + (r.err || r.out))
      let meta
      try {
        meta = JSON.parse(r.out)
      } catch {
        return fail('扫描输出解析失败：' + r.out.slice(0, 500))
      }
      const md = join(meta.outDir, 'digest.md')
      if (!existsSync(md)) return fail('没找到 digest.md：' + md)
      const lines = readFileSync(md, 'utf8').split(/\r?\n/)
      const body = lines.slice(0, maxLines).join('\n')
      const more = lines.length > maxLines ? '\n…（共 ' + lines.length + ' 行，已截断，完整内容见 ' + md + '）' : ''
      return text('digest：' + md + '\n窗口：' + meta.window.from + ' → ' + meta.window.to + '\n命中会话 ' + meta.stats.chatsWithHits + ' / 锚点 ' + meta.stats.anchors + '\n\n' + body + more)
    },
  },
  {
    name: 'feishu_tasks',
    description: '列出提醒清单里的任务（默认只列未完成），带 id、截止日、谁提的。',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string', enum: ['open', 'all'], description: 'open=只看未完成（默认），all=全部' } },
      additionalProperties: false,
    },
    handler: async (args) => {
      const snap = state()
      const list = (snap.tasks || []).filter((t) => (args.status === 'all' ? true : t.status === 'open'))
      if (!list.length) return text('清单里没有任务。')
      const lines = list.map((t) => {
        const bits = []
        if (t.due) bits.push('截止 ' + t.due)
        if (t.priority === 'high') bits.push('高优先')
        if (t.requester) bits.push(t.requester + ' 提')
        if (t.status === 'done') bits.push('已完成')
        const head = '- [' + t.id + '] ' + bits.join(' · ') + ' ' + t.title
        const sub = t.action ? '\n    ' + t.action : ''
        return head + sub
      })
      return text('共 ' + list.length + ' 条（未完成 ' + snap.counts.open + '，已完成 ' + snap.counts.done + '）：\n' + lines.join('\n'))
    },
  },
  {
    name: 'feishu_task_done',
    description: '把某条任务标记为已完成（同时刷新 open.md / daily-<日期>.md）。',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: '任务 id，如 f1ww7r4h1o' } }, required: ['id'], additionalProperties: false },
    handler: async (args) => {
      const out = setStatus(String(args.id), 'done')
      return out.ok ? text('✔ 已完成：' + out.task.title + '（未完成 ' + out.counts.open + ' 条）') : fail(out.error || '标记失败')
    },
  },
  {
    name: 'feishu_task_open',
    description: '把某条任务改回未完成。',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    handler: async (args) => {
      const out = setStatus(String(args.id), 'open')
      return out.ok ? text('✔ 已改回未完成：' + out.task.title + '（未完成 ' + out.counts.open + ' 条）') : fail(out.error || '修改失败')
    },
  },
  {
    name: 'feishu_task_add',
    description: '手工加一条任务进提醒清单。anchorId 用来去重：同一条锚点消息只算一条任务。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: '一句话，动词开头，≤30 字' },
        action: { type: 'string', description: '具体要做什么' },
        requester: { type: 'string', description: '谁提的' },
        due: { type: 'string', description: '截止日 YYYY-MM-DD，没有就留空' },
        priority: { type: 'string', enum: ['high', 'normal', 'low'] },
        quote: { type: 'string', description: '触发这条的原文片段' },
        chat: { type: 'string', description: '来源会话名' },
        chatId: { type: 'string' },
        anchorId: { type: 'string', description: '飞书消息 id（om_…）' },
        anchorTime: { type: 'number' },
      },
      required: ['title'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const task = {
        title: args.title,
        action: args.action || '',
        requester: args.requester || '',
        owner: '我',
        due: args.due || '',
        priority: args.priority || 'normal',
        confidence: 0.8,
        quote: args.quote || '',
        source: {
          chat: args.chat || '',
          chatId: args.chatId || '',
          anchorId: args.anchorId || '',
          anchorTime: Number(args.anchorTime || 0),
        },
      }
      const merged = mergeTasks([task])
      return text('✔ 新增 ' + merged.added + ' 条（合并 ' + merged.updated + ' 条），清单共 ' + merged.open + ' 条未完成')
    },
  },
  {
    name: 'feishu_p2p_discover',
    description: '用消息搜索反推真人私聊会话（飞书不提供私聊列表接口），结果写进数据目录的 p2p-chats.json，之后的扫描会自动带上私聊全量。',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '回溯天数，默认 60' },
        maxResolve: { type: 'number', description: '最多解析多少条命中，默认 80；越大越慢' },
      },
      additionalProperties: false,
    },
    handler: async (args) =>
      runOrReport('p2p-discover.mjs', ['--days', String(args.days || 60), '--max-resolve', String(args.maxResolve || 80)]),
  },
  {
    name: 'desktop_widget',
    description: 'Windows 桌面便签：start 启动、stop 结束、restart 重启（改完代码或看不到窗口时用 restart）。非 Windows 平台会直接报错。',
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', enum: ['start', 'stop', 'restart'] } },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      if (process.platform !== 'win32') return fail('桌面便签只支持 Windows。')
      const wscript = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
      const ps = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      const stopPs1 = join(DESKTOP, 'stop-widget.ps1')
      const startVbs = join(DESKTOP, 'start-widget.vbs')
      const runCmd = (exe, argv2) =>
        new Promise((resolve) => {
          const child = spawn(exe, argv2, { cwd: DESKTOP, windowsHide: true })
          let out = ''
          child.stdout.on('data', (d) => (out += d.toString()))
          child.on('close', (code) => resolve({ code: code ?? 1, out: out.trim() }))
          child.on('error', (e) => resolve({ code: 1, out: e.message }))
        })
      if (args.action === 'stop') {
        const r = await runCmd(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopPs1])
        return text(r.out || '已结束')
      }
      if (args.action === 'restart') {
        await runCmd(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', stopPs1])
        const r = await runCmd(wscript, [startVbs])
        return text('已重启桌面便签。' + (r.out ? ' ' + r.out : ''))
      }
      const r = await runCmd(wscript, [startVbs])
      return text('已启动桌面便签。' + (r.out ? ' ' + r.out : ''))
    },
  },
]

const server = new Server({ name: 'feishu-task-widget', version: VERSION }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name
  const tool = tools.find((t) => t.name === name)
  if (!tool) return fail('没有这个工具：' + name)
  try {
    return await tool.handler(req.params.arguments || {})
  } catch (err) {
    return fail(name + ' 失败：' + (err && err.message ? err.message : String(err)))
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
console.error('feishu-task-widget MCP 已就绪（stdio），数据目录：' + DATA_DIR)
