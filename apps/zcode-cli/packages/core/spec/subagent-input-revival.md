# 子代理输入复活归一（input revival）

涉及包：`core`（本 spec 主责，runner / turn 挂钩均在 core）。无协议、bootstrap、UI 改动。

## 背景与问题

子代理的「结果回传父会话」此前唯一自动通道是 runner 的执行体结算
（`finalizeBackgroundCompletion` / `finalizeBackgroundFailure` / `finalizeBackgroundStopped`
→ `<task-notification>` 注入父队列 → 父模型拿到结论、UI 卡片按通知翻转）。这条通道绑定在
**SubagentPort 派发的执行体**上，而子会话升级为一等会话后有了第二个驱动源：用户经 v4
`sendText`（子代理面板直发）直接在子会话开轮。这条路径不经过 SubagentPort：

- 任务在注册表里已因中断定格为终态（`notified: true`），复活轮开跑时无人重新注册；
- 复活轮跑完时无人结算 → 父会话收不到第二次通知，父的时间线卡片永久停在「执行失败」
  那一刻；`TaskOutput` / `ListAgents` 读到的也都是中断时刻的旧快照。

根因是所有权错位：「子会话被重新驱动后产生的新终局」没有 owner。本 spec 把这个 owner
钉回 runner。

## 设计决策

- **D1 任务生命周期唯一所有者仍是 runner。** 任何能把 subagent_child 子会话重新跑起来的
  输入轮，开轮时回归任务生命周期（重新注册 running），终局时走 runner 既有 `finalize*`
  结算——通知、父卡片翻转、事件、hook 全部复用，不另起第二条上报路径。
- **D2 进程内复活桥（`input-revival-bridge.ts`）。** 父子在同进程但分属两个 runtime，
  桥按 `childSessionId` 登记 `{registry, options, 最近一次执行请求}`；子 runtime 的
  `executeTurnCommand` 经桥找到父侧结算能力。桥是纯内存 Map，**不落库、不跨进程**——
  这是登记表（唯一登记点：runner 构造任务快照的三处），不是第二份任务状态；任务状态
  的权威仍在 `runtimeTaskRegistry`。
- **D3 所有权标记 `inputRevival`。** 复活注册的快照带 `inputRevival: true`；轮末结算
  只认这个标记。派发轮 / SendMessage 复活轮由 runner 执行体持有，标记永远缺席，其轮末
  钩子 no-op——用标记区分「谁持有这轮」，不靠状态词猜测，杜绝双结算。
- **D4 复活轮跑子会话自己的模型。** 不重新解析 profile 选型：用户在面板手动切换的模型
  正是复活场景的核心诉求，执行权威是会话当前配置（与直发 sendText 语义一致）。
- **D5 结算完全复用 `finalizeBackgroundCompletion` / `finalizeBackgroundFailure`。**
  含产物写盘（output.txt/metadata）、`SubagentStopped` 事件、SubagentStop hook、
  `notified` 幂等闸、父通知入队。复活开轮时补发 `SubagentSpawned(resumed: true)` 与
  SubagentStart hook，与 SendMessage 复活路径同形（roster / 冷事件合并按 resumed 对识别）。
- **D6 无绑定即降级为现状。** 桥缺席（进程重启、父 runtime 未派发过该子会话、注册表
  终态被驱逐）时复活与结算都 no-op——不伪造状态、不报错；该缺口属跨进程持久化范畴
  （另行立项），本 spec 不覆盖。
- **D7 复活注册同步补发 `BackgroundTaskStarted(running)`。** 投影
  （`projection.backgroundTasks`）只由 `BackgroundTask*` 事件驱动，`SubagentSpawned`
  不进投影；不补发则投影永久停在旧生命终态——TaskStop 以「not running (status:
  running)」自相矛盾拒绝、面板显示已结束而注册表明明在跑。停止判定本身已改为注册表
  单源权威（spec `background-stop-registry-authority.md`），本条修的是投影显示层与
  后台控制项的追齐。SendMessage 续跑路径（runner 内同形）一并补发，两个入口共用
  `emitBackgroundTaskRunningEvent`。
- **D8 复活开轮即向父代理补一条 `status: running` 的通知。** 父代理只持有上一命的
  终态快照，用户面板发起的复活对它不可见——不补这条「又活了」，它会照旧重开一个
  重复子代理（spec `background-notification-supersession.md` D5）。该通知不复用
  终态格式化器、不 claim `notified`（否则堵死终态通知）；SendMessage 续跑的工具回执
  已自带同义句，D8 只覆盖 input revival。

## 行为

复活（`reviveSubagentTaskForInputTurn`，挂在 `executeTurnCommand` 入口，仅
`taskType === "subagent_child"`）：

1. 查桥 → 查注册表任务；任务不存在、非终态、或非 `local_agent` → no-op。
   非终态说明本轮由 runner 持有（派发/复活中），归 runner 结算。
