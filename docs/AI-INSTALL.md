# 交给 AI 代装时，直接把这段丢给它

```text
帮我把 https://github.com/orez-Hao/feishu-task-widget 装好，按这个顺序，每步做完把结果给我看：

1. git clone 到某个目录并 cd 进去，跑 npm install（Node 需要 ≥18，先 node -v 确认）
2. 如果没有 .env，从 .env.example 复制一份，然后停下来告诉我：
   要先去 https://open.feishu.cn/app 建自建应用，开「网页应用」能力，
   重定向 URL 填 http://localhost:3000/callback，
   开这 8 个权限：im:message:readonly、im:chat:read、im:chat.members:read、
   im:message.group_msg:get_as_user、im:message.p2p_msg:get_as_user、
   contact:user.base:readonly、search:message、offline_access，
   发布版本后把 App ID / Secret 填进 .env
3. 跑 node src/index.mjs login（会打开浏览器，用我自己的飞书账号授权）
4. 跑 node src/index.mjs status，确认「登录状态：有效」
5. 跑 node src/scan.mjs --self-test，确认 11 项自检全过（这条不联网，用来验证代码本身）
6. 跑 node src/index.mjs p2p --days 60 --max-resolve 80，再 node src/scan.mjs --hours 24
7. 接 DSH 插件：
   - 先 where.exe node 拿到 node 绝对路径
   - 在 ~/.dsh/profiles/web/cordis.patch.yml 里加一个 insert 块（见 docs/DSH-PLUGIN.md，
     **必须是 insert: 写法**；只写 - id: 会报 patch: entry … not found）
     failOnStartupError 先设 true
   - 跑 dsh --profile web --dump-config | Select-String feishu 确认没有 warning
   - 告诉我：需要完全重启 DSH 宿主（新开会话不算），重启后我再试 feishu_status
8. Windows 上如果我要桌面便签，告诉我双击 desktop/start-widget.vbs

注意：仓库里没有任何凭证，必须用我自己的飞书应用；不要把我 .env 的内容打印出来。
```

## 装完之后的验收清单

| 检查 | 期望 |
| --- | --- |
| `node src/scan.mjs --self-test` | 11 项全过（离线，验证代码） |
| `node src/index.mjs status` | 凭证已配置 + 登录有效 |
| `node src/scan.mjs --hours 24 --json` | 返回 outDir，`errors: []` |
| `node src/index.mjs tasks` | 能列出清单（初次可能为空） |
| `dsh --profile web --dump-config \| Select-String feishu` | 有条目、无 warning |
| 新会话里 `feishu_status` | 返回数据目录 + 令牌剩余时间 |

任何一步失败，先把该步的**原始报错**留下来——文档里对 99991679 / 99991695 / 20029 / EPERM / `patch: entry not found` 都有对应说明。
