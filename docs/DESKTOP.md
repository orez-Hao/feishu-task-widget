# Windows 桌面便签

无边框 WPF 悬浮窗 + DWM Acrylic 真毛玻璃。它只是提醒清单的一个视图，读写都走同一套逻辑（`src/lib/reminders.mjs`）。

## 启动器

| 文件 | 用途 |
| --- | --- |
| `desktop/start-widget.vbs` | 主入口，双击即起，无控制台 |
| `desktop/restart-widget.cmd` | 改完代码或看不到窗口：按窗口标题反查进程结束旧实例再起新的 |
| `desktop/diagnose-widget.cmd` | 起不来时：同步运行，报错直接显示，最后停住等回车 |
| `desktop/start-widget-compat.cmd` | 窗口发黑或整块透明时：`-NoGlass` 关掉 DWM 磨砂 |

## 窗内

- **布局**：日期 → 迷你月历 → 任务列表 → 脚注。圆点=当天扫描到的任务（红=高优先、空心环=已完成、`N 到期`=当天有截止）。
- **点圆圈**：置完成并刷新表头计数与月历；再点改回。
- **收起**：点日期或右上角箭头，窗口缩到只剩月历；再点展开。
- **改大小**：右下角 `⤡` 拖动，最小 340×260。
- **透明度**：底部滑条 0%–100%，同时控制自有玻璃底、DWM 磨砂白雾、外圈阴影；文字保底 15%，鼠标移上去临时回满。拉到 0% 磨砂会被整个关掉，是真的透到桌面。
- **右键菜单**：置顶显示 / 磨砂玻璃（DWM） / 立即刷新 / 重置窗口位置 / 开机自启 / 打开数据目录 / 退出。

## 数据与诊断

- 偏好（位置/尺寸/透明度/收起/置顶）：`<数据目录>/state/widget-pos.json`
- 日志：`<数据目录>/state/widget.log`
- 数据目录默认 `%USERPROFILE%\\.feishu-task-widget`，可用 `FEISHU_TASK_DATA` 覆盖。

## 没有桌面也能自检

```powershell
powershell -File desktop/desk-widget.ps1 -RenderTo out.png              # 渲染界面成图
powershell -File desktop/desk-widget.ps1 -RenderTo out.png -SelfTest    # 顺便点一次圆圈验证落盘
powershell -File desktop/desk-widget.ps1 -RenderTo out.png -StartCollapsed -StartOpacity 40
```

## 已知坑（都已修）

- 窗口位置曾用物理像素填 WPF 的 DIP，175% 缩放下会被摆到屏幕外；现在用 `SystemParameters.WorkArea`（DIP）并每次启动夹回可见区。
- 异常一律弹窗 + 写日志，不再静默退出；单实例被占用时会把已有窗口拉到最前。
- 按进程名批杀会误伤调用方，所以 `stop-widget.ps1` 改为按窗口标题反查 PID。
