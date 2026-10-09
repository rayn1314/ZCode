# 后台任务事件等待与共享 ticker

涉及包：仅 `apps/zcode-cli/packages/core`（`tool/handlers/task-output.ts`、
`tool/executor/background-tasks.ts`）。依赖复用 `runtime-task/registry.ts` 的
`waitForTerminal`，registry 本身未改。

## 背景与问题

子代理/后台任务的两条等待链路原本都是忙轮询：

1. **TaskOutput 阻塞等待**：`waitForTask` 用 `while + delay(100)` 每 100ms 回读一次
   registry，判超时/终态。一次缺省 30s（上限 600s）的阻塞等待最多打 300 次无意义读；
   registry 明明提供终态事件 `waitForTerminal` 却没被用上。
2. **后台任务 1Hz 快照轮询**：`BackgroundTaskTracker.trackBackgroundTask` 为每个后台
   任务各起一个 `setInterval(1000)`（unref），存进 `backgroundPollers` Set。N 个后台
   任务 = N 个定时器与 N 次每秒扫描，且每个 interval 独立跑一遍 poll 闭包。

## 设计决策

### TaskOutput：事件等待为主，5s 兜底 tick

- 主路径 `registry.waitForTerminal(taskId, { signal })`：终态 update / remove 即
  resolve。registry 侧已处理 TOCTOU——任务在「注册后、开始等之前」就已终态（或已不
  存在）时立即 resolve，不漏终态。
- 兜底 tick `TASK_OUTPUT_FALLBACK_TICK_MS = 5_000`：`Promise.race` 叠在每段事件等待
  上，覆盖事件缺口（外部 registry 实现不 resolve、状态词超出终态集）。tick 只回读
  复查，不承担主逻辑，因此可以比旧的 100ms 放宽 50 倍。
- 每段等待用独立 `AbortController`（segment）：tick 赢或外层 abort 时在 `finally`
  里 `segment.abort()` 撤下已注册的 waiter，避免 `terminalWaiters` 残留条目一直挂到
  任务终态。外层 `context.abortSignal` 通过 listener 转发进 segment。
- **超时/abort 裁决顺序与旧轮询逐拍一致**（每次回到循环入口）：先判超时（超时不查
  abort，直接回当前快照）→ 再判 abort（抛与旧实现同形的 AbortError）→ 再读快照判
  终态。`timeout <= 0` 短路直接回当前快照，保持旧返回形状。

### 后台任务：单共享 ticker

- `snapshotPollers: Map<taskId, poll>` 取代 per-task interval；全 tracker **单个**
  `setInterval(1000)` 扫描该集合，每拍对活跃任务各触发一次 poll（poll 自带
  `polling` 防重入，慢任务不会堆叠）。
- ticker 在集合非空时才存在：`releaseSnapshotPoller` 在最后一个任务离开时
  `clearInterval` 并置 `undefined`，活跃集合为空时不常驻。
- ticker 与旧 per-task interval 一致 `unref()`，不让后台轮询阻止进程退出。
- `backgroundPollers` Set 保留原语义（防重入 + 生命周期标记），终态/丢失时仍删除；
  与 `snapshotPollers` 的差集是「有直接终态 waiter、无快照源」的任务，它们不进轮询。

## 行为

- TaskOutput 的 `retrieval_status` 取值与返回形状不变：`not_ready` / `success` /
  `timeout`（含 `timeout` + 投影、`timeout` + null 两支）。缺省 30s、上限 600s 的
  超时语义不变。
- 后台任务的快照轮询节奏不变（1s），只是从 N 个定时器合并成 1 个；终态/丢失时仍
  调 `stopTracking()` 清理（含从 ticker 活跃集合摘除）。

## 所有权与不变式

- 等待终态的**唯一事件源**是 `RuntimeTaskRegistry`（`waitForTerminal`）；TaskOutput
  只消费事件 + 兜底回读，不再自行节拍轮询。
- 共享 ticker 的所有者是 `BackgroundTaskTracker` 实例：一个实例最多一个 ticker，
  生命周期覆盖「`snapshotPollers` 非空」区间。
- 不变式：
  - 不存在 per-task 的 `setInterval`；`background-tasks.ts` 中除 maxRuntime 的一次性
    `setTimeout` 外无其它周期定时器。
  - 等待不漏终态：终态 update / remove / 注册后立刻终态，`waitForTask` 都能收口。
  - 空集停表：所有后台任务终态后 ticker 已 `clearInterval`，不常驻。

## 失败语义

- `waitForTerminal` 的 reject 只来自 signal abort：外层 abort 时抛出与旧
  `throwIfAborted` 同形的 AbortError。
- 事件缺口由 5s 兜底 tick 回读补齐；tick 仍读不到终态则继续下一段，直到超时按旧语义
  返回当前快照。
- poll 抛异常沿用原路径 `logger.warn` 记录、不中断 ticker 对其它任务的扫描。

## 评估结论（本轮只评估不改）

- **runner.ts 其它周期定时器**：无。仅两处一次性 `setTimeout`（autoBackground 定时
  转后台、activity watchdog 重臂），不构成周期轮询。core 内其它 `setInterval` 属
  node-repl-session（REPL 作用域）与 turn.ts 的 run heartbeat（turn 生命周期、
  clearInterval 收口），均非后台任务轮询，不在本任务范围。
- **`backgroundPollers` 异常路径泄漏**：snapshot provider 永不返回终态时，旧形态 =
  N 个 interval + N 个 Set 条目永不清理；共享 ticker 后该形态收敛为 **1 个 ticker
  （unref）+ Map 条目滞留**——per-task 定时器泄漏消失。ticker 只要在
  `snapshotPollers` 非空就该跑（任务未终态本就该轮询），这与旧语义一致；条目滞留是
  「任务永不终态」这一上游问题的如实反映，由既有 watchdog/会话回收护栏兜底，不在此处
  加超时兜底。

## 遗留

- `subagent/message-steering.ts` 的 20×10ms 自旋等 `no_active_turn`：窗口小（≤200ms）
  且语义敏感（steering 完成判定），本轮不改，另立任务评估。
