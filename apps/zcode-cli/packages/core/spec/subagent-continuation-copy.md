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
- **D2 续跑语义写成三句可执行规则，而不是一段散文。** 判据是父代理手里已有的三个字段：
  通知的 `agent-id`、`status`、`<usage>` 里的 `tool_uses` / `subagent_tokens`。规则：
  「终态即可续跑」；「有 usage 说明它做过工，先续跑」；「续跑也要像重派一样给判断，不是空喊 continue」。
- **D3 空 result 是「丢了结论」，不是「没干活」。** 通知侧为 completed ∧ 空 result 增加一句
  明示（见 D5），父侧规则写明这种情形首选续跑。空 result 的真实成因是 `modelResponse` 为空
  （`turn-model-step.ts` 的 `state.modelResponse = result.text`，provider 截断时不置位），
  与看门狗超时、provider 失败是不同形态——但父代理不需要区分成因，处置动作相同：续跑。
- **D4 失败分类只用 adapter 已经给出的三个事实，不新造 taxonomy。** 分类输入是
  `projectExecutionErrorPayload(error).attribution` 里的 `reason` / `retryable` / `statusCode`
  ——它们由 `toAdapterError` 在归一化边界写进错误链，本来就存在，只是此前没有任何一处
  把它们转成父代理能执行的动作。输出只有四档（`transient` / `configuration` / `cancelled` /
  `unknown`），每档一句话动作：
  - `transient`（adapter 标 retryable，或 reason ∈ rate_limited / provider_overloaded /
    server_error / network_error / timeout / stream_idle_timeout / stale_connection /
    proxy_error / offpeak_queued）：任务本身没失败，续跑；
  - `configuration`（auth_failed / provider_not_configured / invalid_request /
    context_exceeded / tls_error）：续跑会撞同一堵墙，修配置或问用户，别重派；
  - `cancelled`：是被停掉的，不是坏掉的；
  - `unknown`：给条件式判据，不假装知道成因。

  `context_exceeded` 刻意归 `configuration` 而不是 `transient`：续跑会立刻再次超窗，
  正确动作是收窄范围，不是「再试一次」。

- **D4b 前台与后台两条失败路径必须同口径。** 前台 Agent 调用失败时抛 CoreError，工具结果
  只把根因 `message` 交给模型（`stringifyToolResultOutput` 的失败分支），`detail` 与
  `context` 都到不了模型面——**连 `agentId` 都没有**，父代理想续跑也无处可发。因此：
  runner 在前台 catch 里把 `classifySubagentFailure` + `formatSubagentFailureGuidance`
  的结果写进 CoreError 的 `context.modelGuidance`；`createErrorResult` 见到这个字段就把它
  追加到模型可见的 `modelContent`（只有显式设置才追加，其余工具逐字节不变）。这是通用能力，
  不在执行器里写子代理特判。

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

## 行为

### 1. Agent 工具描述（`buildAgentProviderDescription`）

在既有 bullet 之后追加一段 `## Continuing an agent`（标题与措辞见实现，要点固定为三条）：

- 一个子代理进入终态后**不要重新派发同样的任务**：`SendMessage` 到它的 `agentId` 会用同一个
  会话续跑，它此前的工具结果与上下文都还在，成本远低于重开；
- 若通知给出了 `tool_uses` 或 `subagent_tokens`，说明它已经做过工，默认续跑；
- 只有你改变了任务范围时才新派发，并且先 `TaskStop` 停掉旧的那个；
- 前台失败的错误文本会给出失败类型与 `agentId`：`transient` 就续跑，`configuration`
  就别重试。

同时把「默认后台派发」那条里已经写过的 `SendMessage` 指引保持原样（不重复、不改写），
只在这一段把「续跑」与「重开」的取舍讲清楚。

### 2. SendMessage 工具描述（`SEND_MESSAGE_PROVIDER_DESCRIPTION`）

在 `agent_*` 那条 recipient 行之后追加一段 `## Resuming a finished agent`：

- 对已终态的子代理，本条消息就是它续跑时读到的**唯一**指令——它带着全部历史，但不知道你
  现在想要什么。写清：它已经做到哪（通知的 result/error 结尾）、还差什么、哪些不要再做；
- 不要写「continue」这类空指令；
- 回执里会说明它是 resumed 还是 steered；resumed 之后等它的完成通知，不要重复派发。

### 3. Session guidance 段（`buildSessionGuidanceSection`）

把 `tools.has("Agent")` 那一段从注释里恢复成真实输出，但内容按本 fork 的口径重写（不复用上游
那句「spawn Agent with subagent_type=Explore for broad codebase exploration」——本仓库默认类型是
`general-purpose`，写 Explore 是错指引）。固定三条：

