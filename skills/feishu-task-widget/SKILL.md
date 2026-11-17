---
name: feishu-task-widget
description: Use when the user wants to turn Feishu (Lark) messages into task reminders — scanning recent messages, extracting assigned work, maintaining the reminders list, or wiring up the desktop widget / MCP plugin. Also use when an install or an MCP tool call fails, e.g. patch entry not found, missing scope, or node not found.
---

# feishu-task-widget：飞书消息 → 任务提醒

一个仓库三件事：**扫描**飞书消息成 digest、**提炼**成任务清单、通过 **CLI / 桌面便签 / MCP 插件** 三种方式使用。
仓库地址：<https://github.com/orez-Hao/feishu-task-widget>

## 先确认三件必须由人类完成的事

动手前逐条核对，缺哪条就**停下来请用户完成**，不要猜、不要跳过：

1. **飞书自建应用**：用户本人在 <https://open.feishu.cn/app> 建应用 → 开「网页应用」能力 → 重定向 URL `http://localhost:3000/callback` → 开 8 个权限（`im:message:readonly` `im:chat:read` `im:chat.members:read` `im:message.group_msg:get_as_user` `im:message.p2p_msg:get_as_user` `contact:user.base:readonly` `search:message` `offline_access`）→ 创建版本并发布。
2. **本人账号授权**：跑 `node src/index.mjs login`，由用户自己在浏览器点同意。令牌是按人身份的，读的是**他**可见的会话。
3. **完全重启 DSH 宿主**：改完 MCP 配置后新开会话不生效，必须关掉再 `dsh web`。

## 安装后的最小自检

```powershell
node -v                                  # 需要 >= 18
npm install
node src/scan.mjs --self-test            # 11 项全过，离线、不需要凭证
node src/index.mjs status                # 凭证已配置 + 登录有效
```

`--self-test` 全过就说明代码本身没问题；它不过就别往飞书 API 上找原因。

## 日常流水线

```powershell
node src/index.mjs p2p --days 60 --max-resolve 80   # 发现真人私聊（可先跑一次）
node src/scan.mjs --hours 24 --json                 # → <数据目录>/out/im/<时间戳>/digest.md
```

然后：读 `digest.md` → 按「判定规则」产出 `tasks.json` → `node src/index.mjs apply --file tasks.json`。

**判定规则**（只有这些算任务）：明确派给用户、有交付物或时限、别人等他回复且未当场答复。
**不算**：闲聊、仅 @ 一下的通知、已答复过的、机器人消息、别人认领的事。
**去重**：每条必须带真实消息 id 作 `anchorId`（`om_…`，取自 digest.json），同锚点只算一条；拿不到锚点就别输出该条。

## 常见故障与处理

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `patch: entry … not found` | DSH 的 `cordis.patch.yml` 写成了 `- id:` 覆盖式 | 改成 `- insert:` 列表（见仓库 docs/DSH-PLUGIN.md），再核对 `dsh --profile web --dump-config` 无 warning |
| 加了插件但没工具 | 只新开了会话 | 完全重启宿主 |
| `Cannot find package '@modelcontextprotocol/sdk'` | 没 `npm install` | 装依赖；`failOnStartupError: true` 便于看错 |
| 找不到 node | `command` 写了相对名 | 先 `where.exe node`，填绝对路径 |
| `99991679` | 缺 scope | 回后台补权限、重新 login |
| `99991695` | 旧版授权调 im/v1/messages | 本项目走 authen/v2，重新 login |
| `20029` | 应用缺「网页应用」能力 | 补能力后重新发布 |
| 私聊列表为空 | 未批 `search:message` | 群聊扫描仍可用，告知用户即可 |
| `spawn EPERM` | 宿主跑在受限容器里 | 改用 CLI（`node src/index.mjs scan`）而非插件工具 |

## 输出与数据

- 数据目录默认 `~/.feishu-task-widget`；可用环境变量 `FEISHU_TASK_DATA` 或仓库根 `.data-dir` 改。
- 清单：`reminders/tasks.json`（机器读）、`open.md` / `daily-<日期>.md`（人读）。
- 仓库里**不含任何凭证**，永远不要把用户的 `.env` 内容打印出来或提交。

## 桌面便签（仅 Windows）

双击 `desktop/start-widget.vbs`；起不来就 `desktop/diagnose-widget.cmd`，日志在 `<数据目录>/state/widget.log`。
