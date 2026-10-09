# 后台子代理活动看门狗（Background subagent activity watchdog）

涉及包：`core`（本 spec 主责，`src/subagent/runner.ts`）。消费方 `bootstrap` 的 residency 判定（`hasResidencyBlockingWork`）不改——它读 registry 终态，本 spec 负责让挂死的 registry 一定离开 running；`contracts` 无 schema 变更（`inactivityTimeoutMs` 已存在）。

## 背景与问题

子代理活动看门狗（`createSubagentActivityWatchdog`：无活动达到 `inactivityTimeoutMs` 即 `abort(ToolTimeout)`）此前只装在前台 `run()` 上。三条后台执行路径都没有表：

1. **`start()`（默认派发路径，`launch` 不带 `wait` 即走它）**：`runBackgroundAgent` 调 `runAgentToCompletion` 时第 6 参 monitorOptions 传的是空对象，`reportActivity` 为 undefined；
2. **SendMessage 复活**（`resumeTerminalAgentInBackground`）：同样走 `runBackgroundAgent`，同样无表；
3. **前台转后台**（`autoBackgroundMs` 到点或 TaskOutput/`requestBackground` 放行）：执行体继续跑，但 `run()` 帧的 `finally` 把表停了，从转换那一刻起再没人兜底。

后果链：后台子代理卡在工具/MCP/文件 IO 时模型流不再产出事件，只剩模型流自身的 600s idle 兜底；一旦模型流根本不在进行中（例如阻塞在工具段），兜底也不触发 → registry 条目恒 `running` → `hasRunningBackgroundRuntimeTask`/`hasResidencyBlockingWork` 判定父会话仍有阻塞工作 → 父会话被永久 pin 在驻留池，永不回收。

还有一个同源缺口：`runBackgroundAgent` 不用 `guardSubagentPromiseWithAbort` 包执行体。前台早已记录「子运行时或模型适配器在 abort 后可能永不 settle」——不包 guard，即使有表、即使 abort 发出去，`finalizeBackgroundFailure` 也可能永不执行，registry 照样卡 running。看门狗与 guard 必须成对。

## 设计决策

- **同一张表，一处装配**：前台 `run()` 与后台 `runBackgroundAgent` 都经 `createTaskActivityWatchdog` 装配同一个 `createSubagentActivityWatchdog`，共用 `options.inactivityTimeoutMs` 注入点与缺省 `DEFAULT_MODEL_STREAM_IDLE_TIMEOUT_MS`（600_000ms，与模型流 idle 同源常量）。`inactivityTimeoutMs` 非有限数或 ≤ 0 仍是「禁用看门狗」的显式开关。
- **看门狗创建在执行体帧内**：后台表在 `runBackgroundAgent` 函数体里创建/武装/停表，`start()` 与 SendMessage 复活两个入口自动继承，后续新增后台入口也不会漏装。
- **转后台不停旧表，owner 跟着执行体走**：转换分支置 `handedOffToBackground`，前台帧 `finally` 不停表；表改由后台 continuation 在 settle 时 `stop()`。选「不停旧的」而不是「换新表」，因为 `reportActivity` 是执行体启动时捕获的函数引用，换实例接不上线；而旧表从「上次活动 + timeout」继续计时，语义无缝。
- **后台执行体包 `guardSubagentPromiseWithAbort`**（与前台同构）：abort 必须能确定性地让执行体 settle，`finalizeBackgroundFailure` 才必然执行。guard 的 `then/catch` 挂在原始 promise 上，原始 promise 迟到的 settle/拒绝不会变成 unhandled rejection。
- **只加 inactivity，不加绝对最长时长**：轮数已有上限（子会话 `maxTurns` 缺省 4），模型流另有 600s idle 兜底，活动看门狗补上「工具/MCP/IO 段」这个兜底够不到的面；wall-clock 上限会误杀合法长任务（长编译、大批量文件处理），且与「一直有产出就不该被判死」的活动语义直接冲突。

## 行为

