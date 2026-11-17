#!/usr/bin/env node
// feishu-task-widget 命令行入口：把各子命令转发给 src/ 下对应脚本
//   node src/index.mjs status                 # 看凭证 / 登录状态
//   node src/index.mjs login                  # 走一次用户授权
//   node src/index.mjs scan --hours 24        # 扫描 → digest.md/json
//   node src/index.mjs apply --file tasks.json
//   node src/index.mjs tasks                  # 当前未完成清单
//   node src/index.mjs done <taskId> | open <taskId>
//   node src/index.mjs p2p --days 60 --max-resolve 80
//   node src/index.mjs web                    # 浏览器版便签
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DATA_DIR } from './lib/config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const cmd = argv[0] || 'help'
const rest = argv.slice(1)

// 用 process.exitCode 而不是 process.exit：Windows 上 stdout 还没冲刷就硬退会触发 libuv 断言
const run = (script, args) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [join(HERE, script), ...args], { stdio: 'inherit' })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', (err) => {
      console.error('启动失败：' + err.message)
      resolve(1)
    })
  })

async function status() {
  const { loadConfig, readState, getAccessToken } = await import('./lib/auth.mjs')
  const cfg = loadConfig()
  console.log('数据目录：' + DATA_DIR)
  console.log('应用凭证：' + (cfg.appId ? '已配置（' + cfg.appId + '）' : '缺失 — 在 .env 里写你自己的 FEISHU_APP_ID / FEISHU_APP_SECRET'))
  const st = readState()
  if (!st) {
    console.log('登录状态：未登录，运行 node src/index.mjs login')
    return
  }
  try {
    await getAccessToken()
    const left = Math.max(0, Math.round((st.expires_at - Date.now()) / 60000))
    console.log('登录状态：有效，access_token 剩余约 ' + left + ' 分钟')
    if (st.scope) console.log('授权范围：' + st.scope.split(' ').slice(0, 8).join(' ') + ' …')
  } catch (err) {
    console.log('登录状态：异常 — ' + err.message)
  }
}

const forward = {
  login: 'login.mjs',
  scan: 'scan.mjs',
  apply: 'apply.mjs',
  p2p: 'p2p-discover.mjs',
  names: 'p2p-names.mjs',
  web: 'web.mjs',
}

async function main() {
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log('feishu-task-widget 用法：')
    console.log('  status                       看凭证/登录状态')
    console.log('  login [--port 3000]          用户授权（拿 user_access_token）')
    console.log('  scan --hours 24 [--json]     扫描消息 → 数据目录/out/im/<时间戳>/digest.md')
    console.log('  apply --file tasks.json      把提炼出的任务并进清单')
    console.log('  tasks                        打印未完成清单')
    console.log('  done <taskId> / open <id>    标记完成 / 改回未完成')
    console.log('  p2p --days 60 --max-resolve 80   发现真人私聊会话')
    console.log('  names                        给私聊会话补姓名')
    console.log('  web [--port 3123]            浏览器版便签')
    console.log('数据目录：' + DATA_DIR + '（可用 FEISHU_TASK_DATA 或仓库根 .data-dir 覆盖）')
    return 0
  }

  if (cmd === 'status') {
    await status()
    return 0
  }

  if (cmd === 'tasks') return run('set.mjs', ['state', '--print'])

  if (cmd === 'done' || cmd === 'open') {
    if (!rest[0]) {
      console.error('缺少 taskId，例如：node src/index.mjs done f1abc')
      return 1
    }
    return run('set.mjs', [cmd, rest[0], '--print'])
  }

  const target = forward[cmd]
  if (!target) {
    console.error('未知命令：' + cmd + '（node src/index.mjs help 看用法）')
    return 1
  }
  return run(target, rest)
}

process.exitCode = await main()
