# 子代理驻留座位闸门与注册表有界保留（Subagent seat gate & registry bounds）

涉及包：`core`（本 spec 主责：`src/subagent/seat-gate.ts`、`src/subagent/runner.ts`、`src/runtime-task/registry.ts`、`src/tool/handlers/send-message.ts` 相关链路）。配置通道涉及 `contracts`（`subagents.maxConcurrent` 键与 SendMessage 失败码）、`adapters`（env / 文件 schema / ConfigStore）、`bootstrap`（`runtime-config.ts` 接线）。设置页 UI 见「遗留」第 1 条——本轮**不加** UI 输入项。

## 背景与问题

### D：子代理派发没有任何并发上界

`Agent` 工具（`tool/handlers/agent.ts`）经 `subagentPort.launch/start/run` 派发子代理，此前全链路**无任何并发/总量限制**（已全仓 grep 确认）：一个父模型 fan-out 几十个子代理时，每个都占一份 child runtime、模型流与工具槽，资源面直接被打穿。业界 Codex / Claude Code 均有会话内子代理上限，本仓缺这道闸。

工作流侧已有一道独立的 run 级座位闸门（`bootstrap/src/app/workflow-seat-gate.ts`）：它绑 workflow ask 生命周期、把上界压到「下一次模型请求」上，且依赖 driver 的 ask 观察面。它**不能复用**——派发发生在 core 的 `subagent/runner.ts`，core 不能 import bootstrap；且语义维度不同（它管请求步进，本闸门管驻留数）。

### E：runtime task 注册表与消息队列无界增长

- `runtime-task/registry.ts` 的 Map **只增不删**：终态只 `update`，`remove` 仅 4 处启动前早期失败点。一个长会话派出的每个子代理/任务都永久留一条，内存单调膨胀。
- `pendingMessages` 无界 `append`：目标子代理长期不消费时，SendMessage 的 queued 分支无限堆积消息，没有背压、没有失败信号。

## 设计决策

### D-1：进程级 FIFO 座位闸门，放在 core

- **形态**：`getSubagentSeatGate()` 模块级懒加载单例（对齐 bootstrap 的 `getWorkflowConcurrencyGovernor()` 形态，但落在 core 内）。一个 CLI 进程所有会话共享同一份驻留预算——资源是进程级的，账记在进程级。
- **接口**：`acquire({ signal, capacity })` 返回 `SubagentSeatLease`，`lease.release()` 归还；`stats()` 观察面。不提供 `setLimit`——容量不是闸门的自有状态，而是**每次 acquire 时由调用方传入的配置读数**（迟绑定，见 D-4）。
- **三条纪律对齐工作流闸门**：
  1. **纯的**：不读时钟、不做 I/O、不起定时器。唯一外部输入是 `signal` 与 `capacity`。
  2. **上界 ≥ 1 ⇒ 永不死锁**：容量 clamp 到整数 ≥ 1；占座者（在跑子代理）的完成不依赖任何新座位——子代理结构性地不能再派子代理（child runtime `subagents.enabled:false`，`runtime/methods/subagent.ts`），不存在等座环。
  3. **结算必释放**：runner 所有终态转换点归还 lease，且 lease 是终局闩锁。
- **FIFO + abort 出队**：满员时按到达序排队（到达 = acquire 调用，发生在 start() 元数据落盘之后；并发派发的到达序不保证等于调用序，FIFO 只承诺队列内先来先走）；`signal` abort 即出队并以 `signal.reason` 拒绝，**不占座**（计数不漂移）。
- **lease 终局闩锁**：`release()` 内部 `released` 标志，重复调用不把 `held` 减成负数——负数等于凭空多放座位，是超额并发的直接来源。

### D-2：接线点——在创建子会话之前等座，统一在 settle 收口释放

- **前台 `run()`**：`taskAbort` 创建之后、看门狗武装**之前**等座。理由：等座是合法等待（有人在跑才有座可等），不该吃 inactivity 计时被看门狗误杀；取消能力由 `taskAbort` 提供（父 signal / TaskStop）。等座失败走与元数据写失败同形的清理：`taskAbort.dispose` + `registry.remove` + 抛出——没有 child runtime 在跑，不留 fake running。
- **后台 `runBackgroundAgent()`**（覆盖 `start()` 默认派发与 SendMessage 复活两个入口）：终态早退检查之后、看门狗武装之前等座。等座被拒（abort）时 `acquire` 不占座，经既有 `sessionStartFailed` 分支交回 `start()`/复活入口的失败路径（readyGate reject → start() 抛出 + registry.remove；复活则还原旧 terminal snapshot 后抛出）。
- **`start()` 契约不变**：它本来就等子会话 ready 才返回句柄；等座发生在 ready 之前，只是让「返回句柄」更晚一点，没有新增任何早返回语义。
- **释放点统一收口**（每个路径恰好一个归还点，lease 闩锁兜住重入）：
  - 前台正常完成 / 失败 / 取消 → `run()` 的 `finally`（`!handedOffToBackground` 分支）；
  - 前台转后台 → 座位随执行体交给后台 continuation，由其 `.finally` 归还（前台 `finally` 因 `handedOffToBackground` 跳过——与看门狗 owner 转移同一取舍）;
  - 前台 readyGate 失败（setup 失败）→ 该 catch 内归还；
  - 后台 completed / failed / 看门狗超时 / TaskStop / 复活失败 → `runBackgroundAgent()` 的 `finally`。

