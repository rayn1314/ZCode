# 跨会话消息体系审计修复（5 项正确性缺陷）

> **涉及包（跨包变更，本文件为唯一 spec）**：
> - `apps/zcode-cli/packages/bootstrap`：同进程投递档、v4 幂等键、通知兜底键；
> - `apps/zcode-cli/packages/core`：mailbox hook 回滚、防环链清链裁决、steer 拒绝上抛；
> - `apps/zcode-cli/packages/adapters`：mailbox `restoreToUnread` 实现；
> - `apps/zcode-cli/packages/contracts`：`SessionMailboxPort.restoreToUnread` 契约；
> - `packages/shared`：`sessionMessageV4CommandId` / `SESSION_MESSAGE_CLIENT_ID` 单源；
> - `packages/services`：Host 转投与回执的幂等键/提交端、task_complete 行状态分派。
>
> 前置 spec：`subagent-session-messaging.md`（D3 投递三档、D7 防环链）。本 spec 对
> D7 的清除点做了修订（修复 4），修订原因记录在下；D3 的档位描述已同步改写。

## 背景

跨会话消息审计确认了 5 个正确性缺陷：同进程投递档的抢占竞态、mailbox 出队后
交付失败的丢失窗口、两投递路径幂等键不同源、防环链被非人类输入重置、task 终态
行状态无视 stopReason。五项都属于"消息要么不丢、要么不重复、要么计数不失效"
这条主线，逐项修复并逐项落测试。

## 修复 1 · 同进程投递恒用 guide（bootstrap）

**背景与问题**：`BootstrapSessionMessagePort.deliver` 按发送时刻的 `hasActiveTurn`
快照在 `guide` / `startNow` 之间选档；目标若在快照之后刚起轮，`startNow` 分支的
`preemptActiveTurnAndWait`（`session-flow.ts`）会把它 abort 掉——用投递消息打断了
目标正在跑的回合。Host 跨进程路径已刻意恒用 guide 规避同一竞态
（`zcodeTaskServiceAdapter.deliverSessionMessageToTarget` 头注释），同进程路径未对齐。

**关键验证点（本项修法成立的前提）**：空闲目标在 `guide` 档必须仍被唤醒。链路：
`sendText(requestedDelivery: "guide")` → `startPromptTurn` 把它落成
`queueDelivery: "guide"` → core `admitPrompt`：
- 不忙（空闲分支，`prompt-admission.ts:91+`）→ 不看 `queueDelivery`，直接
  `reserveTurnStart` + 入队 prompt 命令开新轮 → **空闲目标照常被唤醒（woken）**；
- 忙且可引导 → `steerTurn({delivery:"guide"})` → steered；
- 忙不可引导/带附件 → `enqueueDeferredInput({delivery:"guide"})` → 排队。

**决策**：投递档恒为 `"guide"`，`hasActiveTurn` 快照只保留给回执状态
（`steered`/`woken`）的近似判定；`SessionMessageV4SendInput.requestedDelivery`
收窄为字面量 `"guide"`（startNow 不再从本端口发出，协议层 UI 的 startNow 语义不变）。

**行为变化**：空闲/冷恢复目标收到消息时不再走 forceStartNow（不取前台租约、不
`requireIdle`），由普通 admission 开新轮；回执状态口径不变。

**失败语义**：不变——v4 被拒/抛错仍降级 mailbox `stored`；held queue（choice 模式）
缺 disposition 时 `sendText` 拒绝 → 与 Host 路径同语义（落 mailbox）。

**不变式**：投递永不抢占目标回合；`startNow` 的抢占语义只保留给用户显式触发。

## 修复 2 · mailbox steer 失败回滚 unread（adapters/contracts/core）

**背景与问题**：`drainUnread` 先归档 `read/` 再交出（防双读）。PostToolUse hook 把
批次交给 `steerTurn`，被拒只写 warn——正文已离开 `unread/`，永不重试 = 静默丢消息。

**决策**：契约新增 `SessionMailboxPort.restoreToUnread({sessionId, envelope})`：
把已归档的信封放回 `unread/`。hook 的 `enqueuePendingInput` 被拒时抛
`SessionMailboxEnqueueRejectedError`，hook 捕获后回滚该信封；enqueue 意外抛错时
把当前及尚未交出的后续信封一并回滚再上抛。**保持"不丢不重"**：
- 成功投递的信封留在 `read/`，失败回滚的下轮 drain 重读**恰一次**；
- 回滚幂等：`unread/` 已有同名（重投已落盘）时收敛为单份、清掉 `read/` 旧副本，
  绝不产生第二份可读消息；
