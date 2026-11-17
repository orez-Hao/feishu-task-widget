# 定时扫描流水线（可直接当 agent 的 runbook）

把最近 24 小时的飞书消息提炼成任务提醒。适合挂成每日/每半天的定时任务，交给 agent 执行。

## 步骤

0. **更新私聊列表**（机器人会话会被自动剔除）

   ```bash
   node src/index.mjs p2p --days 60 --max-resolve 80
   ```

1. **扫描**，拿到 outDir

   ```bash
   node src/scan.mjs --hours 24 --json
   ```

2. **读 digest 提炼任务**：读 `<outDir>/digest.md`，按 [README 的判定规则](../README.md#判定规则) 产出 `tasks.json`。
   - 只提「明确派给我 + 有交付物或时限」的；
   - `anchorId` 必须是 digest.json 里真实存在的消息 id（`om_…`），拿不到锚点就别输出那条；
   - 没有新任务就直说「最近 24 小时无新任务」，不要硬凑。

3. **落库**

   ```bash
   node src/index.mjs apply --file tasks.json
   ```

4. **（可选，DSH 专用）建任务板卡片**：对输出里「需要建任务板卡片：…」的每个 id 建一张卡（标签「飞书」），再登记：

   ```bash
   node src/apply.mjs --board <taskId>:<cardId>
   ```

5. 完成。未完成清单可以随时看：

   ```bash
   node src/index.mjs tasks
   ```

## 异常处理

| 现象 | 处理 |
| --- | --- |
| `99991679` / `99991695` / 令牌过期 | 让用户重新授权：`node src/index.mjs login`，不要反复重试 |
| 私聊列表为空 | 先跑步骤 0；仍为空就加大 `--days` |
| 重复任务 | 靠 `anchorId` 去重，同一个锚点只会有一条 |

## 幂等性

`apply` 按锚点去重：同一条消息重复扫描只会累加 `occurrences`，不会新建任务。所以定时任务可以放心一天跑多次。
