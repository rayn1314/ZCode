# 子代理协作语义进系统提示词与终态通知（继跑优先，不重开）

涉及包：`core`（本 spec 主责：Agent 工具描述、SendMessage 工具描述、Session guidance 段、
`formatLocalAgentTaskNotification`）、`bootstrap`（不改：通知经既有队列入父会话）、`packages/ui`
（不改：只读通知正文）。

前置事实均来自当前源码，不是推测：

- 主代理的工具描述在 `core/src/tool/handlers/agent.ts`（`buildAgentProviderDescription`）与
  `core/src/tool/handlers/send-message.ts`（`SEND_MESSAGE_PROVIDER_DESCRIPTION`）；上下文段在
  `core/src/context/dynamic-sections.ts` 的 `buildSessionGuidanceSection`——那里有一段被注释掉的
  Agent 指导（`if (tools.has("Agent")) {…}`），是唯一本该承担「怎么用子代理」的位置，现在整段不输出。
- `SendMessage(to: "agent_*")` 的三态在 `core/src/subagent/runner.ts`：运行中且有 sink → steer
  进行中轮；运行中无 sink → 入队下一工具轮；**已终态 → `resumeTerminalAgentInBackground`
  以 `resumeFromStore: true` 复用同一 `agentId`、同一个子会话续跑**，工具回执原句是
  `Agent "x" was stopped (status); resumed it in the background with your message.`。
- 终态通知由 `formatLocalAgentTaskNotification` → `formatTaskNotification` 铸造，字段只有
  `task-id / tool-use-id / output-file / status / summary / result / error / usage`，形状是
  `<summary>Agent <type> task "<desc>" <status>. [error]</summary>` 加 `<usage>`。
  `<result>` 只在 completed 有值，failed 的正文是 provider 原错（`selectExecutionErrorMessage`）。

## 背景与问题

用户实测两个反模式，都指向同一件事：**系统层的表述让「续跑」不可见，于是「重开」成为默认动作**。

1. 一个子代理跑了 315 次工具调用、3000 万 token，做了工但最终消息丢了（空 result）。父代理
   没有选择给它发一句「继续」，而是**收窄范围重新派发**——已花的 token 与已产出的工作全部作废。
2. 三个子代理里两个成功、一个失败，父代理对失败者的第一反应是重跑，而不是先判断这个失败
   是不是可自愈的。

根因不在能力，而在三处表述缺口：

- **MVP 能力没写进任何给模型看的地方。**「终态子代理可以用同一 agentId 续跑」这件事只存在于
  `runner.ts` 的实现里，工具描述与系统提示词都没有一句人话把它讲成可执行决策。
- **终态通知是扁平的。** 通知只有 `status` 与一段 `summary`，没有任何分类字段。父代理读完
  只知道「失败了」，无法区分「它做到一半丢了结论」（续跑最划算）与「这条指令本身不可行」
  （重派也没用），于是统一按最贵的方案处理。
- **没有反重开的显式约束。** `buildSessionGuidanceSection` 的 Agent 指导整段被注释，等于把
  「不要重开一个重复子代理」这条不变式从提示词里删掉了；同时 revive 通知
  （`formatLocalAgentTaskRevivedNotification`：`status: running` + `do not dispatch a duplicate
agent`）只覆盖面板直发路径，SendMessage 续跑的工具回执里那句是唯一的防线。

后果不只是浪费 token：**重开会让同一份工作在同一会话里跑两遍**，两个子代理同时改同一批文件
时还会互相覆盖；而续跑天然带着已持久化的工具结果与上下文，成本低一个量级。

## 设计决策

- **D1 表述只在三个点收口，不新增「协作技能」文档层。** Agent 工具描述、SendMessage 工具描述、
  Session guidance 段。模型在这三处读到的口径必须一致，且都由同一批常量导出，避免第四份副本。
