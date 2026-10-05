# Composer per-send 投递模式（普通 / 立即 / 插队引导）

涉及包：`packages/ui`（本 spec 唯一落点）。协议（`packages/shared`）、Host（`packages/desktop`、`packages/services`）、CLI（`apps/zcode-cli`）不改动；文末列出所依赖的既有 CLI 行为。

> 追加（队列面板「引导」按钮）：队列面板每项的引导入口属于跨包改动，协议/CLI 机制见
> `apps/zcode-cli/packages/core/spec/queue-item-guide-promotion.md`；本文件末尾「队列面板按钮契约」一节只记录 UI 侧落点。

## 背景与问题

v4 协议的 `sendText` 命令早已支持 `requestedDelivery: "startNow" | "queue" | "guide"` 三档投递（`packages/shared/src/zcode-protocol-v4/command.ts`），但 UI 层只产生过两档：

- 普通发送（Enter / 点发送键）：不传 `requestedDelivery`，由 CLI 按 `inputRouting.mode` + 会话 `followupMode` 裁决。
- 修饰键发送（busy 时 Cmd/Ctrl+Enter 或按住修饰键点击发送键）：经 `resolveOppositeFollowupDelivery` 产生「反向于全局设置」的单次覆盖——queue 模式下得到 `startNow`，guide 模式下得到 `queue`。

`guide`（插队引导：不打断当前命令，当前 tool batch 一结束、下次模型请求前注入）只能通过设置页全局开关 `zcodeInteractionBehavior: "guide"` 使用，没有单次发送入口。用户需要在 Agent 运行途中按次选择「排队 / 立即抢占 / 插队引导」。

## 设计决策

### 1. 固定映射替代「反向」

修饰键从「反向于全局设置」改为固定语义，同一手势含义恒定，不再依赖全局设置推断：

- Enter / 点发送键 = 普通发送（不传 `requestedDelivery`，CLI 裁决）——不变。
- Cmd/Ctrl+Enter（或按住 Cmd/Ctrl 点发送键）= **立即发送**，恒传 `"startNow"`。
- Alt/Option+Enter（或按住 Alt/Option 点发送键）= **插队引导**，仅 busy 且无附件时传 `"guide"`；idle 或带附件时不传（走普通发送）。
- 两修饰键同时按住时 startNow 优先（定死，避免歧义）。

**语义迁移**：全局设置为 guide 的用户，Cmd/Ctrl+Enter 从「加入队列」变为「立即发送」。这是有意的：三模式落地后固定映射比反向映射更可预测。

### 2. 入口形态：发送拆分按钮（下拉菜单）+ 修饰键

busy 且有草稿且路由允许时，发送键右侧出现独立 chevron 下拉箭头，展开三项菜单（标题 + 一行描述 + 快捷键标注）：

| 菜单项       | 快捷键       | 描述                                                       | requestedDelivery |
| ------------ | ------------ | ---------------------------------------------------------- | ----------------- |
| 加入队列     | Enter        | 当前任务完成后处理                                         | `"queue"`         |
| 引导当前任务 | ⌥/Alt+Enter  | 不打断当前命令，本轮结束后尽快插入；不可引导时自动转为排队 | `"guide"`         |
| 立即发送     | ⌘/Ctrl+Enter | 打断当前任务，立即开始                                     | `"startNow"`      |

菜单是显式三选一（三项都传明确 delivery），修饰键是同一组动作的快捷路径；菜单同时充当快捷键的发现面板。

### 3. 可用性判定：UI 只做粗粒度，细粒度交给 CLI 回落

- UI 侧引导可用信号 = `canStop`（存在 active turn）且无附件。不把 `activeTurn.steerable` 投影到 UI（避免扩协议）。
- `steerable=false`、turn 被 stop 等更细粒度的不可引导场景，由 CLI 既有 fallback（`fallbackPendingGuidesToQueue`，原因码 `guide.noToolBoundary` / `guide.turnInterrupted`）自动转为排队项，投影可见：引导区消失、队列面板出现普通项。UI 不重复实现 CLI 裁决。
- `inputRouting.mode === "enqueue"`（压缩会话 / goal 校验中）：下拉箭头不出现——此期间既不插队也不抢占，只允许排队发送。
- `mode === "reject"`：现状不变（不可发送）。
- idle：箭头不出现（三方式收敛为普通发送），界面与现状完全一致。
- busy 无草稿：保持 Stop 按钮形态，不出现箭头。
- `choice`（held 队列裁决）：菜单照常；选择经既有 `heldQueueConfirmation` 确认框原样回放，无额外改动。