- `read/` 副本缺失时按内存中的信封重写，不因磁盘副本消失丢消息；
- 只碰该信封自身文件，坏档隔离（`failed/`）语义不变。

**行为变化**：steer 被拒的消息从"丢失"变为"下轮重读"（下轮可以是同一 turn 的
下一个 hook 事件、Stop 或下一次人类输入）；单条回滚失败只留日志，不拖垮整批。

**失败语义**：回滚自身的真实 IO 故障向上抛到 hook → 记
`session.mailbox.restore_failed` warn（正文暂留 `read/`，靠日志暴露），不吞也不重投。

**不变式**：任何信封要么在 `unread/`（待投）、要么在 `read/`（已投或待回滚）、
要么在 `failed/`（坏档）；不存在"在 `read/` 却从未被投递且无人知晓"的状态。

**已知边界**：同一 turn 内回滚的消息会在下轮 drain 追上先投递成功的后续消息
（顺序可能与原批次不同）；输入尺寸类拒绝（`input_too_large`，现实中被 SendMessage
的正文上限挡住）会重复重试而非丢弃——按"不丢"优先接受。

## 修复 3 · 两投递路径共享幂等键（bootstrap/services/shared）

**背景与问题**：同一封消息有两条 v4 投递路径——CLI 同进程直投与 Host 转投。
CommandInbox 按 `{sessionId, commandId}` 去重，两键必须同源，否则 ACK 丢失重投时
互不知情 → 双投。原实现两侧各推导一次（CLI `requestId ?? "session-message:<id>"`、
Host 直接用 `requestId`），键的共享只是"恰好都等于同一个表达式"的巧合，而非结构保证；
契约允许 `SessionMessageDeliveryRequest.requestId` 取任意值，一旦与 CLI 表达式不同源
即分叉。

**决策**：新增单源 `sessionMessageV4CommandId(messageId)`（`@zcode/shared`），CLI 与
Host 的 v4 `commandId` **一律**由 messageId 派生（`session-message:<messageId>`），
不再看 requestId；requestId 保留为跨进程路由与结果关联键（main pending 表、
delivery result），语义不变。

**验证**：`CommandInbox` 的 key 结构 `{sessionId, commandId}`（`command-inbox.ts`）
不含 clientId/queueItemId 等其它假设，改键不破坏任何关联；`queueItemId`、inputId
锚点随 commandId 同步变为 messageId 派生（生产链路中 requestId 本就被 port 归一成
同值，无行为漂移）。

**失败语义**：不变——ACK 丢失重投现在必然命中同键 → `duplicate` → 已按落地处理。

**不变式**：一封消息（messageId）在一个目标会话的 CommandInbox 里只有一个去重键，
与经手路径无关。

## 修复 4 · 只有人类输入才重置防环链（core/services + spec D7 修订）

**背景与问题**：防环链是单槽 `inboundSessionMessageChain`。原清除点两处都过宽：
1. `turn.ts`：任何带 intent 且无链的命令面输入清链——Host 投递回执（无链 sendText）
   若恰好赶上目标开新轮，就按"人重新开话头"把链清零，A↔B 循环的 hop 计数归零、
   cap 失效；
2. mailbox hook：整批无链的 drain 也清链——mailbox 信封只可能来自会话
   （`senderKind: session | subagent`），永远不是人类插话。

**spec D7 修订**：原文写"任何无链的命令面输入 = 人重新开的输入"。修订为"**只有
人类输入才清链**；会话消息来源的无链输入不清链"，修订原因即上述回执/无链信封场景
（见 `subagent-session-messaging.md` D7 的 2026-10-09 订正标注）。

**决策与判据**：
- 提交端判据：会话消息机器发起的 sendText（同进程直投、Host 实时投递、Host 回执）
  统一带 `clientId === SESSION_MESSAGE_CLIENT_ID`（`@zcode/shared` 单源，Host 侧两处
  `createHostCommandEnvelope` 显式传入）。裁决收敛为纯函数
  `inboundChainIntentAction(intent)`：带链 → `set`；无链 + 会话消息提交端 → `keep`；
  其余（人类 prompt、goal、compact 等）→ `clear`；