### D-3：不加 queued 状态（取舍）

等座期间 registry 条目保持 **`running` 现状**，不新增 `queued` 状态。理由：新状态会涟漪到 `list-agents` 投影、`task-output` 判定、`hasRunningBackgroundRuntimeTask`、驻留池 residency、通知与 UI 状态词汇表——而「等座」只是派发前的一段瞬态，模型面没有可观测需求（句柄本来就还没返回）。代价是 `list-agents` 会把等座中的任务列成 `running`，与「已创建子会话」不可区分；可接受，因为它确实是本进程正在推进的任务。

### D-4：容量迟绑定，调小不召回

- 配置键 `subagents.maxConcurrent`（contracts，**缺省 10**，范围 1–64），经 `bootstrap/src/app/runtime-config.ts` 接线进 `AgentRuntimeConfig.subagents.maxConcurrent`（会话级显式值 > 配置文件/env 合并值），再经 `createDefaultSubagentPort` 注入 runner 的 `maxConcurrentSubagents`。
- env 覆盖 `ZCODE_SUBAGENT_MAX_CONCURRENT`（adapters `env-config.adapter.ts`，Env 作用域优先级高于文件；非法/越界值**不写入**——静默降级到 1 会把并发面掐死，保持缺省更安全）。
- 闸门**每次 acquire 读当前配置值**：改配置后新派发即生效；**调小不召回**已在跑的（对齐工作流 `setLimit` 纪律）——只是此后放行更慢，直到持有者自然 settle。
- 多会话共享进程级闸门时，容量以最近一次派发读到的配置为准（同进程配置同源，这是进程级语义的自然推论）。

### E-1：终态有界保留 N=50

- `MAX_TERMINAL_RETAINED = 50`（常量+注释）：终态条目超过 50 时按 settle 时间（`completedAt`，缺省 `startedAt`）最旧先出。
- 只在「条目刚离开非终态」的 `update` 与「以终态 register」时做驱逐检查——任务活动期的高频 update（messageSink、消息入队）不触发全表扫描。
- **驱逐不破坏契约**：
  - `list-agents`：live 缺失本就由 roster 的 history 行补齐（并标注 `source: "history"` 只能按 childSessionId 寻址）；
  - `task-output` 对未知 id 返回 `TASK_NOT_FOUND`，`task-stop` 返回明确 not-found 错误——都不 crash；
  - `hasRunningBackgroundRuntimeTask` 只看非终态，不受影响；
  - 终态通知在 settle 时入队、随即被消费，50 条余量远超消费窗口；
  - running 条目**永不**被驱逐。

### E-2：pendingMessages 容量 100 + `agent_queue_full`

- `MAX_PENDING_MESSAGES = 100`（常量+注释）：`queueMessage` 超限**拒绝**，抛 `RuntimeTaskMessageQueueFullError`（patcher 内抛错不落 `tasks.set`，注册表状态原子保持）。
- 调用方（runner 的 `deliverMessageToRunningAgent` queued 分支，含 sink 投递失败回落）捕获后映射为 SendMessage 结构化失败：`status: "failed"` + `errorCode: "agent_queue_full"`（contracts `SendMessageErrorCode`，schema 同步加 `errorCode` 字段）+ 文案前缀 `agent_queue_full:` 说明**本条未入队**。不降级成假成功。
- `flushPendingMessages` 的 fire-and-forget 重排路径对队列满防御：丢弃剩余并 warn，绝不冒泡成 unhandled rejection。

### E-3：`registry.all()` 不改签名（记录在案）

终态有界后全量拷贝（`Object.fromEntries`）的成本可控（条目数 = running + ≤50 终态），**不改 `all()` 签名**，避免波及 `list-agents`、`rewind`、`background.ts` 等所有消费方。

## 行为

