# 子代理回复与协调者前台等待的放行（RespondToCoordinator foreground release）

涉及包：`contracts`（`RespondToCoordinatorOutputSchema.coordinatorAttention`）、`core`（本 spec 主责）。

## 背景与问题

子代理调用 `RespondToCoordinator` 时，回复经 `enqueueSubagentMessage` 进入**父 runtime** 的命令队列，工具同步返回 success（「已排队」）。消费方有三个时机，全部要求父 turn 让出模型循环：

1. 父 runtime 空闲：drain 为每条 `subagent-message` 开新 turn；
2. 父 turn 滚动中：`runRegularTurnLoop` 模型步骤之间的 `drainPendingRuntimeCommandsForActiveLoop` mid-turn 注入；
3. 父 prompt command 结束后：同一次 drain 的 while 循环继续出队。

当父代理用 Agent 工具**前台** spawn 该子代理时，父 turn 阻塞在工具执行上：模型循环不滚动、drain 被主 prompt command 占用。而 provider 协议禁止在 `tool_use` 与 `tool_result` 之间插入 user 消息，因此「往等待中的父 turn 里塞回复」在协议层不成立。结果：父代理等子代理完成、子代理按工具指引（continue the current task）等协调者回话，双向等待直至用户手动 Stop（2026-10-01 鹈鹕任务实测，主会话 `sess_cf785d0f` 零模型请求 25 分钟）。

## 设计决策

- **放行手段复用既有 `registry.requestBackground(agentId)`**，不新增等待循环内的消费点。前台 runner 的 `Promise.race` 本就挂着 `waitForBackgroundRequest` waiter；requestBackground 让 Agent 工具先返回 `async_launched`，父 turn 得以继续，已入队的回复随后按上面 1/2/3 任一时机被消费。
- **顺序固定为先入队、再转后台**：`enqueueRuntimeCommand` 同步完成后才 `requestBackground`，保证 Agent 结果返回时消息已在队列里。
- **借用前台模型覆盖的运行（闲时轮 `modelOverride`）不假装释放**：runner 对这种运行不创建 background waiter，`requestBackground` 只改快照、放行不了等待。此时回复照常入队，但 port 返回 `coordinatorAttention: "busy"` 与诚实文案，子代理模型被明确告知不得等待回复。
- 只处理 `type === "local_agent"` 且非终态的任务；其它任务类型（dwf run 等）与注册表之外的 agentId 不做放行动作。

## 行为

- `enqueueSubagentMessage` 入队成功后：
  - 任务不存在 / 非 `local_agent` / 已后台 / 已终态 → 返回 `undefined`，无放行语义；
  - 任务 `foregroundModelOverride === true` → 返回 `{ foregroundWaitReleased: false, foregroundWaitBusy: true }`，不调 `requestBackground`；
  - 其余前台任务 → 调 `requestBackground` 并返回 `{ foregroundWaitReleased: true }`；成功时记 info 日志 `subagent.response.foreground_wait_released`。
- `CoordinatorResponsePort.respond` 把处置映射进输出：
  - busy → `status: "success"`、`coordinatorAttention: "busy"`、message 明示「协调者仍前台阻塞，运行结束后才会读到；不要等待回复，自行完成或结束任务」；
  - released → `coordinatorAttention: "released"`、原「已排队」语义；
  - 其余 → 原行为不变。
- `formatRespondToCoordinatorModelContent` 按 attention 出文案：busy 分支必须打破「排队=会有人回」的预期；released 分支说明前台等待已释放、回复会被立即读到。
- runner 侧前台 `run()` 注册任务时携带 `foregroundModelOverride` 标记（`RuntimeTaskSnapshot` 可选字段，core 内部，不进 contracts）。

## 所有权与不变式

- 入队与放行的唯一 owner 是父 runtime 的 `enqueueSubagentMessage`；子代理侧（port、工具 handler）只消费其处置结果，不直接触碰 registry。
- `requestBackground` 只负责放行等待，不改变消息所有权：回复仍是父 runtime 命令队列中的 `subagent-message` command，由既有 drain/注入机制消费。
- branchGeneration fencing 优先于放行：stale 分支丢弃消息且不触碰 registry。
- `RespondToCoordinatorOutputSchema` 为 strict；`coordinatorAttention` 为可选字段，向后兼容旧输出。V4 display 投影（`respondToCoordinatorToolResultDisplayPayloadSchema`）只 pick `kind/status`，不受新增字段影响。

## 失败语义

- `requestBackground` 返回 false（任务已消失或已终态）→ 视同无放行动作，返回 `undefined`，消息留在队列按原时机消费。
- 转后台后 runner 的 `finalizeBackgroundCompletion/Failure` 照常在子代理终态时发 task-notification；父 Stop 不再波及已放行的子代理（已 detach parent）。
- busy 场景下消息不会丢：子代理运行结束（含失败）后，队列按时机 1/3 正常消费。

## 迁移边界

- 不改 Agent 工具默认前台语义、不改 `autoBackgroundMs` 默认（关闭）；本修复只在「子代理主动回话」这一刻放行等待。
- 并发前台 Agent 批次中仅放行回话的那个子代理；同批次其余前台 Agent 仍会阻塞批次——那是同一矛盾在多代理批次下的另一形态，另行治理。
- 历史会话无迁移；行为随代码即时生效。