2. 重建快照：`status: running`、`notified: false`、`inputRevival: true`、
   `isBackgrounded: true`（无前台等待者）、`startedAt/turnId/traceContext` 取本轮，
   清 `completedAt/error/usage`，保留 `parentToolCallId`（父卡片锚点）、`parentSessionId`、
   `outputFile`、`prompt`、`pendingMessages`。附 messageSink（steer 注入）并 flush 积压消息，
   与 runner 的 sink 注册同一条实现。
3. 安装 `stopTurn` 句柄到桥（供 `port.stopTask` 停掉真实执行的轮），随后补发
   `BackgroundTaskStarted(running)`（D7，投影追齐新生命）、向父代理入队
   `status: running` 复活通知（D8）、`SubagentSpawned(resumed: true)`
   事件与 SubagentStart hook。

结算（`settleSubagentInputRevivalTurn`，挂在 `executeTurnCommand` 返回/抛错之后）：

- 任务无 `inputRevival` 标记或已是终态（`stopTask` 抢先结算）→ no-op。
- 轮成功 → 按 `finalizeBackgroundCompletion` 结算：output.txt/metadata、
  `SubagentStopped(completed)`、父 `<task-notification status="completed" result=正文>`。
- 轮抛错/被中止 → 按 `finalizeBackgroundFailure` 结算：`status: failed` + 错误原文入通知。
- 结算自身异常只 warn，不改变原轮的结果或错误；`binding.stopTurn` 在结算时清除。

`port.stopTask` 打到 `inputRevival` 任务：既有 `finalizeBackgroundStopped`（终态+stopped
通知）之后追加调桥的 `stopTurn` 停掉真实执行的轮；随后的轮末结算撞终态守卫自动 no-op。

父侧既有手段在本机制下的表现：`TaskOutput(block:true)` 在复活轮期间看到 running 并等到
新终态；`ListAgents` live 行随注册表实时；`SendMessage(agent_*)` 对复活轮 =
`deliverMessageToRunningAgent`（sink steer 进行中轮）。

## 所有权与不变式

- 任务状态唯一 owner：父 runtime 的 `runtimeTaskRegistry`；桥不存状态、只存引用。
- 结算唯一入口：runner 的 `finalize*`（派发轮由执行体调用，输入轮经本 spec 的结算钩调用），
  两者的互斥由 `inputRevival` 标记 + 终态守卫 + `notified` 幂等闸三重保证。
- `SubagentSpawned`/`SubagentStopped` 仍只从 runner 侧发射，事件汇归属不变。
- 通知锚点：复活结算沿用**最近一次构造请求**的 `parentToolCallId`（原始 Agent 调用或
  最近一次 SendMessage 调用），与 SendMessage 复活路径的卡片翻转语义一致。

## 失败语义

- 复活失败（桥/注册表异常）→ warn + 本轮照常执行（退化为现状：无通知），不阻断用户输入。
- 结算失败 → warn，原轮结果/错误原样透出；任务可能滞留 running，下一轮复活/结算或
  `stopTask` 可收敛（终态守卫防重复）。
- 复活轮期间父 runtime 关闭 → 通知入队被既有 `shuttingDown` 守卫丢弃（留日志），不崩溃。
- 复活轮被中止（面板停止 / 父停止级联）→ 走失败结算并向父发 failed 通知，与后台任务
  被中止的既有语义一致。

## 迁移边界

- 不覆盖：进程重启后的复活（桥与注册表均为内存态）、注册表终态驱逐后的复活、
  跨机器父子。这三类维持 D6 降级（现状），如需根治另行立项（持久化父子关联 + 通知补投）。
- 不改：sendText 三档投递、guide 注入、准入与队列语义；本机制只在轮的开/收两个点搭挂。
- 不改：派发轮与 SendMessage 复活轮的既有路径（标记缺席，钩子不触碰）。

## 验收场景

- A1 主代理派发子代理 → 用户中断（父卡片「执行失败」）→ 用户面板直发续跑 → 子跑完：
  父收到 `status: completed` 通知且带最终正文，父卡片翻转为完成；注册表任务为 completed、
  `notified: true`。
- A2 复活轮期间父调 `TaskOutput(task_id, block:true)` → 等到复活轮终态并返回新结果。
- A3 复活轮再次被中断 → 父收到 failed 通知（错误原文），不出现第二次重复通知。
- A4 派发轮（前台/后台）与 SendMessage 复活轮全程：输入轮钩子零副作用（无 `inputRevival`
  标记 → 不注册、不结算），既有通知数不变。
- A5 桥缺席（新进程直接 sendText 子会话）：轮照常执行，无通知、无报错（现状行为）。
- A6 复活轮运行中父调 `stopTask` → 真实轮被停止，父收到 stopped 通知，轮末结算 no-op
  （终态守卫），无双通知。
- A7 复活轮运行中父调 TaskStop（strict）→ 放行并停掉真实轮（不再报
  「not running (status: running)」）；投影在复活时收到 `BackgroundTaskStarted(running)`，
  后台控制项/面板显示 running 而非旧生命终态。
- A8 用户面板直发复活开轮的**同一刻**，父代理即收到 `status: running` 通知
  （「was resumed and is running again… do not dispatch a duplicate」），且该通知
  不消耗 `notified` 声明；复活轮终局时父仍收到 exactly 一条终态通知。
