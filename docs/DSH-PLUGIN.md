# 在 DeepSeek Harness 里当插件用

自带一个 MCP（stdio）服务，DSH 用内置的 @deepseek-ai/dsh-mcp-client 挂它。

## 1. 注册

编辑 `~/.dsh/profiles/web/cordis.patch.yml`，追加一条（路径按你的实际位置改）：

```yaml
- insert:
    - id: mcp-feishu-task
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: feishu-task
        transport: stdio
        command: 'C:\Program Files\nodejs\node.exe'
        args:
          - 'C:\path\to\feishu-task-widget\mcp\server.mjs'
        toolCallTimeoutMs: 180000
        failOnStartupError: true
```

**必须完全重启 DSH 宿主**（关掉再用 `dsh web` 启动）。新开一个会话**不够**——`cordis.patch.yml` 是启动时组合的 profile 层，只重开会话不会重读。

重启前后各验一次：

```powershell
where.exe node        # 拿到 node 的绝对路径，填进上面的 command
dsh --profile web --dump-config | Select-String feishu   # 应该能看到条目、且没有 warning
```

如果 `dump-config` 打印 `patch: entry … not found`，说明写成了覆盖式而不是 `insert:`，见上面的写法。

## 2. 工具清单

| 工具 | 作用 |
| --- | --- |
| `feishu_status` | 凭证 / 登录 / 令牌剩余时间 |
| `feishu_scan` | 扫最近 N 小时消息，返回 digest 正文 + 路径 |
| `feishu_tasks` | 列任务（`status: open` 或 `all`） |
| `feishu_task_done` / `feishu_task_open` | 标记完成 / 改回未完成 |
| `feishu_task_add` | 手工加一条（`anchorId` 用于去重） |
| `feishu_p2p_discover` | 反推真人私聊会话 |
| `desktop_widget` | start / stop / restart 桌面便签（仅 Windows） |

## 3. 典型对话

```
帮我看看最近 24 小时的飞书消息，有什么明确派给我的活
→ 模型调 feishu_scan → 读 digest → 归纳 → feishu_task_add 落库

把「确认 SPU 编号拆分方案」标成完成
→ feishu_tasks 找 id → feishu_task_done
```

## 4. 和任务板卡片的关系

DSH 的 task board 是 DSH 自己的能力，本插件不写它。想要每条提醒都有张卡：
在 DSH 里对 `feishu_tasks` 返回的 id 建卡，再用 `node src/apply.mjs --board <taskId>:<cardId>` 登记回清单。

## 5. 没网 / 不想装依赖时的离线捷径

MCP 只依赖 @modelcontextprotocol/sdk。如果你机器上别处已经有这个包，
可以不跑 `npm install`，直接把依赖软链进来（Windows，管理员或开发者模式下）：

```powershell
New-Item -ItemType Junction -Path node_modules -Target <已有依赖的目录>\node_modules
node mcp/server.mjs   # 能正常启动就是对上了（Ctrl+C 退出）
```