- **D1b 同一件事只讲一次；常驻表述有预算。** 这三处是每次请求常驻的，第一版把「终态可续跑、
  别重派」在四处各讲了一遍（Agent 5 条 / SendMessage 3 条 / guidance 3 条，合计约 850 tokens），
  注意力被稀释。收敛后的分工：
  - **Agent 描述**讲机制与取舍（2 条）；
  - **SendMessage 描述**讲续跑消息该怎么写（1 条）；
  - **Session guidance**只留一句指针（1 条）；
  - **失败分类与具体动作**只在失败回执的 `<next-steps>` 里出现——那是动作发生的那一刻，
    也是唯一知道 `reason` / `retryable` / `statusCode` 的地方。
    预算：三处常驻合计不超过约 350 tokens；单条失败指引不超过 240 字符。
- **D2 续跑语义写成可执行规则，而不是一段散文。** 判据是父代理手里已有的字段：
  `agentId` 与 `<next-steps>`。规则只有两条：「终态即可续跑，优先于重派」；
  「续跑消息要自带判断，不是空喊 continue」。
- **D3 空 result 是「丢了结论」，不是「没干活」。** 通知侧为 completed ∧ 空 result 增加一句
  明示（见 D5），父侧规则写明这种情形首选续跑。空 result 的真实成因是 `modelResponse` 为空
  （`turn-model-step.ts` 的 `state.modelResponse = result.text`，provider 截断时不置位），
  与看门狗超时、provider 失败是不同形态——但父代理不需要区分成因，处置动作相同：续跑。
- **D4 失败分类只用错误链上已有的事实，不新造 taxonomy。** 分类输入是
  `projectExecutionErrorPayload(error).attribution` 里的 `reason` / `retryable` / `statusCode`
  与错误链上的 `CoreErrorType`，输出只有五档，每档一句话动作：
  - `transient`（adapter 标 retryable，或 reason ∈ rate_limited / provider_overloaded /
    server_error / network_error / timeout / stream_idle_timeout / stale_connection /
    proxy_error / offpeak_queued，或 type ∈ model_rate_limited / model_timeout）：任务本身
    没失败，续跑；
  - `configuration`（auth_failed / provider_not_configured / invalid_request /
    context_exceeded / tls_error，或 type = model_context_exceeded）：续跑会撞同一堵墙，
    修配置或问用户，别重派；
  - `cancelled`（reason = cancelled，或 type ∈ turn_cancelled / tool_cancelled / cancelled）：
    是被停掉的，不是坏掉的；
  - `inactive`（看门狗写的 `ToolTimeout` + `context.idleMs` 标记）：跑着跑着十分钟没动静被切断，
    不是失败。文案里的时长用配置阈值 `timeoutMs`，与 `<error>` 那句「inactive for Nms」同源；
  - `unknown`：给条件式判据，不假装知道成因。

  `context_exceeded` 刻意归 `configuration` 而不是 `transient`：续跑会立刻再次超窗，
  正确动作是收窄范围，不是「再试一次」。

  **`inactive` 必须最先判定。** 看门狗构造的 CoreError 带 `retryable: true`（「允许再跑」
  的授权），不先拦下来，`retryable === true` 会把「十分钟没活动」说成
  `transient provider error — the provider request failed, not the agent's work`：
  动作对了，原因却是假的。这与 D8 同一条原则——只说运行时真正知道的事。

  **`retryable: false` 不展示。** `createCoreError` 把未指定的 `retryable` 默认成 `false`，
  那不是 adapter 的判断；文案只在 `retryable === true` 时写出来，否则就是假精确。

- **D4b 前台与后台两条失败路径必须同口径。** 前台 Agent 调用失败时抛 CoreError，工具结果
  只把根因 `message` 交给模型（`stringifyToolResultOutput` 的失败分支），`detail` 与
  `context` 都到不了模型面——**连 `agentId` 都没有**，父代理想续跑也无处可发。因此：
  runner 在前台 catch 里把 `classifySubagentFailure` + `formatSubagentFailureGuidance`
  的结果写进 CoreError 的 `context.modelGuidance`；`createErrorResult` 见到这个字段就把它
  追加到模型可见的 `modelContent`（只有显式设置才追加，其余工具逐字节不变）。这是通用能力，
  不在执行器里写子代理特判。

