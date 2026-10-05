# 队列项引导提升（guideQueueItem → 行内注入）

涉及包：`packages/shared`（协议命令）、`packages/bootstrap`（handler 与 facade）、`apps/zcode-cli/packages/core`（本 spec 主责）、`packages/ui`（队列面板按钮，UI 视角见 `packages/ui/spec/composer-per-send-delivery.md`）。

## 背景与问题

队列面板的排队项只有「立即发送」（`sendQueuedNow`：stop 当前 turn + 起新 turn 的抢占语义）。用户需要不打断当前命令、在当前 tool batch 结束后尽快插入一条已排队的消息。协议与 Core 此前没有任何「把已有排队项改投 guide」的路径：`editQueueItem` 只改文本，`steerTurn` 的调用者没有一个是「从队列取项」。

## 设计决策

新增轻量 CAS 命令 `guideQueueItem { queueItemId }`，而非扩展 `sendQueuedNow`：两者投递语义互斥（stop+新 turn vs 注入当前 turn）、ACK 与失败形态不同；独立命令让 guard 各自干净，handler 也无需 lease/reserve/preempt/start/remove 序列。

核心提升（`steering.ts` 的 `guidePendingInputById`）分两分支，均以**同 id 重发 `TurnSteerQueued`（delivery: "guide"）** 收口——v4 reducer 的 `onTurnSteerQueued` 以 `queueItemId` 为 key 同 id 原地更新（保位），投影 `delivery.admitted` 变 guide 后，UI 的 `pendingGuideProjection` 自动把该项从队列面板分流到时间线「等待引导当前任务…」：

- **内存项分支**（`activeTurn.pendingInputs` 中已有的项，如 fallback 产物）：原地改 `delivery`/`intent.admittedDelivery`（清 `fallbackReasonCode`、更新 `queuePosition` 与 `turnId`）后重发事件。
- **投影项分支**（busy 期间排队的常态，权威在事件日志）：经 `rebuildProjection` 定位后构造 `PendingTurnInput`（同 `pendingInputId`、`delivery: "guide"`、`queryId` 新建、`turnId` = active turn）push 进 `pendingInputs`，再重发事件。`targetTurnId` 变化不影响 reducer 的原地更新。

## 行为

- 提升成功后，该项由既有的 tool batch 边界行内 drain（`turn-guide-drain.ts`）在当前命令结束后注入，不打断当前命令；drain 的持久化、`TurnSteerDrained` 事件、transcript 落 row 全部复用既有链路。
- 提升后若 turn 被打断或无 tool 边界，`fallbackPendingGuidesToQueue` 把它转回普通 queue——不丢消息。

## 所有权与不变式

- `queueItemId ≡ core 的 pendingInputId`（同一 id 空间），跨层无需翻译。
- 仅 `dispatch.state === "queued"` 的项可提升：core 以 `pendingInputReservations` 拒绝已 reserve/promoting 的项（返回 `reserved`）。
- 仅 text-only 的 sendText 意图可提升：`compact` / `sendGoalCommand` 是 typed maintenance intent，引导会把它伪装成普通输入；附件项会被行内 drain 拒绝。bootstrap handler 前置校验（`host.getQueueItem`），core 内部再以投影权威复核。
- 提升要求存在 steerable 的 active turn，且 `permissionFullAccessPending` 为 false（此时行内 drain 一律暂停，提升只会让项卡在 guide 车道）。
- 排队输入的投递方式唯一所有者是 Core；bootstrap/UI 只编码意图与展示，不做二次裁决。

## 失败语义

core 返回 discriminated result，bootstrap 映射为命令错误：

| result | 命令错误 | 语义 |
|---|---|---|
| `guided` | accepted | 提升完成 |
| `missing` | noop `queue.itemMissing` | 项已被消费/删除（与 deleteQueueItem 的竞态语义一致） |
| `reserved` | `guard.queueItemReserved` | 该项正在被另一提升流程处理 |
| `no_active_turn` | `guard.queueGuideNoActiveTurn` | idle（held/choice 队列）无可引导的 turn |
| `not_steerable` | `guard.queueGuideNotSteerable` | 当前 turn 不可安全行内注入 |
| `unsupported_item` | `guard.queueGuideUnsupported` | compact/goal/附件项 |

失败路径原项原位保留（提升是「改投」而非「搬移」，事件未写即无副作用）。

## UI 契约（packages/ui）

- 队列面板每项新增「引导」按钮（`TID_V4_QUEUE_ITEM_GUIDE`，后缀 queueItemId），与「立即发送」同形态。
- 按钮禁用条件：`!canGuideItems`（SessionPane 传 `control.canStop`，busy 才有意义）或行锁定（dispatch 非 queued / 编辑中）或项带附件。compact/goal 项不渲染该按钮。
- 点击经 CAS `dispatchCommand("guideQueueItem", …)`；成功后投影自动把项分流到 pendingGuides，队列面板该项消失。
