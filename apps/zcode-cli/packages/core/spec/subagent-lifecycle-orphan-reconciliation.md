# 子代理生命周期孤儿对账（orphan reconciliation）

## 背景与问题

宿主进程非正常退出（崩溃 / 被强杀 / 重启）时，正在跑的子代理不会再有任何结算机会：runner 的
`catch` / `finalize*` 随进程消失，`SubagentStopped` 永不落盘，父会话的
`runtime/subagent_lifecycle` entry 就停在「只有 spawn」的形态。roster 读它只能报 `lost`
（"记录没有结尾"）——这是诚实语义，但这条 lost 会**永久悬挂**：没有真相，也没有任何机制去认领它。

2026-10-16 实证（sess_34776750）：23:05:50 派出的两个前台 Explore 被 23:12 的引擎进程异常退出
连根拔（`crash/archive` 有 23:12 生成的空 dump、host/引擎 pid 双换代、无 graceful 退出日志），
entry 停在 spawn；23:15 用户让 AI「让它们继续」，`ListAgents` 报两条 `lost`，AI 改用
`sess_subagent_*` 唤醒成功（23:23 / 23:26 跑完），但那次续跑发生在**新进程**里（复活桥为空），
父会话零通知、两条 entry 至今仍是 lost。用户因此问「为什么中断就 lost / 句柄为什么不能用」——
根因不是工具冲突，而是**这一格没铺收口**。

范围：只修 roster / `ListAgents` 面（模型视野 + 左栏目录共用同一份 roster 的会话）。UI 的子代理
列表（`session/subagents`）是**另一条投影**（父会话消息 / part + 事件），与本 entry 不同源，本次不动。

## 设计决策

- **D1 触发点是「会话被本进程接管」，不是「引擎启动全库扫描」。** 对账挂在 `resumeFromStore`
  （core 里从磁盘接管会话的唯一漏斗）。理由：① session owner 语义——接管即负责；② 按
  `(sessionID, type)` 索引查询是低基数读取，成本可忽略；③ 全库扫描既贵，又会把**同机其他实例
  正在跑**的会话误判成孤儿。
- **D2 孤儿判据（三条同时成立）**
  1. 该行经 `mapSubagentLifecycleStatus` 映射为 `lost`（= roster 会显示 lost）。这是**唯一判据来源**，
     不再在 core 里另写一份状态词表；顺带覆盖「status 词是终态但没有 endedAt」与
     「status 词是 running 却写了 endedAt」两类脏数据。
  2. 本进程 `runtimeTaskRegistry` 里没有该 agentId（活体豁免）。
  3. `entry.time.updated < PROCESS_TAKEOVER_FLOOR_MS`（本进程加载本模块的最早时刻）。早于它写入的记录
     不可能是本进程写的，这道判据把「本进程刚派发、注册表暂时查不到」的窗口也挡在外面。
- **D3 落定复用唯一构造路径。** 用 `buildSubagentLifecycleEntry` 构造一条 `SubagentStopped` 语义事件
  （不 append 到事件流），status = `interrupted`，`endedAt` = 对账时刻。语义必须写清：这是
  **检测/落定时刻（真实死亡时刻的上界）**，因为真实死亡时刻没有任何进程记录过。
- **D4 新增状态词 `interrupted`，只进 CLI 侧词表。** `SubagentTaskStatus`（contracts）与
  `AGENT_TASK_STATUSES`（ListAgents 的 zod 面）加词；roster 映射给出终态。根 workspace 的 UI 协议
  四态（`zcodeSessionEndedSubagentSchema`）**不动**——那是另一条投影的词表。
- **D5 状态映射提升为契约层单一实现。** `mapSubagentLifecycleStatus` 从 bootstrap 的 roster 实现里
  移到 `contracts/interfaces/subagent-roster.port.ts`，core（对账判据）与 bootstrap（roster 投影）
  共用，并删除原来的副本——这正是仓库反复付代价的「枚举副本静默失效」陷阱。
- **D6 不动事件流。** 不发真的 `SubagentStopped` 事件：冷恢复阶段补发历史事件会污染 live 投影，
  且事件的 `turnId` 属于过去的轮次，落进当前事件流会把顺序语义搅乱。对账只写 session entry。

## 行为

`resumeFromStore` 在 `recoverInterruptedCompactTimelines` 之后、`SessionResumed` 事件之前调用对账：

