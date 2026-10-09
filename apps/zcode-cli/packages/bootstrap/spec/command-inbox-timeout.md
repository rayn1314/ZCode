# Command execute deadline（命令执行超时与准入 gate 释放）

涉及包：`packages/shared`（`PROTOCOL_V4_LIMITS` 超时常量）、`packages/bootstrap`（本 spec 主责：`zcode-protocol-v4/v4-gateway.ts`、`zcode-protocol-v4/command-inbox.ts`）。

## 背景与问题

多 agent 运行时最高危的挂死点（已对着当前检出源码核实）：

1. `CommandInbox.handle` 的 session admission gate 在 `sessionGates.acquire(bucketKey)` 拿到后一直持有到 `settle()`（唯一释放点）。gateway 的 `handleCommand` 在 `inbox.handle` 返回 `execute` 结果之后才 `await this.host.executeCommand(...)`，随后 settle。**整个 execute 路径没有任何 `setTimeout`**——一条永不 resolve 的命令 = 该会话之后所有 `handle`（同 bucket 的 FIFO 排队）与 `queryCommands`（`queryOne → lookupExact → inflight.final`）永久挂起。
2. `sessionId === null` 的 createSession 与 null-session query 共用 `@global` 桶，任一卡死会阻塞全部 createSession。
3. `PROTOCOL_V4_LIMITS.conversationQueryTimeoutMs: 10_000` 已声明但全仓无消费者，query 路径同样无上限。
4. 既有防线只有两道，都不覆盖挂起：
   - gateway `finally` 在 `!settledAck` 时补 `settleOnce`——只覆盖**同步异常**（publisher/measure/admission 抛错），不覆盖 await 永不返回；
   - `settle`/`settleOnce` 双重幂等——保证迟到的 settle 无副作用，但前提是有人先 settle。

## 设计决策

### D1 · deadline 放在 gateway `handleCommand`，不放 `CommandInbox`

`CommandInbox` 只负责裁决与 gate；把调用方拖住的是 gateway 对 `host.executeCommand` 的 `await`，能给调用方回 ACK、能打 error 日志、能走既有 `settleOnce` 收口的也只有 gateway。命令进入 execute 路径（`inbox.handle` 返回 `kind: "execute"`）即创建 deadline promise，`Promise.race` 同时覆盖 `admitCommandInput` 与 `executeCommand` 两段 await。到点 reject `V4CommandExecuteTimeoutError`，进入既有 catch 分支收口——单一 settle 路径，不引入第二套终态写入。

`inbox.handle` 自身（裁决期的宿主 lookup、等待上一条命令的 gate）不套这个 deadline：前者见「遗留」，后者已被上一条命令自己的 deadline 间接限定。

### D2 · 超时值：单命令默认 60s，query 10s

常量落在 `PROTOCOL_V4_LIMITS`（`packages/shared/src/zcode-protocol-v4/core.ts`）：

- `commandExecuteTimeoutMs: 60_000`。依据（宁可宽松也不误杀）：
  - handler 内显式等待的上界：`waitForSessionIdle` / `preemptActiveTurnAndWait` 5s（`session-flow.ts` 的 `IDLE_POLL_TIMEOUT_MS`）、逻辑帧装配 30s（`logicalFrameAssemblyTimeoutMs`）；
  - 其余合法路径都是本机 IO 与进程内状态迁移：createSession 建 record / 历史导入 resume、fork 拷贝、附件读盘（单附件 ≤20MiB、本地读）；
  - compact / sendText / queue 类命令只推进到 admission 与入队，**不等 turn 结束**（模型 turn 在后台跑，终态走事件流）；
  - 未发现任何 handler 合法地需要 await 超过 60s，故不分命令类别，取统一宽松上界；若未来出现慢命令类别（例如大规模历史导入），再按类别细分，不预先加分支。
- `conversationQueryTimeoutMs: 10_000`（既有声明值，本轮起成为唯一消费者 `CommandInbox.queryOne`）。对账是只读路径，不跟随 execute 的 60s 一起挂：到点先给客户端可操作的收口，客户端稍后重查即可拿到终态。

两值均可经 `ConversationV4GatewayOptions` 注入（缺省取 `PROTOCOL_V4_LIMITS`），测试用短值注入，不与生产值耦合。

### D3 · admission 与 execute 拆成两条 promise

`admissionWork`（admit + pin live input）与 `execution = admissionWork.then(execute)` 串成同一执行链但各自可寻址。原因：deadline 命中时 admission 可能还没落定，若只 settle 不回收，迟到的 admission 会在超时之后建立 pin / durable input，永久残留（`hasPinnedSessionState` 恒真 → resident 无法回收）。超时分支挂 `admissionWork.then(...)`：admission 已落定时同一 handler 立即执行，迟到落定时由它自己完成 `cancelCommandInput` + `releaseLiveInput`。IIFE 内的 pin 注册先于该 handler（微任务顺序有保证），因此「先 pin 后回收」的顺序确定。

### D4 · 超时定时器 unref，settle 时清表

deadline 与 query 定时器都 `unref()`：超时只在运行期保护 gate，不应阻止进程退出。清表收敛在 `settleOnce` 第一行（settle 是唯一收口点，所有返回路径都经过它），保证正常终态不会在之后触发 reject。

## 行为