## 行为

- 下拉菜单任一项点击后走与普通发送相同的 `submit()` 路径：同一 pending 状态、同一 telemetry、同一乐观更新边界；`startNow` 沿用现有乐观清空编辑器逻辑。
- 发送后的反馈沿用既有投影：`guide` 项出现在时间线尾部「等待引导当前任务…」（`ConversationPendingGuideList`）；回落时自动变为队列面板普通项。
- 修饰键 tooltip（`ControlHintTooltip` 受控 open）随按住的修饰键实时切换：⌘/Ctrl →「立即发送」、⌥/Alt →「引导当前任务」；tooltip 的 enabled 条件为 busy 且可发送，与手势生效条件一致。
- 全局设置 `zcodeInteractionBehavior`（队列 / 引导）保留，语义收窄为「普通发送（无修饰键）在 busy 时的默认投递偏好」，不再影响修饰键手势的语义。

## 所有权与不变式

- 投递语义的唯一所有者是 CLI（admission 与 fallback）；UI 只负责把用户意图编码为 `requestedDelivery` 并透传，不做二次裁决。
- `submit()` 的 `requestedDelivery` 仍是「本次发送的一次性覆盖」，不写会话偏好；会话偏好的唯一写入路径仍是设置页 → `setFollowupMode`。
- 修饰键是 window 级事实，继续由单一外部 store 广播（多 Composer 共享一套监听），不入 Zustand。

## 失败语义

- 命令被 CLI 拒绝（ack 非 accepted）：沿用现状——`startNow` 用冻结编辑器状态恢复草稿，其余留在输入框。
- 引导项在 CLI 侧回落为排队：不是失败，投影自动反映；UI 无需额外提示。
- 附件未就绪 / 草稿为空：`canSend` 门控不变，菜单项与快捷键不产生提交。

## 依赖的既有 CLI 行为（只读引用，不在本次范围）

- `guide` 注入边界：`apps/zcode-cli/packages/core/src/runtime/methods/turn-tools.ts`（tool batch 执行完毕、下一次模型请求前最多消费一条 guide）。
- 引导不支持附件：admission 回落原因码 `guide.attachmentsUnsupported`（UI 已提前禁用，此为兜底）。
- `startNow` 原子抢占：bootstrap `session-flow.ts` 的 stop + start 序列，accepted ACK 即 UI 清空边界。

## 队列面板按钮契约（追加，跨包：协议/CLI 见 core spec）

队列面板（`ConversationQueuePanel`）每个排队项在「立即发送」旁新增「引导」按钮：

- 协议命令 `guideQueueItem { queueItemId }`（CAS），语义 = 该项不打断当前命令、在当前 tool batch 结束后行内注入；与 `sendQueuedNow` 的抢占语义互斥。
- 按钮禁用条件：`!canGuideItems`（SessionPane 传 `control.canStop`——idle / held 队列无可引导 turn）或行锁定（dispatch 非 queued / 编辑中）或项带附件（`item.attachments.length > 0`）。compact / sendGoalCommand 项不渲染该按钮。
- 点击成功后投影同 id 原地改流（`delivery.admitted` → guide），`pendingGuideProjection` 自动把该项从 `visibleQueue` 移入时间线尾部「等待引导当前任务…」，队列面板该项消失。
- 拒绝（`guard.queueGuide*` / `queue.itemMissing`）：按既有 dispatchCommand ack 反馈路径处理，原项保留在队列。
- 协议/CLI 机制、所有权与失败语义详见 `apps/zcode-cli/packages/core/spec/queue-item-guide-promotion.md`。