- **D4c 冷恢复的第三条路径同样必须带句柄。** 前两条路径（后台通知、前台失败回执）只覆盖
  「子代理在本进程内走到终态」；用户中断后重新打开会话时走的是第三条：`resumeFromStore` →
  `hydrateMessageHistoryFromSession` 把 pending/running 状态的 tool part 统一浇成
  `[Tool execution was interrupted before resume]`（`session-history-hydrator.ts`）。
  这句话没有 `agentId`、没有失败类型、没有任何下一步，**父代理手里只剩「重开」这一个选项**——
  而子代理的 `agentId` 就在同一份持久化数据里（`runtime/subagent_lifecycle` entry 的
  `agentId` / `childSessionId`），会话重新接管后 `SendMessage(agent_*)` 走
  `resumeTerminalAgentInBackground` 用同一子会话续跑。因此：hydration 的中断分支对
  Agent 派发工具必须把句柄写回模型面。

  与 D4b 的分工：D4b 是「失败现场知道分类」，这里**不知道**——中断没有 provider 错误链
  可读，`classifySubagentFailure` 拿不到事实。所以这里给的是句柄 + 条件式判据（D4 的
  `unknown` 档姿态），不编造失败类型。

- **D5 续跑的消息内容由父代理写，且必须包含判断。** 复用 `SendMessage(agent_*)`：
  终态走 `resumeTerminalAgentInBackground`，消息以 `coordinator` 身份 steer 进新轮的输入
  （`message-steering.ts` 的 guide 投递），子会话 `resumeFromStore` 恢复历史。因此父代理写的
  那句消息就是子代理续跑时看到的全部意图——必须说清「做到哪了、还差什么、别再做什么」，
  而不是「继续」。这一点必须在 SendMessage 描述里写成硬约束。
- **D6 反重开的不变式表述为「同 prompt 不重开」。** 只有在父代理自己改变了任务范围（不是子代理
  的问题，是需求变了）时才允许新派发；且新派发前要先停掉旧的（`TaskStop`），否则两份工作并发。
- **D7 golden 逐字约束。** Agent 与 SendMessage 的 provider 描述已有 golden 测试
  （`core/tests/tool-contracts.test.ts` 的 `SOURCE_DERIVED_*`），本轮改动必须同步更新那份
  golden——它就是「两处同口径」的机械化守卫。
- **D8 `stopped` 必须说清「谁停的」，因为这个事实在运行时是已知的。** `local_agent` 进入
  `stopped` 只有三条真实路径，每条都知道发起方：

  | 路径                           | 发起方       | 依据                                                    |
  | ------------------------------ | ------------ | ------------------------------------------------------- |
  | 模型调 `TaskStop`              | `"model"`    | `task-stop.ts` 显式传 `initiator: "model"`              |
  | 用户点 GUI / 面板 / 远端的停止 | `"user"`     | `runtime.cancelBackgroundTask` 的唯一调用者就是用户的手 |
  | rewind 丢弃分支时的清扫        | 不填（系统） | `cancelRemovedBranchBackgroundTasks` 不传发起方         |

  运行时层早已有 `RuntimeBackgroundStopOptions.initiator`（workflow 分支据此措辞），缺口只在
  `stopLocalAgentBackgroundTask` 没把它转交给 `subagentPort.stopTask`。因此不是「加一个新事实」，
  而是把已有事实接到通知上：`SubagentStopOptions.initiator` → registry 的 `stopInitiator` →
  终态通知。三档动作：
  - `user`：这是一个决定，不是故障；不要续跑、不要重派，除非用户开口；
  - `model`：是你自己停的，不是失败；要它继续就续跑，范围变了就按新范围重派；
  - 未填（系统）：分支已被丢弃之类的系统清扫，**不要续跑**——它的工作属于一个已不存在的分支。

  没有发起方的中性文案（「除非你确认不是用户停的」）被否决：它把运行时已经知道的事实又交回
  给模型猜，而模型没有判断依据，只会两种错法——对用户刚停的代理续跑，或对系统清扫的代理
  重派。

## 行为

### 1. Agent 工具描述（`buildAgentProviderDescription`）

在既有 bullet 之后追加一段 `## Continuing an agent`，**只留两条**：

- 终态子代理不是没了：`SendMessage` 到它的 `agentId` 会用同一会话续跑，上下文都在；
  优先续跑，只有范围变了才新派发，并且先停掉旧的；
- 失败回执与完成通知都会给出失败类型与 `agentId`，按它们的 `<next-steps>` 做。

