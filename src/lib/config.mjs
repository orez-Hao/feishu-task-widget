// 一切可写数据的落点：默认 ~/.feishu-task-widget，可用 FEISHU_TASK_DATA 覆盖。
// 安装目录（含 package.json 的仓库根）只放代码，不写运行时文件。
import { join, resolve, dirname } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 仓库根目录（package.json 所在处） */
export const PKG_ROOT = resolve(HERE, '..', '..')

/** 数据目录：令牌、扫描结果、提醒清单、桌面便签偏好都在这。
 *  优先级：环境变量 FEISHU_TASK_DATA > 仓库根 .data-dir 文件内容 > ~/.feishu-task-widget
 *  .data-dir 用于「便携模式」：把数据放在仓库旁边（U 盘/多机同步/不想写 home）时用。 */
function resolveDataDir() {
  if (process.env.FEISHU_TASK_DATA) return process.env.FEISHU_TASK_DATA
  try {
    const marker = join(PKG_ROOT, '.data-dir')
    if (existsSync(marker)) {
      const v = readFileSync(marker, 'utf8').trim()
      if (v) return v
    }
  } catch {
    // 读不到就当没配
  }
  return join(homedir(), '.feishu-task-widget')
}

export const DATA_DIR = resolveDataDir()
export const STATE_DIR = join(DATA_DIR, 'state')
export const STATE_FILE = join(STATE_DIR, 'user-token.json')
export const OUT_DIR = join(DATA_DIR, 'out')
export const REMINDERS_DIR = process.env.FEISHU_REMINDERS_DIR || join(DATA_DIR, 'reminders')

/** .env 候选路径（先到先得，进程环境变量优先级最高） */
export const ENV_CANDIDATES = [
  join(process.cwd(), '.env'),
  join(PKG_ROOT, '.env'),
  join(DATA_DIR, '.env'),
  join(homedir(), '.dsh', '.env'), // 兼容已经在 DeepSeek Harness 里配过凭证的用户
].filter(Boolean)

export const TZ = 'Asia/Shanghai'