- mailbox hook：只有本批存在带链消息才 `noteInbound`（取最后一条的链），空批与
  无链批都不调用；
- core 内部派生轮次（`inputSource` 的 subagent/background 等）不带 intent，本来
  就到不了裁决点，维持 D7 原状。

**行为变化**：回执、无链旧信封不再清链；人类 prompt 照常清链（D7"用户再说一句话
即重置链深"不变）；带链消息的传播（set）不变。

**不变式**：链只由"带链的会话消息"改写为新链、由"人类输入"清零；其它任何输入
都不触碰。

## 修复 5 · task_complete 按 stopReason 分派行状态（services）

**背景与问题**：`updateTaskIndexFromStreamEvent` 对 `task_complete` 无条件写
`status: "completed"`。上游 `turn.completed` 的 `resultType`（= `stopReason`）词表含
`error_max_turns / error_max_budget / error_during_execution / error_max_tool_calls`；
投影侧（`product-projection.onTurnComplete`）把它们派生为 phase `error`、syncer
（`taskStatusFromSummaryPhase`）落 `status: "error"`——事件流却把同一轮写成
`completed`，行状态与投影互相打架。

**复现测试先行**：修复前先落测试 `packages/services/test/taskCompleteStatus.test.ts`
（驱动 adapter 真实事件链 `session.event → mapSessionEvent → applyAgentPatch`），
实测 `cancelled → completed`（与 syncer 的 completedInterrupted 口径一致，无需改）、
`error_during_execution → completed`（缺陷所在，期望 `error`）。

**决策**：`taskIndexPatchFromTaskComplete(stopReason)` 分派，词表与投影/syncer 对齐：
- `success` / `cancelled` → `completed`，并清 `lastError`（沿 completed 旧语义）；
- `error_*` 及未识别值 → `error`，**不动 `lastError`**（错误正文不在 TurnComplete
  payload 里；与 syncer 的 error 分支一致，权威值由随后的回源 snapshot 写入）；
- 缺省 `"complete"`（旧 payload 无 resultType 的上游兜底）→ `completed`，保持兼容。

**同链核查（不修的部分）**：`zcodeTaskIndexSyncer.emitTerminalAndReady` 的
`failed = phase === "error"`——TurnError 走 `turn.failed`/`task_error`、投影 phase
为 `error`，`failed=false` 时确实只对应 completedSuccess/completedInterrupted，
语义正确，未改动。

**行为变化**：以 `error_*` 收口的轮，任务行状态从错误地 `completed` 变为 `error`；
`cancelled` 行为不变。

**不变式**：同一轮的行状态、conversation 投影 phase、syncer 终态三者同词
（success/cancelled → completed，error → error）。

## 测试与验收

| 项 | 测试 |
| --- | --- |
| 1 | `apps/zcode-cli/packages/bootstrap/test/session-message-port.test.ts`（active/idle 均发 guide） |
| 2 | `apps/zcode-cli/packages/adapters/test/mailbox.test.ts`（restore 往返/幂等/坏档隔离）+ `apps/zcode-cli/packages/core/test/session-mailbox-rollback.test.ts`（被拒回滚、抛错回滚后续） |
| 3 | bootstrap port 测试（requestId 不影响 commandId）+ `packages/services/test/sessionMessageDelivery.test.ts`（Host commandId/clientId 断言） |
| 4 | `apps/zcode-cli/packages/core/test/session-message-chain.test.ts`（人类 clear / 会话消息 keep / 无链批不清） |
| 5 | `packages/services/test/taskCompleteStatus.test.ts`（cancelled/success/error_* 行状态） |

## 迁移边界

- 旧信封（无 `senderKind` / 无 `chain`）继续合法：读取方按缺省处理；无链信封现在
  只是不再触发清链，无兼容性破坏。
- 旧 payload 的 `task_complete`（无 `resultType` → `stopReason: "complete"`）落
  `completed`，与修复前一致。
- Host 转投 commandId 在生产链路中本就被归一为 `session-message:<messageId>`，
  改键对存量数据/在途命令无漂移；`requestId` 在 main 路由中的角色未变。
- 本 spec 不覆盖：automation/cron 等非人类、非会话消息的命令面输入仍按原样清链
  （本轮审计未涉及；若后续确认需要豁免，扩展 `inboundChainIntentAction` 即可）。