具体分类处置不写在这里——那是失败现场才知道的事实，写在回执里（见 §4）。两条都对应父代理
手里已有的字段（`agentId`、`<next-steps>`），不引入新概念。

### 2. SendMessage 工具描述（`SEND_MESSAGE_PROVIDER_DESCRIPTION`）

在 `agent_*` 那条 recipient 行之后追加一段 `## Resuming a finished agent`，**只留一条**：

- 续跑的子代理保留全部历史，但只看得到这条消息：写清它已覆盖什么、还差什么、不要再做什么；
  只写「continue」是浪费这次续跑。

三态（steered / queued / resumed）在描述上半部分已经讲过，不再重复。

### 3. Session guidance 段（`buildSessionGuidanceSection`）

把 `tools.has("Agent")` 那一段从注释里恢复成真实输出，但只留**一句指针**：

- 子代理默认后台运行；终态子代理可用 `SendMessage` 到它的 `agentId` 续跑，优先续跑而不是重派。

机制细节归工具描述，动作归 `<next-steps>`，这里不复述。不复用上游那句
「spawn Agent with subagent_type=Explore」——本仓库默认类型是 `general-purpose`，那是错指引。
门仍是 `tools.has("Agent")`（子代理 runtime 不注册 Agent，故不会注入这段）。

### 4. 终态通知与前台失败回执的自愈指引

**后台**：在既有 `<summary>` 之后、`</task-notification>` 之前追加 `<next-steps>`，按 status 分三支：

- **completed 且 result 为空**（`result?.trim() === ""` 或全空白）：
  `This agent did the work but its final message was lost; do not re-dispatch the same task. SendMessage to its agentId to have it finish and report — say what it already covered and what is still missing.`
  并在 summary 里补一句同义短句（父代理可能只读 summary 一行）。
- **failed**：失败现场用 `classifySubagentFailure(error)` 现算分类（通知本身只拿得到字符串，
  拿不到 error 对象），按五档给动作，并把 `reason` / `retryable` / `statusCode` 如实写进
  文案（`Failure kind: transient provider error (server_error, retryable, HTTP 503)`）。
  没有分类时退回条件式文案。
- **stopped**：按发起方（D8）分三支，且 summary 同一句话里点名发起方
  （`… stopped by the user.` / `… stopped by you (TaskStop).` / `… was stopped by the system.`）：
  - `user`：`The user stopped this agent on purpose. That is a decision, not a failure: do not resume it and do not dispatch a replacement unless the user asks you to.`
  - `model`：`You stopped this agent with TaskStop, so it did not fail. Resume it with SendMessage to its agentId if it should keep working, or dispatch a new agent if the scope changed.`
  - 未填（系统）：`This agent was stopped by the system, not by you and not by the user — for example because its conversation branch was discarded. Do not resume it or dispatch a replacement for that branch.`
- completed 且 result 非空：不加。

`<next-steps>` 是新增节，放在 `</task-notification>` **之前**（与 result/error 同层），
不进 `<usage>` 之后——usage 之后的位置留给 workflow 的呈现指引，local_agent 不产生歧义即可。
所有新增文案只走 `formatLocalAgentTaskNotification` 一支，不影响 bash / workflow 通知。
文本仍受 `truncateTaskNotification` 的 120k 上限约束。

**前台**：失败抛 CoreError 时挂 `context.modelGuidance`，由 `createErrorResult` 追加到模型面
（见 D4b）。内容与后台同源，都由 `formatSubagentFailureGuidance` 生成，只是多带一句
「工具结果里没有 agentId，所以这里给你」的语义。

### 5. 冷恢复的中断 tool result（D4c）

`hydrateMessageHistoryFromSession` 的中断分支当前对所有工具一视同仁地写
`[Tool execution was interrupted before resume]`。Agent 派发工具（`Agent` 与其兼容别名
`Task`，判据用 `isSubagentDispatchToolName`）在这里改写为带句柄的版本：

- **句柄来源**：hydration 调用方传入可选的 `subagentHandles`（`Map<parentToolCallId, agentId>`），
  由 `resumeFromStore` 从父会话的 `runtime/subagent_lifecycle` entry 读出后传入。hydration
  自身不读存储——它只消费调用方给的事实，保持纯函数与可测性。