1. 读本会话的 `runtime/subagent_lifecycle` 行；
2. 逐行判孤儿（D2 三条）；
3. 命中则用 D3 写回同一 id 的行（`subagent-lifecycle:<agentId>`），`created` / `startedAt` /
   `agentType` / `description` / `background` 由 builder 从旧行继承；
4. 本次对账条数 > 0 时记一条 `info` 日志（`event: subagent_lifecycle.orphans_reconciled`，含
   `count` / `sessionId`）。

## 所有权与不变式

- `runtime/subagent_lifecycle` 的写侧仍是 core（事件汇 + 本对账）；对账**不改**状态机、**不改**
  消息 / part、**不改**事件流，也不是子代理生命周期的第二个真相源。
- entry id 稳定；**幂等**：对账后该行映射不再是 `lost`，重复 resume 不会重写。
- 活体（注册表有该 agentId）永不被对账；本会话之外的 entry 永不被触碰。
- roster 端口的只读不变式保持：对账发生在 core 写侧，不越过 roster 端口。

## 失败语义

- 读 entries 抛错 → `warn`，返回 0，**不阻断** resume。
- 单行写失败 → `warn` 跳过该行，其余继续；下次 resume 自动重试（幂等）。
- 宿主没实现 `sessionEntries` / `saveSessionEntry` → 静默返回 0（能力缺席不是故障）。

## 迁移边界

- 历史孤儿行在**用户下次打开对应会话**时被认领为 `interrupted`；不追溯未被打开的会话（无人看，
  也就无人需要用）。
- 已结算行（有终态）不变；UI 历史卡片显示不变。
- 回滚：删掉 `resumeFromStore` 里的调用即回到现状；新增状态词可保留（无副作用）。

## 验收

- **A1** 冷恢复：无终态 + 注册表缺席 + 早于接管时刻的行 → 写成 `interrupted`，`endedAt` 落定。
- **A2** 活体豁免：注册表里有该 agentId 的行不被改写。
- **A3** 终态豁免：已有终态（completed / failed / cancelled / killed / interrupted）的行不被改写。
- **A4** 同进程豁免：`time.updated` 晚于接管时刻的行不被改写。
- **A5** 幂等：连续两次 resume，第二次对账 0 条，entry 内容不变。
- **A6** 失败降级：读 / 写抛错只 `warn`，`resumeFromStore` 正常返回。
- **A7** 投影：`interrupted` 经 `mapSubagentLifecycleStatus` 原样返回，`ListAgents` 输出
  `status="interrupted"`（不再是 `lost`）。

## 2026-10-25 增补：`interrupted` 必须进入 runtime task 终态词表

### 背景与问题

对账把孤儿行认领成 `interrupted`，但 core `runtime-task/registry.ts` 的 `TERMINAL_STATUSES`
没有这个词。所有「是否终态」的判定（`isTerminalRuntimeTask`）都把它当成 **runner 持有的
运行中任务**，连锁后果：

- SendMessage（`runner.ts` 的 `sendMessageToLocalAgent`）不走复活分支，把消息排进
  `pendingMessages`——重启后无人消费，永远送不到；
- 输入复活钩子（`reviveSubagentTaskForInputTurn`）不认领：被唤醒开轮后不重新登记 running、
  不结算、不发通知，复活轮变成无主之轮（2026-10-24 实测：三个被认领的 coder 续跑跑完了，
  父会话却收不到任何 task-notification，DB 里 lifecycle 行停在 04:05:17 的认领瞬间）。

### 设计决策

`TERMINAL_STATUSES` 补 `"interrupted"`，并让契约层注释的「与 lost 是同一情形的两个阶段」
成为词表的单一依据。修复后复活链路自动闭合：SendMessage → `resumeTerminalAgentInBackground`
（重新登记 running + `SubagentSpawned{resumed:true}`）→ 跑完 → `finalizeBackgroundCompletion`
（`SubagentStopped` + 结算通知）。

### 行为与验收

- 对 interrupted 任务 SendMessage → `delivery: "resumed_background"`，registry 重新登记
  running；复活后的任务仍正常结算。回归用例：
  `core/tests/background-task-control.test.ts` 的
  `resumes an interrupted runtime task in the background instead of queueing the message`
  （已做红绿验证：摘掉词表项后 delivery 落 queued）。
- 展示侧配套：目录查询消费 lifecycle 终态压掉上游「可恢复 running」fallback，见
  `bootstrap/spec/subagent-ended-time.md` D2（2026-10-25 修订）。