- **等座**：上界内 `acquire` 立即返回 lease；满员按 FIFO 排队，直到持有者 settle 归还或 `signal` abort。
- **前台等座被 abort**：`run()` 抛出 `signal.reason`（既有失败路径同形），registry 条目被 remove，不占座。
- **后台等座被 abort**（TaskStop 等）：`sessionStartFailed` → readyGate reject → `start()` 抛出 + `registry.remove`；复活路径还原旧 terminal snapshot 后抛给 SendMessage 调用方。
- **等座期间 watchdog 不武装**：拿到座位之后才 `watchdog.start()`；等座取消靠 `taskAbort`。
- **终态必释放**：completed / failed / stopped(killed) / 看门狗超时 / TaskStop / 复活失败 / setup 失败，全部归还座位；重复归还不多放。
- **终态驱逐**：第 51 个终态条目出现时，最旧的一条被 `remove`；`list-agents` 通过 history 仍可见它。
- **队列满**：第 101 条 SendMessage 排队请求返回 `failed` + `agent_queue_full`，前 100 条不受影响；drain 后恢复容量。

## 所有权与不变式

- **座位必释放**：任意占座的子代理执行体，其 settle 路径（前台帧 / 转后台 continuation / 后台帧三者之一）恰好归还一次座位。
- **重复 release 幂等**：lease 闩锁保证同一次占座只归还一次；`held` 永不为负。
- **等座不占座**：被 abort 的等待者从不出现在 `held` 计数里。
- **上界 ≥ 1**：容量读数经 clamp，配置非法值不落地。
- **终态条目有界**：每 runtime ≤ 50 条终态；running 永不驱逐。
- **队列有界**：单任务 pendingMessages ≤ 100，超限拒绝且状态原子。
- **闸门纯的**：不读时钟、不做 I/O；时序全由调用方的 settle 事件驱动。

## 失败语义

- **等座被 abort**：前台 = 抛 `signal.reason`（父 turn 取消原样透传）；后台 = 走既有 setup 失败路径（readyGate reject）。两者都不占座、不留 fake running。
- **队列满**：SendMessage 返回 `status:"failed"` + `errorCode:"agent_queue_full"`，文案明确「未入队、稍后重试」；模型据此可以等待或改用直接对话，不会以为消息已排队。
- **env 非法值**：不写入配置（缺省 10 生效），不 crash、不静默降级。
- **配置文件越界（<1 或 >64）**：schema 拒绝该文件配置，配置加载报诊断。

## 迁移边界与遗留

- 历史会话无迁移；行为随代码即时生效。测试：
  - `packages/core/test/subagent-seat-gate.test.ts`（FIFO、abort 出队、重复 release 幂等、容量迟绑定）；
  - `packages/core/test/subagent-seat-dispatch.test.ts`（第 11 个等座 + FIFO 起跑、等座 abort、看门狗超时/TaskStop/复活失败必释放、配置键生效）；
  - `packages/core/test/runtime-task-registry-bounds.test.ts`（终态驱逐 + list-agents history、队列满 + SendMessage 如实传出）；
  - `packages/adapters/test/subagent-max-concurrent-config.test.ts`（env / 文件 / merger / ConfigStore 通道端到端）。

遗留（有意不做）：

1. **设置页 UI 输入项本轮不加**——调查结论：settings 页到 CLI runtime 的既有管线有两条，都不适配本项：
   - `requestPolicy` 通路是 **provider 域专属**的（设置页 → provider 个人配置 JSON → registry → 每次模型请求读取），只承载 provider 级字段，没有通用「运行时配置项」入口；
   - 通用的 `sessionRequestRuntimePreferences` RPC 是**会话创建期静态快照**（runtime-materialization 时机取一次，`.strict()` 协议 schema），改设置只影响**之后新建的会话**，达不到「每请求/每派发即时生效」，且加字段要动 shared 协议 schema、Host 侧 resolver 与 UI 组件三处。
   因此本轮按 config 键 + `ZCODE_SUBAGENT_MAX_CONCURRENT` 落地（运行时读数已经迟绑定，配置文件/环境变量是 CLI 用户的标准通道）。若将来要进设置页，需要先给 `sessionRequestRuntimePreferences` 增加按需重取（或新的运行时设置通道），另立任务。
2. **与工作流座位闸门并存**：两道闸门维度不同——工作流闸门把 run 的并发压到模型请求步进上，模型请求层已共享 `workflow-concurrency-governor` 的 observer 治理器；本闸门只管**驻留数**（多少个子代理执行体同时活着）。两者不共享状态、互不调用，靠「子代理的每个模型请求都要过治理器」在运行时自然叠加。
3. **不提供 `setLimit` API**：容量由配置读数驱动，没有主动改容量的入口；如将来需要动态 retune（如 UI 实时调节），再扩闸门接口。
4. **驱逐策略只按 settle 时间**：不区分任务类型/大小；若将来终态条目承载更重的状态（如大结果驻留），需要按体积驱逐时另立任务。