- execute 路径启动后 `commandExecuteTimeoutMs` 内未 settle：
  - 调用方（`handleCommand` 的 RPC）收到 `ACK status="failed"`、`reasonCode="fault.command.executeTimeout"`、`message="命令执行超时（60000ms），会话准入已释放"`；
  - `settleOnce → outcome.settle` 释放 session/@global FIFO gate，`inflight` 条目删除、终态进 settled LRU；
  - `onError("v4.command.execute.timeout", error)` 打 error 日志；
  - 迟到的 execute 完成/失败不改写终态（见不变式）。
- `commands/query` 单 key 在 `conversationQueryTimeoutMs` 内未拿到 lookup 结果：
  - 该 key 仍在执行 → 回它当前的 admission ACK（`status="accepted"`，「尚未定论」的诚实答案，客户端稍后重查）；
  - 不在执行（宿主 lookup 挂起）→ 回 `failed` + `fault.command.queryUnavailable`（UI 侧既有语义：保持 pending、稍后重查，不误报可操作错误）；
  - key gate 随超时提前释放（release 幂等，卡住的 lookup 结束时重复调用无害），不把后续同 key 的 handle 排在一次卡死的 lookup 后面。

## 所有权与不变式

- **终态唯一写入点**仍是 `CommandInbox.settle`（gateway 经 `settleOnce` 调用）；deadline 不绕过它，只提前触发它。
- **gate 必释放**：settle（含超时触发的 settle）释放 session bucket gate；execute 路径的 key gate 在 pin 后即释放；query 超时释放自己的 key gate。任何超时路径都不得留下持有中的 gate。
- **幂等**：`settleOnce` 以 `settledAck` 挡第二次调用，`inbox.settle` 以 `settled` 标志挡第二次释放——迟到的正常 settle、超时与正常完成的竞态都不会二次释放 gate 或覆盖终态。
- **迟到 admission 只回收不改写**：超时终态一旦写定，迟到的 admission 完成只允许取消它自己的 durable input、释放它自己建立的 pin；终态保持 `failed/fault.command.executeTimeout`。
- deadline 只在 `kind === "execute"` 的 outcome 上存在；ack-only 裁决（rejected/stale/noop/duplicate）不启动计时器。

## 失败语义

| 场景 | 发送方收到 | 系统状态 |
|---|---|---|
| execute 超时 | `failed` + `fault.command.executeTimeout` + 中文说明文案 | gate 已释放，会话可继续接命令；同 commandId 重试经 duplicate 路径直接拿该 failed 终态（`retryAck` 不覆盖 failed），要重发必须换新 commandId |
| 超时后迟到完成 | 无（调用方早已拿到 failed ACK） | 不改写终态；admission 若迟到则自取消 + 解 pin |
| query 超时（在途） | `accepted` admission ACK | 客户端稍后重查拿终态 |
| query 超时（非在途） | `failed` + `fault.command.queryUnavailable` | 客户端稍后重查；UI 保持 pending 不弹错 |

注意：超时**不会中止**已经跑起来的宿主副作用（无法强杀 `executeCommand`）——命令可能实际执行成功但 ACK 是 failed（客户端按失败处理并可能以新 commandId 重发）。这是所有 deadline 的固有语义，用 60s 的宽松上界把误判概率压到最低；副作用幂等由各命令自身的幂等边界负责（不在本 spec 范围）。

## 测试

`packages/bootstrap/test/command-inbox-timeout.test.ts`（node:test，注入短超时值）：

1. execute 永不 resolve → deadline 内返回 failed ACK、error 日志、同会话后续命令可完成、`assertSessionRuntimeDeactivatable` 不抛；迟到 resolve 后 query 仍是 failed 终态、后续命令照常。
2. createSession（@global 桶）挂死同样收口，后续 createSession 不被阻塞。
3. query 不跟随 execute 挂死：在途命令在查询上限内回 `accepted`。
4. query 撞上挂起的宿主 lookup：查询上限内回 `queryUnavailable`，且同 key handle 随后能完成（key gate 已释放）。
5. 迟到的 admission：取消原因 `fault.command.executeTimeout`、pin 回收、终态不变。

运行：`cd apps/zcode-cli && node --import tsx --test "packages/bootstrap/test/*.test.ts"`。

## 遗留

- **`@global` 桶不拆**（本轮明确不做）：createSession 与 null-session query 仍共享一个 FIFO 桶，任一 createSession 挂死会在 60s 窗口内串行阻塞其他 createSession。超时把爆炸半径从「永久」压到「≤60s」，可接受；按命令类别拆桶（createSession 桶与 query 桶分离）是独立的结构改造，另立任务。
- **`inbox.handle` 裁决期的宿主 lookup 无 deadline**：`lookupExact` 调用的持久事实回调（transcript/timeline/child/discarded）若挂起，会占住 key gate / session gate——本轮 query 路径已能给查询方收口，但 handle 路径仍会等。该风险依赖宿主 lookup 自身不挂（与 execute 挂死是同类根因、不同入口），需要时在 inbox.handle 内加同款 deadline，另立任务。
- **冷恢复 READY 窗口**（`handleCommand`/`queryCommands` 入口 `await readyFlights`）不在 execute 路径上，本 deadline 不覆盖；冷恢复自身若挂起属另一条链路，未在本轮处理。