- **武装**：后台在 `runAgentToCompletion` 之前 `watchdog.start()`（即首次 `reportActivity`），覆盖 child 持久化/恢复这段可能挂死的 setup；前台位置不变。
- **活动源**：`runExploreAgent` 入口一次 + 子会话事件订阅（`runtime/methods/subagent.ts` 的 `eventSink.onSessionEvent`，每条 child 事件一次）→ `request.reportActivity?.()`，每条事件把计时重置为 `now + timeoutMs`。
- **超时**：构造 `CoreError(ToolTimeout, "Subagent was inactive for <ms>ms")`，context 带 `code: CHILD_RUNTIME_FAILED / agentId / agentType / idleMs / parentToolCallId / timeoutMs`，`recoverable: true`、`retryable: true`；同时 warn 日志 `subagent.activity_timeout`；随后 `taskAbort.abort(error)`。
- **超时后的终态**（按 session 是否 ready 分支）：
  - 后台且已 ready → guard 以 ToolTimeout 原因拒绝 → `finalizeBackgroundFailure`：registry 落 `failed`（终态）、写 output/metadata（错误正文）、发 `BackgroundTaskCompleted(status: "failed")` 与 `SubagentStopped(background, failed)`、入队 task-notification（status failed）、warn `subagent.background.failed`；
  - 后台但 setup 未 ready → `onSessionStartFailed` → readyGate 拒绝 → `start()` 抛出并 `registry.remove`、SendMessage 复活还原旧 terminal snapshot——不留下 fake running 条目；
  - 前台未转后台 → ToolTimeout 原样抛给父 Agent 工具（既有行为）；
  - 前台转后台之后 → 与后台失败路径一致（由 continuation 的 `finalizeBackgroundFailure` 落地）。
- **活动续命**：持续有事件到达时表不断后移，不会误杀（见测试「活动事件重置计时」）。
- **settle 必停表**：completed / failed / stopped / setup 失败 / 转后台 continuation 结算，全部 `stop()`；`stop()` 是终局语义（闩锁），结算后迟到的活动事件不再重新武装计时器。

## 所有权与不变式

- **在跑就有表**：任意时刻只要某子代理执行体仍在跑（前台帧、转后台 continuation、`runBackgroundAgent` 帧三者之一），就存在一张属于它的、未被 stop 的看门狗；执行体 owner 转移时看门狗 owner 同步转移。
- **settle 必停表**：执行体结算后计时器一定被清掉，且不可被晚到事件复活。
- **看门狗不拥有终态**：它只负责 abort；registry 终态的唯一写入者仍是 `finalizeBackgroundCompletion/Failure`（与既有 `stopTask` 先写 killed 再 abort 的边界一致）。
- **活动单向**：子会话事件 → 看门狗 `reportActivity`，看门狗不向子会话回传任何事件。
- **registry 不再存在「静默挂死」形态**：abort + guard 让「超时 → 终态」有界，`hasResidencyBlockingWork` 读到的 running 一定对应一个仍在被看护的执行体。

## 失败语义

- 超时错误 `retryable: true`：前台由父模型看到 ToolTimeout 原文；后台以 task-notification（status failed）呈现，正文是 `selectExecutionErrorMessage` 选出的根因消息。
- 迟到的正常完成与超时竞争：`finalizeBackground*` 均先查 `isTerminalRuntimeTask` 早退，先落的终态胜出，不重复发通知。
- `stopTask` 与超时竞争：`stopTask` 先写 `killed`（终态），随后的 `finalizeBackgroundFailure` 早退，通知仍只有 stop 那一条。
- 显式禁用（`inactivityTimeoutMs <= 0`）时维持旧风险面，由模型流 idle 兜底——这是配置的显式取舍，不是默认路径。
- guard 先于原始执行体 settle 时，原始 promise 迟到的 settle 由 guard 内部已挂的 handler 吸收，不产生 unhandled rejection。

## 迁移边界与遗留

- 历史会话无迁移；行为随代码即时生效。测试：`packages/core/test/subagent-background-watchdog.test.ts`（后台超时、转后台后仍活着、活动续命 + 表清理）。

遗留（有意不做）：

1. **不做绝对最长时长上限**——理由见设计决策最后一条；若将来出现「事件泵持续心跳但实际工作卡死」的形态（活动看门狗会被喂活），需要 wall-clock 上限才能覆盖，届时另立任务。
2. **前台「注册任务 → 写运行元数据 → 武装看门狗」之间的本地 fs 写不在表内**——有界写入，且与前台现状一致；后台的元数据写同样在武装之前。
3. **其它 runtime 任务类型**（`local_bash`、workflow run 等）的看护不归本 spec，registry 侧 residency 判定也保持不变。
