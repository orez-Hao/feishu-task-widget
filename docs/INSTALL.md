# 安装与飞书应用配置

## 1. 前置

- Node.js ≥ 18（`node -v` 能看到版本）
- 一个飞书**自建应用**：<https://open.feishu.cn/app>

## 2. 飞书开发者后台要做的四件事

> **每个人都要建自己的应用**：仓库不含任何人的凭证。用别人的 App ID 既读不到你的消息，也不该这么用。


1. **添加应用能力 → 网页应用**。
   只有机器人能力时，带 scope 的授权页会报 `20029 重定向 URL 有误`（文案极具误导性，实际是缺网页应用能力）。
2. **安全设置 → 重定向 URL** 填 `http://localhost:3000/callback`（与 .env 里的 FEISHU_REDIRECT_URI 一致）。
3. **权限管理**开通这些，否则调用报 `99991679` 缺 scope：

   ```
   im:message:readonly
   im:chat:read
   im:chat.members:read
   im:message.group_msg:get_as_user
   im:message.p2p_msg:get_as_user
   contact:user.base:readonly
   search:message
   offline_access
   ```

4. **创建版本并发布**（自建应用要管理员审核通过才生效）。

## 3. 本机

```bash
git clone <这个仓库> feishu-task-widget
cd feishu-task-widget
npm install
cp .env.example .env      # 填 FEISHU_APP_ID / FEISHU_APP_SECRET
node src/index.mjs login  # 浏览器里用你自己的飞书账号授权
node src/index.mjs status # 应该看到「登录状态：有效」
```

令牌存在 `~/.feishu-task-widget/state/user-token.json`，两小时过期前自动用 refresh_token 续期。想换数据目录：设环境变量 `FEISHU_TASK_DATA`。

## 4. 第一次跑

```bash
node src/index.mjs p2p --days 60 --max-resolve 80   # 发现真人私聊（可选但建议）
node src/index.mjs scan --hours 24                  # → 数据目录/out/im/<时间戳>/digest.md
```

把 `digest.md` 交给模型，让它按 [README 的判定规则](../README.md#判定规则) 产出 `tasks.json`，然后：

```bash
node src/index.mjs apply --file tasks.json
node src/index.mjs tasks
```

## 5. 错误码对照

| 错误码 | 含义 | 怎么办 |
| --- | --- | --- |
| `99991679` | 用户令牌缺 scope | 回后台补权限，重新 login |
| `99991695` | 用旧版授权调 im/v1/messages | 本项目走 authen/v2，重新 login |
| `20029` | 带 scope 时报「重定向 URL 有误」 | 应用缺「网页应用」能力 |
| `99992402` | 参数校验失败 | 检查时间范围/分页参数 |

## 6. 分享给别人时，让对方做什么

这个项目**不含任何人的凭证**，每个人用自己的飞书应用读自己的消息。对方拿到仓库后按顺序做：

1. `git clone <仓库>` + `npm install`
2. 在飞书开放平台建**他自己的**自建应用，开「网页应用」能力，重定向 URL 填 `http://localhost:3000/callback`，权限按上面第 2 节那 8 项开通，发布版本
3. `cp .env.example .env`，填他自己的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET`
4. `node src/index.mjs login` —— 浏览器里用**他自己的飞书账号**授权（令牌按人身份走，读的是他可见的会话）
5. `node src/index.mjs p2p --days 60 --max-resolve 80`，再 `node src/scan.mjs --hours 24`
6. 想接进 DSH：按 [DSH-PLUGIN.md](DSH-PLUGIN.md) 在 `~/.dsh/profiles/web/cordis.patch.yml` 里加 `insert:` 块，重启宿主；注意**必须用 `insert:` 写法**，只写 `- id:` 是「覆盖已有条目」，会报 `patch: entry … not found`
7. Windows 想要桌面便签：双击 `desktop/start-widget.vbs`

数据默认落在各自的 `~/.feishu-task-widget`，互不干扰；同一台机器想放别处就设 `FEISHU_TASK_DATA` 或在仓库根写 `.data-dir`。
