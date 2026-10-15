# 「立即发送」抢占语义与子代理存活边界

涉及包：`apps/zcode-cli/packages/bootstrap`（本 spec 主责，「立即发送」命令链）。
引用包：`apps/zcode-cli/packages/core`（子代理生命周期归属，无代码改动，事实锁死于
`core/spec/subagent-session-messaging.md` 与 `core/spec/subagent-seat-gate-and-registry-bounds.md` 的测试）。

「立即发送」有两个 UI 表面，语义完全一致，共用同一抢占件
`preemptActiveTurnAndWait`（`commands/handlers/session-flow.ts`）：

1. 队列项「立即」按钮：v4 命令 `sendQueuedNow`（UI `ConversationQueuePanel`）。
2. 输入框投递菜单的「立即发送」/⌘+Enter：v4 命令 `sendText` 带
   `requestedDelivery: "startNow"`，busy 时抢占当前轮。

## 背景与问题

「立即发送」是队列项的抢占重发（上述两个表面）。其历史实现完全复用用户手动 stop 的收口链
（`preemptActiveTurnAndWait` in `commands/handlers/session-flow.ts`），导致一次
「插队提问」触发三重连带：

1. **goal-pause**：`pauseActiveGoal` 被共用，排队消息提升时把正在运行的目标任务
   静默置 paused——用户只是想说句话，目标任务停摆、截止时间/任务面板跟着变。
2. **前台 wait 子代理陪葬**：Agent 工具以 wait:true 派发时，子代理的 taskAbort
   链接父 turn signal（`core/src/subagent/runner.ts` run 路径），父轮 abort 连锁
   中止子代理——用户以为「子代理在后台跑着」，实际它绑在父轮上。
3. **孙 Bash 连带清理**：子代理 runtime 自身收尾会取消它派生的后台 Bash。

「停止按钮」（显式 stop）保留级联停树语义，但「立即发送」不应具有停树语义。

## 设计决策

- **D1「立即发送 = 只停父轮 + 立刻重发」**。抢占动作收窄为
  `stopActiveForegroundExecution`（abort 父 runtime 当前前台执行）+ 等 idle +
  提升队列项开新 turn。不动 goal、不停会话树、不主动取消任何后代任务。
  两个 UI 表面（sendQueuedNow、sendText requestedDelivery=startNow）共用本条。
- **D2 goal-pause barrier 只属显式 stop**。`preemptActiveTurnAndWait` 的
  goal-pause 改为显式入参（`pauseGoal?: boolean`），两个「立即发送」表面都传
  false。stop handler 保持 true（默认值），语义不变。编辑历史重发的
  `editUserQuery`（fork-edit-retry）走默认 true：它重写对话历史，抢占后需要
  目标任务停摆避险，不属「插队提问」语义，另行治理。
- **D3 子代理存活边界按派发模式分层，代码现状即契约**：
  - 前台 wait（`wait:true`）：子代理 taskAbort 链接父 turn signal —— 父轮被抢占
    取消时子代理必然中止，Agent 工具以取消结果返回模型。这是「工具调用是父轮
    一部分」的正确语义，保留。
  - 后台 start（默认派发）：taskAbort 不链接父 signal（派发即句柄，转后台即
    `detachParent`）—— 父轮抢占/取消不影响它，终止权只归 TaskStop / watchdog /
    会话 teardown。
  - 两侧行为用 core 测试锁死，防止「顺手再 link 上」。
- **D4 抢占失败回退不产生半停状态**：抢占后 start 失败时 reservation 释放、
  队列项原样保留，goal 未动、子代理未动，父轮已 abort（等同用户停止父轮，可接受）。

## 行为

| 场景                | 立即发送（两个表面同语义）         | 停止按钮（stop）           |
| ------------------- | ---------------------------------- | -------------------------- |
| 父 runtime 前台执行 | abort，等 idle 后重发              | abort，等 idle             |
| 目标任务（goal）    | 不动（D2）                         | pause（barrier）           |
| 前台 wait 子代理    | 随父轮取消（D3，工具如实返回取消） | 级联停树                   |
| 后台 start 子代理   | 存活，继续跑，结果经通知链回流     | 级联停树                   |
| 子代理的后代 Bash   | 不动                               | 随子代理终态清理           |
| 队列项              | 提升为新 turn                      | 不动（drain 授权语义保留） |

## 所有权与不变式

- 命令语义唯一 owner：bootstrap v4 「立即发送」命令链——队列项由
  `sendQueuedNow` handler（`queue.ts`）持有，输入框投递由 `sendText` handler
  （`session-flow.ts`）持有；两处共用同一抢占件 `preemptActiveTurnAndWait`，
  不得复制抢占逻辑。
- 抢占的副作用集合（父轮 abort）必须显式列举于 handler，禁止隐式继承 stop 的
  其它动作（goal-pause/停树）——接口以参数显式声明，不用隐式判断。
  `preemptActiveTurnAndWait` 的全部调用方与显式取值：

  | 调用方                              | pauseGoal 取值 | 理由                   |
  | ----------------------------------- | -------------- | ---------------------- |
  | `queue.ts` sendQueuedNow            | false          | 插队重发（D2）         |
  | `session-flow.ts` sendText startNow | false          | 插队提问（D2）         |
  | `session-flow.ts` stop              | true（默认）   | 显式停止，barrier 保留 |
  | `fork-edit-retry.ts` editUserQuery  | true（默认）   | 历史重写，另行治理     |

- 任务与子代理的生命周期 owner 不变：goal 归 runtime goal 服务，子代理归父
  runtime 的 registry + TaskStop，抢占命令对二者只读不写。

## 失败语义

- 队列项查不到/已被 reserve：拒绝，原项原位保留，不动父轮。
- 抢占本身失败（父轮 idle / 已 abort）：idle 语义下照常提升（autoDrain 路径）。
- goal 相关：「立即发送」两个表面都不触发任何 goal 状态变更，procurement 失败
  （若已 pause 则只可能来自 stop / editUserQuery 路径，不属本命令）。

## 迁移边界

- 不改 stop handler 语义（显式停止仍级联停树 + goal pause）。
- 不改 core runner 任何代码（D3 是现状固定，不新造 link/detach 逻辑）。
- 不覆盖：显式 stop 是否也该放过后台子代理（产品决策，另行讨论）；
  session teardown 时后台子代理的显式终态（降级为 cancelled，spec
  `background-stop-registry-authority.md` 已声明不覆盖）。