1. 派发即句柄：默认后台，结果经完成通知回来，前台等待用 `TaskOutput`；
2. 终态子代理优先用 `SendMessage(agentId)` 续跑，不重开同样任务的子代理；
3. 并口派发时一条消息里多个工具调用并行发出，且各管互不重叠的范围。

门仍是 `tools.has("Agent")`（子代理 runtime 不注册 Agent，故不会注入这段）。

### 4. 终态通知与前台失败回执的自愈指引

**后台**：在既有 `<summary>` 之后、`</task-notification>` 之前追加 `<next-steps>`，按 status 分三支：

- **completed 且 result 为空**（`result?.trim() === ""` 或全空白）：
  `This agent did the work but its final message was lost; do not re-dispatch the same task. SendMessage to its agentId to have it finish and report — say what it already covered and what is still missing.`
  并在 summary 里补一句同义短句（父代理可能只读 summary 一行）。
- **failed**：失败现场用 `classifySubagentFailure(error)` 现算分类（通知本身只拿得到字符串，
  拿不到 error 对象），按四档给动作，并把 `reason` / `retryable` / `statusCode` 如实写进
  文案（`Failure kind: transient provider error (server_error, retryable, HTTP 503)`）。
  没有分类时退回条件式文案。
- **stopped**：`This agent was stopped; resume it with SendMessage to its agentId if the work is still wanted.`
- completed 且 result 非空：不加。

`<next-steps>` 是新增节，放在 `</task-notification>` **之前**（与 result/error 同层），
不进 `<usage>` 之后——usage 之后的位置留给 workflow 的呈现指引，local_agent 不产生歧义即可。
所有新增文案只走 `formatLocalAgentTaskNotification` 一支，不影响 bash / workflow 通知。
文本仍受 `truncateTaskNotification` 的 120k 上限约束。

**前台**：失败抛 CoreError 时挂 `context.modelGuidance`，由 `createErrorResult` 追加到模型面
（见 D4b）。内容与后台同源，都由 `formatSubagentFailureGuidance` 生成，只是多带一句
「工具结果里没有 agentId，所以这里给你」的语义。

## 所有权与不变式

- **口径唯一来源**：续跑语义的表述分布在 Agent 描述、SendMessage 描述、Session guidance 三处，
  但它们描述的是同一条运行时事实（`runner.ts` 的 `sendMessageToLocalAgent` 三态）。任何一处
  改动都要同时看另外两处；golden 测试保证前两处不漂移，guidance 段由本 spec 的用例保证存在。
- **不新增发送通道**：续跑只经 `SendMessage(agent_*)`，不为「自愈」新增自动化重试。
  runner 的重试/看门狗保持不变。
- **不碰终态所有权**：通知的 `notified` 幂等闸、复活时的 `notified: false` 重置、
  `isSupersededTaskNotificationRuntimeCommand` 的消解规则全部不变——新增的 `<next-steps>`
  只是文案，不参与消解判定（无 `taskId` 语义变化）。
- **不构造失败分类真相**：分类只读 adapter 写进错误链的 `reason` / `retryable` /
  `statusCode`，读不到就落 `unknown` 并给条件式判据；不根据文案关键词猜、不新增
  contracts schema 字段。
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
- 遗留（有意不做）：通知不带结构化失败分类字段；空 result 的成因（provider 截断）未根治；
  跨进程重启后 `agent_*` 寻址仍不可用（只用 `sess_subagent_*`）。

## 验收场景

- A1 一个子代理 315 次工具调用后空 result：通知含 `<next-steps>` 续跑指引、summary 含同义短句，
  且**不含**任何「重新派发」的字样；Agent 描述与 SendMessage 描述里都能找到续跑优先的规则。
- A2 failed 通知带分类：`transient` 明说「任务没失败、续跑」并给出 `agentId`；`configuration`
  明说「续跑会撞同一堵墙」；无分类时退回条件式判据，且不声称自己能判断成因。
- A2b 前台失败的工具结果里同时出现根因文案、`Failure kind: …` 与 `SendMessage with to: 'agent_x'`
  ——父代理不再因为拿不到句柄而只能重开。
- A2c 分类来自错误链：wrapper → cause 两层时仍能读出 `server_error` / `retryable`。
- A3 stopped 通知指引用 SendMessage 续跑。
- A4 completed 且 result 非空：不加 `<next-steps>`（不打扰正常收尾）。
- A5 `buildSessionGuidanceSection` 在工具表含 Agent 时输出三段协作规则；不含 Agent 时仍返回 null。
- A6 golden：`core/tests/tool-contracts.test.ts` 的两份逐字断言与源一致（跑测试保证）。