- **寻址**：tool part 的 `state.input` 里没有 agentId（那是模型的入参），所以**不能**从
  part 自身反推。用 `callID` 反查：spawn 事件 payload 带 `parentToolCallId`，而它正是父侧
  那次派发的工具调用 id，与 tool part 的 `callID` 同一个值。
- **文案**：句柄一定给（`SendMessage with to: '<agentId>'`），动作给条件式判据——与 D4 的
  `unknown` 档同姿态：如果它中断的是已做完的工作就续跑，否则收窄范围重派。不声称知道失败
  类型（中断没有错误链可读）。
- **取不到句柄时**（旧会话、entry 缺失、宿主无持久化）保持原文案不变，不猜、不编 id。

其余工具（Read / Bash / MCP …）的文案**逐字节不变**——它们本来就没有「续跑」这回事。

## 所有权与不变式

- **口径唯一来源**：续跑语义的表述分布在 Agent 描述、SendMessage 描述、Session guidance 三处，
  但它们描述的是同一条运行时事实（`runner.ts` 的 `sendMessageToLocalAgent` 三态）。三处按 D1b
  分工，不得把分类与动作再抄回去；golden 测试保证前两处不漂移，guidance 段由本 spec 的用例
  保证存在，单条指引长度由 D1b 的预算用例兜住。
- **D4c 冷恢复路径的句柄来自 lifecycle entry，不来自 tool part。** tool part 的 `state.input`
  是模型入参（description/prompt/subagent_type/wait/model），结构上没有 agentId；句柄只能从
  父会话的 `runtime/subagent_lifecycle` entry 读。hydration 因此接受调用方传入的句柄表，
  自己不碰存储。表的键是 `parentToolCallId`（spawn 事件 payload 的字段），值与 tool part 的
  `callID` 同一个。
- **不新增发送通道**：续跑只经 `SendMessage(agent_*)`，不为「自愈」新增自动化重试。
  runner 的重试/看门狗保持不变。
- **不碰终态所有权**：通知的 `notified` 幂等闸、复活时的 `notified: false` 重置、
  `isSupersededTaskNotificationRuntimeCommand` 的消解规则全部不变——新增的 `<next-steps>`
  只是文案，不参与消解判定（无 `taskId` 语义变化）。
- **不构造失败分类真相**：分类只读 adapter 写进错误链的 `reason` / `retryable` /
  `statusCode`，读不到就落 `unknown` 并给条件式判据；不根据文案关键词猜、不新增
  contracts schema 字段。
- **停止发起方的写入顺序**：`stopInitiator` 必须在铸造终态快照**之前**写进 registry——
  通知是在 `finalizeBackgroundStopped` 里现铸的，registry 是两者之间唯一的共享状态
  （与 `background-stop-dynamic-workflow.ts` 同一理由）。续跑注册的是全新快照
  （`createRuntimeTaskSnapshot`），不继承上一条命的 `stopInitiator`，因此「上一轮被用户停」
  不会污染下一轮的系统清扫。
- **不改停止判定**：`stopped` 仍由 `stopTask` 单点落定，`initiator` 只影响文案，
  不参与任何分支判定或权限判断。
- **空 result 的真实成因不在本 spec 修复**：那是 `modelResponse` 为空（provider 截断）的展示面
  问题，本 spec 只保证父代理拿到一句「这是丢了结论、去续跑」。

## 失败语义

- 通知截断（120k）优先沿用既有顺序：`<next-steps>` 与 result/error 同层，被截断时父代理至少
  还有 `<status>` 与 summary；summary 里那句同义短句就是为这种情况准备的冗余。
- `SendMessage` 对已驱逐的终态任务返回明确失败（`No active local_agent task found for target`），
  父代理据此改走 `ListAgents` 的 history 行（`sess_subagent_*`）或新派发——这是既有行为，
  不在本 spec 改。
- 续跑本身失败（profile 缺失、子会话构造失败）由既有路径还原旧 snapshot 并回fail，
  父代理看到的是失败回执，不是假成功。

## 迁移边界

- 不改 `SendMessage` 的输出 schema、不改 `TaskNotification` 的 XML schema（新增的
  `<next-steps>` 是 local_agent 分支内的字符串节，UI 只读 result/summary，不受影响）。
- 不改 runner 的三态分派、不改 ready gate、不改 Seat Gate。
- 不改 workflow / bash 的通知文案。
- hydration 的 `subagentHandles` 是**可选入参**：旧调用方（rewind 重建分支）不传即维持现状，
  不构成行为回归。
- 遗留（有意不做）：通知不带结构化失败分类字段；空 result 的成因（provider 截断）未根治；
  跨进程重启后 `agent_*` 寻址仍不可用（只用 `sess_subagent_*`）；`stopped` 只有 `user` /
  `model` / 系统三档，**没有 `parent` 档**——父代理停子代理只经 `TaskStop`，与模型自己停是
  同一只手，硬分出来是伪区分。
- 遗留（D4c 有意不做）：**同进程内中断不经过 hydration**——那一次的工具结果由 executor 的
  cancel 路径落成 error，模型当场就能读到 `Failure kind: cancelled …` 与 agentId（D4b 已覆盖）。
  D4c 只补「会话重新打开后模型面只剩一句泛化文案」这个缺口。

## 验收场景

- A1 一个子代理 315 次工具调用后空 result：通知含 `<next-steps>` 续跑指引、summary 含同义短句，
  且**不含**任何「重新派发」的字样；Agent 描述与 SendMessage 描述里都能找到续跑优先的规则。
- A2 failed 通知带分类：`transient` 明说「provider 请求失败、不是 agent 的活失败」并给出
  `agentId`；`configuration` 明说「续跑会撞同一堵墙」；无分类时退回条件式判据，且不声称
  自己能判断成因。
- A3 **冷恢复**：会话带着一个 pending 的 Agent tool part 重新打开，hydration 后的 provider
  历史里该 tool result 含 `SendMessage with to: '<agentId>'` 与条件式续跑判据，且**不含**
  「重新派发」字样；同一份历史里的 Read / Bash 中断 tool result 仍是
  `[Tool execution was interrupted before resume]` 逐字节不变。
- A4 句柄缺席（旧会话没有 lifecycle entry）时，Agent 的中断 tool result 退回原文案，
  不出现编造的 agentId。
- A2b 前台失败的工具结果里同时出现根因文案、`Failure kind: …` 与 `SendMessage with to: 'agent_x'`
  ——父代理不再因为拿不到句柄而只能重开。
- A2c 分类来自错误链：wrapper → cause 两层时仍能读出 `server_error` / `retryable`。
- A2d 意外中断按真实成因分类：看门狗无活动 → `Failure kind: inactivity timeout (no activity
for Nms)` 且**不出现**「provider 请求失败」；父轮取消（`turn_cancelled` / `tool_cancelled`）
  → `Failure kind: cancelled`；上下文超窗 → `configuration`。默认的 `retryable: false`
  不出现在文案里。
- A3 stopped 通知按发起方分三档：`user` 明说「用户的决定、不要续跑/重派」；`model` 明说
  「你自己停的、不是失败」并给出续跑与改范围重派两条路；未填（系统）明说「系统停的、
  不要续跑」——三档都不得出现「如果还想要就续跑」这类交给模型猜的措辞。
- A3b 发起方来自调用链：`TaskStop` → `stopLocalAgentBackgroundTask` → `stopTask` 的
  `initiator` 在 registry 的 `stopInitiator` 上可见，并原样出现在终态通知里；
  GUI 的 `cancelBackgroundTask` 得到 `user`；rewind 清扫得到未填。
- A3c 续跑不继承旧发起方：被用户停掉的代理经 `SendMessage` 续跑后，再被系统清扫时通知
  说的是「系统停的」，而不是沿用上一命的 `user`。
- A3d 常驻表述预算：三处合计约 350 tokens 以内，单条失败/停止指引 240 字符以内。
- A4 completed 且 result 非空：不加 `<next-steps>`（不打扰正常收尾）。
- A5 `buildSessionGuidanceSection` 在工具表含 Agent 时输出那句指针（终态可续跑、优先续跑
  而不是重派）；不含 Agent 时仍返回 null。
- A6 golden：`core/tests/tool-contracts.test.ts` 的两份逐字断言与源一致（跑测试保证）。
