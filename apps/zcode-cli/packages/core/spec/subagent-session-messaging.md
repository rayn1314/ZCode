# 子代理与会话的统一消息协作（派发即句柄 / 跨会话投递 / 身份区分）

涉及包：`contracts`（工具 schema、`SessionMailboxPort`、`SessionMessagePort`）、`adapters`（mailbox 写侧）、`core`（本 spec 主责：Agent 语义、`ListAgents`、`SendMessage`、注入与消费）、`bootstrap`（`SessionMessagePort` 实现、v4 写路径、冷恢复）、`packages/services`（`deliverSessionMessage`）、`packages/desktop`（main 路由与 host 消费、producer 接线）、`packages/shared`（协议帧与载荷 schema）、`packages/ui`（按输出 status 判定的读取面）。

对标：OpenAI Codex 的 multi-agent v2 协作面（`spawn_agent` 立即返回句柄、`send_message`/`followup_task` 双语义、`list_agents`、agent message board）。本 spec 只取其中与本仓库现有能力缺口对应的部分，不引入消息板（channel/thread/post/subscription）。

> **后续变更（未落地）**：子代理会话正被改造为「一等会话」——由与正式会话同一条构造路径创建、可输入、可续聊、列表按父会话层级展示（`subagent-session-as-first-class.md`）。本文 D2 的寻址约定（一律用 `sess_*` 主键、不按 title/alias 解析）不变；D8 末条「历史行只能用 `childSessionId` 走跨会话路径」的结论会随输入面开放扩展为「可投递、可输入」。本文 D1、D3–D7 继续有效。（注意：本文原文并未声明「子代理会话只读」——那是实现侧 `guard.subagentReadOnly` 的现状，不是本文的决策。）

## 背景与问题

ZCode 已有子代理能力，但协作体验与 Codex 差距集中在四点：

1. **派发拿不到句柄**。前台 `Agent` 调用阻塞到子代理完成，工具结果里才带 `agentId`（`contracts/src/tools/agent.ts:44-55` 的 `AgentCompletedOutput`）。子代理一旦跑偏或卡住，父代理在它完成前没有任何手段介入。
2. **跨会话只有读没有写**。`SessionMailboxPort` 只有 `drainUnread`（`contracts/src/interfaces/session-mailbox.port.ts`），全仓库没有任何写 `unread/` 的代码；desktop 的投递链路管道（`packages/shared/src/channels.ts` 的 `SessionMessageDeliver` 等、`packages/desktop/src/main/taskRealtimeBus.ts:920`）铺好了，但末端 `zcodeTaskServiceAdapter.deliverSessionMessage` 是 `unsupported()`；`workspace_session_message_send_requested` 事件没有任何生产者；`forwardSessionMessageSendRequested` 是死参数。
3. **没有子代理列表**。模型侧没有 `ListAgents` 类工具；`subagent-session-query.ts` 的投影只服务 UI/TUI。
4. **子代理只能单向回父**。子代理运行时的工具面只有 `RespondToCoordinator`（`core/src/runtime/helpers/runtime-tools.ts:55-56` 的门），且子运行时的依赖注入里没有任何"进程级会话分发能力"。

机制上的根因：**工具结果只能返回一次**。只要前台 `Agent` 阻塞到完成，中间就永远不可能把 `agentId` 交给父代理；而"运行中发消息"要求父代理先拿到句柄。因此第 1 点与第 2 点是同一个约束的两面——必须先让 spawn 立即返回句柄。

第二个根因：**core 侧无法触达别的会话 runtime**。`create-app.ts` 每会话创建一个 `AgentRuntime`，进程内 `sessionId → record` 的映射只存在于 bootstrap 协议层的 `context.sessions`（`bootstrap/src/zcode-protocol/server-types.ts:153`）；core 里没有 session 级注册表（`bootstrap/src/app/dynamic-workflow-run-progress-sink.ts:40-41` 的注释已点明）。所以跨会话投递**必须由 bootstrap 提供端口**，core 只依赖端口。

## 设计决策

### D1 · Agent 默认"派发即句柄"，`wait: true` 保留同步

- `AgentInputSchema` 以 `wait?: boolean`（默认 `false`）取代 `run_in_background`。默认路径复用现成的后台启动链路（`core/src/subagent/runner.ts` 的 `start()`），只等"子会话持久化完成"（ready gate）就返回 `async_launched`，不等任何模型调用。
- `wait: true` 走原前台 `run()` 路径，保留"同步拿正文"的旧语义，供一次性委派/并行 fan-out 等既有用法与提示词过渡。
- `autoBackgroundMs`（`runner.ts` 的 `createAutoBackgroundTimer`）原样保留，只作用于 `wait: true` 路径，作为"等太久就交出句柄"的安全网。
- `run_in_background` 字段删除。`AgentInputSchema` 非 `.strict()`，历史里残留的该键会被静默剥离；读取面（UI/TUI/查询投影）改为按输出 `status` 判定，不再读输入字段。
- `modelOverride.background === "deny"`（闲时轮借用前台模型）下，后台不可用。分两种情形，都不静默丢失请求：
  - **profile 显式声明 `background: true`**：与闲时轮硬冲突，保持原 `BACKGROUND_UNAVAILABLE` 错误（不把显式配置静默改写成前台）。
  - **默认路径**（`wait` 缺省，后台来自新默认值）：`wait: true` 本就无后台请求，行为不变；默认路径降级为前台执行，并把降级如实写进结果正文与 `warn` 日志（否则闲时每一发 Agent 都会失败）。

### D2 · 统一寻址 `sess_*`

子代理的 `childSessionId` 本就是 `sess_subagent_<agentId>`（`core/src/subagent/runner.ts:806-807`），与正式会话 `sess_*` 同构。`SendMessage` 的 `to` 接受：

- `agent_*`：本会话注册表内的子代理（等价于其 `childSessionId` 的便捷别名），走既有子代理投递；
- `sess_*`：任意会话，走新的跨会话投递端口。

不新增按 title/alias 解析会话的服务：`ListSessionsInput` 没有 title/parentID 谓词，title 可变且可重名；会话寻址一律用 `sess_*` 主键（与 `ReadSessionContext` 的既有约定一致）。

### D3 · 投递 owner 是 bootstrap 的 `SessionMessagePort`

新增 `contracts/src/interfaces/session-message.port.ts`，由 bootstrap 实现并注入每个 runtime（父与子都注入）。投递按可达性分三档，**单一 owner、单条写路径**：

1. **本进程且目标常驻**（`context.sessions` 有 record）：
   - 目标有活动回合 → `sendText`，`requestedDelivery: "guide"`（等价于现有 `steerTurn({delivery:"guide"})` 的注入点）；
   - 目标空闲 → `sendText`，`requestedDelivery: "startNow"`（开新一轮，即"唤醒"）。
2. **本进程但目标已冷**（被 `SessionResidentPool` 卸载）：先 `coldResume.ensureResumed` 拉起 record，再按 1 投递。
3. **目标不在本进程**（别的 workspace/进程）：写 mailbox（`deliver`）+ 发 workspace 事件，交给 desktop main 路由到目标 host 的 `deliverSessionMessage`；目标仍不可达时只留 mailbox，等其下次自醒 `drainUnread`。

投递走 v4 写路径（而非直接 `record.app.runtime.steerTurn`），以获得 CommandInbox 幂等、revision 门、投影与 queue/guide 语义，避免第二条写路径。**不直接调 `steerTurn` 做唤醒**：`steering.ts` 对无活动回合一律 `no_active_turn`，唤醒只能靠 `sendText(start_turn)`。

### D4 · 身份模型（独立 vs 附属）

消息信封与注入格式携带来源身份：

- `fromSessionId`：发送方会话 id（正式会话 `sess_*`；子代理 `sess_subagent_*`）；
- `senderKind`：`"session"`（独立身份）或 `"subagent"`（附属身份）。

接收侧 `<session-message>` 注入文本增加 `sender_kind` 属性。子代理**可以**发给任意会话（含正式会话），其消息按附属身份标注；`workflow_child` 等受限会话继续走既有 denylist（`bootstrap/src/app/workflow-actor-tools.ts`）。防环见 D7。

### D5 · 树内通路保留

子代理 → 父的 `RespondToCoordinator` 继续存在并保留 `coordinatorAttention`（`released`/`busy`）语义——它承担"释放前台等待"的防死锁职责（见 `core/spec/subagent-foreground-response.md`）。子代理另外获得通用 `SendMessage`，用于树外或任意会话。两者不是重复路径：前者是带协调者注意力的结构化回复，后者是通用投递。

### D6 · `Agent` 传 `model`（可选，阶段 4）

照 `CreateWorkflow` 的 `subagent_model` 先例：在 `resolveInput` 阶段用 `modelCatalogPort` 解析成规范形，解不开即业务失败；插进 `resolveSubagentSelection` 的解析顺序（`override(turn) ≥ 调用级 > profile > 父模型`）；**只活一次、不回写任何配置**——这是当年移除该字段的原因，规范化为"本次 spawn 的一次性请求"即可规避历史回放覆盖配置的问题。后台/复活路径当前拿不到调用级 override，此不对称在工具描述与本节明说。

### D7 · 防环：链深随消息携带，cap 由发送侧端口裁决（阶段 5）

两个会话互相回信没有终止条件，这是本能力唯一的系统性风险。设计要点：

- **链身份随消息走，投递层不做任何记账。** 每条会话消息可携带 `chain = { originMessageId, hop }`：`originMessageId` 是链首消息 id，`hop` 是它在链上的深度（链首为 1）。投递层不维护"上一条是谁发的"这类状态，因此不存在多写者与过期判断。
- **发送侧算，接收侧记。** `SendMessage` 发 `sess_*` 时读本会话当前入站链：`hop = 入站链.hop + 1`、`origin = 入站链.originMessageId`；没有入站链（本轮由人或内部事件触发）则 `hop = 1`、`origin` 取本次 `messageId`。
- **链必须结构化到达接收方 runtime。** live 通路（`sendText`）过去只传文本，而闭合的 payload schema 会静默剥离未知键，所以给 `sendText` payload 与 `QueueItem` 增加可选字段 `sessionMessageChain`，经 `inputIntentMetadata` 落到 `TurnInputIntentMetadata.sessionMessageChain`，core 在输入 admission 时读取。mailbox 通路直接读信封的 `chain`。两条通路在 core 汇合到同一处记录。
- **入站链的唯一持有者**是 core 的会话 runtime（`AgentRuntime` 一个私有字段）。设置点：mailbox drain（结构化信封）与 v4 intent admission（携带链时）。清除点是**精确**的而非超时：一次来自命令面的输入（`ExecuteTurnOptions.intent` 在场）若不带链，说明这是人重新开的输入，链深归零；core 内部派生的轮次（后台结果、子代理通知、hook 续跑）不带 intent，因此不会误清。mid-turn 的 `steerTurn` 只"带链则设置"，不清除——那一轮的开链/清链已由该轮 admission 决定。
- **发送侧读的是实时值，不是轮次快照**：链在本回合中途也可能被注入（guide），所以工具上下文拿到的是 reader 端口而非快照值。
- **子代理继承父会话的当前链**（spawn 时快照进子 runtime），否则"父会话收信 → 派子代理回信"会绕过计数。
- **cap 只在发送侧裁决**：`BootstrapSessionMessagePort.deliver` 是发送方进程里唯一的写侧入口（三档都经过它），`hop > SESSION_MESSAGE_MAX_HOP(=6)` 时**拒绝投递**并返回明确失败：不落盘、不唤醒、不改动目标。接收侧只如实记录与传播，不静默丢弃。
- 拒绝文案面向模型可执行，点明链首与深度，并要求"停止回信、把结论汇报给用户"。用户再说一句话即重置链深。

**为什么不在投递层记账 / 不用超时**：投递层看不到"目标会话这一轮是人触发的还是消息触发的"，只能靠时间窗口猜；core 看得到全部输入，这是唯一能精确判定链是否还在的位置。**为什么 cap 不在接收侧**：接收侧丢弃等于静默吞消息；拒绝必须发生在发送方拿得到结果的地方，才能把原因交回模型。

### D8 · `ListAgents` 跨重启：注册表是活体真相，roster 端口补历史（阶段 6）

`ListAgents` 现在只读进程内注册表，重启后为空（子会话其实还在磁盘上）。设计要点：

- **新增只读端口 `SubagentRosterPort`**（contracts），按父会话列出历史子代理；由 bootstrap 实现（它拿得到持久化 session store），core 只依赖端口。
- **数据来源是父会话自己的持久化 session entry**（`runtime/subagent_lifecycle`，id 稳定为 `subagent-lifecycle:<agentId>`）：core 的 `persistDurableSessionEvent` 在 `SubagentSpawned` / `SubagentStopped` 事件上**覆写同一行**（行数 = 派发过的子代理数），spawn 建行、stop 收口并保留首次 spawn 的 `created`/`startedAt`。给出 `agentId`、`childSessionId`、`agentType`、`description`、`isBackgrounded`、`status`（事件原词）、`startedAt`、`endedAt`。**不读父会话事件投影**（内存 eventStore 随会话去激活清空、冷恢复不回灌），也不读父会话消息历史——列个子代理不该触发整段 transcript 的 hydrate。
- **状态语义必须诚实**：entry 带终态 → 映射为终态（`success → completed` 等）；只有 spawn 没有终态 → 报 `lost`（进程重启后那个 runtime 已经不存在了），**不得报 `running`**——`running` 只能由本进程注册表断言。**同一事实两种来源必须同词**：后台被 TaskStop 时活体注册表报 `killed`（`runner.ts` 的 `BACKGROUND_AGENT_STOPPED_STATE.registryStatus`），事件只带 `stopped`，故 entry 路径把 `stopped` 也归一到 `killed`。
- **合并语义**：注册表条目优先（实时状态与 `isBackgrounded` 更准），roster 补注册表缺的条目，按 `agentId` 去重；每行标注 `source: "live" | "history"`，模型据此知道哪些能用 `agent_*` 寻址、哪些只能用 `childSessionId`（`sess_subagent_*`）走跨会话路径。
- 重启后 `agent_*` 寻址不可用是既有行为（内存注册表为空），不在本轮改成持久寻址；输出里的 `childSessionId` 就是给这种情况用的寻址键。

## 架构与投递拓扑

```
父会话 runtime (sess_A)
  Agent(wait:false) ─► subagentPort.start() ─► 立即返回 {agentId, childSessionId}
  SendMessage(to)
    ├─ agent_* ─► runtimeTaskRegistry(本会话子代理)
    │              ├─ 运行中+sink ─► messageSink.steer（guide，注入下一模型步）
    │              ├─ 运行中无 sink ─► registry.queueMessage（下一工具轮）
    │              └─ 终态 ─► resumeTerminalAgentInBackground（复用同一 agentId）
    └─ sess_*  ─► SessionMessagePort（bootstrap 实现）
                   ├─ 本进程常驻 ─► sendText(guide) ｜ 空闲: sendText(startNow)
                   ├─ 本进程已冷 ─► coldResume.ensureResumed ─► 同上
                   └─ 跨进程 ─► mailbox.deliver(unread/) + workspace 事件
                                 └─► desktop main(taskRealtimeBus) ─► 目标 host
                                       └─► deliverSessionMessage ─► 同本进程三档
```

## 行为

### 1. Agent spawn（阶段 1）

- 默认（`wait` 缺省或 `false`）：注册任务 → 等 ready gate → 返回 `AgentBackgroundedOutput`（`status: "async_launched"`，含 `agentId`/`childSessionId`/`backgroundTaskId`/`outputFile`）。子代理继续运行，完成时经 task-notification 回流。
- `wait: true`：阻塞到完成，返回 `AgentCompletedOutput`（现行为）。
- 模型可见文案（`formatAgentOutputForModel`）：
  - `async_launched`：明确给出 `agentId` 与 `childSessionId`，并写明"可用 `SendMessage` 继续指挥；用 `TaskOutput(task_id, block:true)` 等待结果；完成会自动通知"。
  - `completed`：保持现有"正文 + agentId + 使用提示"。
- 子代理运行时自身仍不注册 `Agent`/`Task`（不允许套娃），此约束不变。

### 2. ListAgents（阶段 1）

- 新增工具 `ListAgents`。入参可选过滤（如 `status`、`agent_type`），缺省列出本会话全部子代理。
- 输出每项：`agentId`、`childSessionId`、`agentType`、`description`、`status`、`isBackgrounded`、`startedAt`（可含 `endedAt`）。
- 数据源：`context.runtimeTaskRegistry.all()`（本会话的 `local_agent` 任务，含运行中与终态），并在注册表缺失该条目时由 `SubagentRosterPort` 补齐历史（阶段 6，见 D8）。
- 注册门：与 `includeAgent` 同门（父会话且有 subagent 端口才注册）。
- 每行带 `source: "live" | "history"`：`live` 可 `agent_*` 寻址，`history` 只能用 `childSessionId`。

### 3. SendMessage 统一寻址（阶段 2）

- `to` 为 `agent_*`：走既有 `subagentPort.sendMessage`（三态 `steered`/`queued`/`resumed_background` 不变）。
- `to` 为 `sess_*`：走 `SessionMessagePort.deliver`，结果为 `steered`（注入运行中回合）、`woken`（唤醒空闲/冷会话开新一轮）、`stored`（不可达，落盘待 drain）。
- 输出 schema 的 `delivery` 枚举增加 `woken`、`stored`。
- 对非本会话、非本进程的 `sess_*` 目标：仍尝试投递（阶段 2 限于本进程；阶段 3 打通跨进程）。失败时返回明确错误而非静默。

### 4. 子代理侧消息工具（阶段 2）

- `subagent_child` 运行时注册 `SendMessage`（`to` 支持 `sess_*`；`agent_*` 因无子代理注册表而返回明确不支持）。仍不注册 `Agent`/`Task`。
- 子代理发出消息的信封 `senderKind = "subagent"`，`fromSessionId = childSessionId`。
- `RespondToCoordinator` 保持不变，用于要求协调者注意力的结构化回复。

### 5. mailbox 写侧（阶段 2）

- `SessionMailboxPort` 增加 `deliver(envelope, opts?)`。
- 文件命名 `<零填充时间戳>_<messageId>.json`，保证字典序 = 时间序（`drainUnread` 依赖 `readdir().sort()`）；复用 `sessionDir()` 的路径穿越防护。
- 顺手修 `drainUnread`：单个损坏信封不得阻断整批（当前 `parseEnvelope` 抛错会让整次 drain 失败）。

### 6. 跨进程实时投递与唤醒（阶段 3）

- `zcodeTaskServiceAdapter.deliverSessionMessage` 实时投递统一用 `guide`，不按活动回合切换 `startNow`：`startNow` 在 CLI admission 会 `preemptActiveTurnAndWait` 抢占并中止正在跑的回合，而 Host 侧只有滞后的事件投影（`activePromptInputIds`）、无法权威确认目标空闲，误判会打断目标回合。`guide` 由目标 CLI 自己的 admission 裁决（忙且可引导 → steered；忙且不可引导 → 排队；空闲 → 开新轮），同样完成注入/唤醒且永不抢占。不可达 → 落 mailbox 并回 success（返回 `success` 只表示"已持久化"，mailbox 也写不进去才 `failed`）。
- `sendSessionMessageDeliveryResult` 把回执投回源会话：**仅当源会话有活动回合时才用 `guide` 注入**；源会话空闲（或不在本 Host）时不投递，跳过并记 `info` 日志。回执是补充通知而非用户输入——发送侧工具（`SendMessage`）本身已同步拿到投递结果，回执只让源会话在后续回合里顺带知道"已送达"。当前 v4 admission 没有"只追加不唤醒"的投递位（空闲会话无论 `guide`/`queue` 都会开新一轮），唤醒空闲源会话得不偿失（用户可能并不在场，凭空多跑一轮），故宁少勿多。
- 触发通道：CLI 档 3 写完 mailbox 后经 v4 sideband 通知 `v4/session/message-send-requested` 上报；`zcodeAgentService` 消费后 fire `onDynamicSessionMessageSendRequested`，adapter 转 `forwardSessionMessageSendRequested` → Host `parentPort` → main 路由。该通知仅 live sideband，不进 conversation topic / 快照 / replayable，两条实时链路语义不变。
- 去重：实时命中后目标 Host 用 `SessionMessageMailboxPort.consume({sessionId, messageId})` 清掉源侧落的持久副本；消费失败只记日志（可能重复投递一次），不判交付失败。
- **开关**：消息与 mailbox 默认开启（显式 `ZCODE_MESSAGE_ENABLED=0/false` 才关闭）。
- main 路由（`taskRealtimeBus.ts`）已完整，不改；"强制唤醒从未被 announce 的会话"列为后续。

### 7. 防环（阶段 5）

- 链字段：`SessionMessageDeliveryRequest.sessionMessageChain?`、mailbox `SessionMailboxEnvelope.chain?`、v4 `sendText` payload / `QueueItem.sessionMessageChain?`、`TurnInputIntentMetadata.sessionMessageChain?`；注入文本 `<session-message>` 同时输出 `hop` 与 `origin` 属性，让模型自己也能看到链深。
- 发送：`SendMessage` 的 `sess_*` 分支从 `SessionMessageChainReader.current()` 取本会话入站链算 `hop/origin`（无链则 `hop=1`）。
- 记录：mailbox drain 与 v4 admission 两条通路都调 `AgentRuntime.noteInboundSessionMessageChain(chain)`；命令面输入不带链时清除。
- 裁决：`hop > SESSION_MESSAGE_MAX_HOP` 在 `BootstrapSessionMessagePort.deliver` 直接拒绝，返回 `failed` + 明确文案；跨进程 request/notification/main 路由原样透传 `chain`。
- 传播：目标侧 Host 注入 v4 `sendText` 时带上 `sessionMessageChain`（live）或写进 mailbox `chain`（stored），保证链在跨进程后仍然连续。

### 8. 历史子代理恢复（阶段 6）

- `SubagentRosterPort.listByParentSession(parentSessionId)`：bootstrap 读父会话持久化的 `runtime/subagent_lifecycle` session entry，按 D8 的状态语义与映射返回。
- `ListAgents` 合并 registry（优先）与 roster（补齐），按 `agentId` 去重并标注 `source`。
- 工具描述改为"本进程注册表 + 持久化历史"，并说明 `history` 条目只能用 `childSessionId` 寻址。

## 所有权与不变式

- **spawn 语义 owner**：`core/src/subagent/runner.ts`（`launch` 的分叉是唯一判据），handler 只透传 `wait`。
- **投递 owner**：`SessionMessagePort`（bootstrap 实现）。core 只依赖端口，不直接访问别会话 runtime 或 `context.sessions`。
- **单条写路径**：跨会话投递统一经 v4 `sendText`，不在 core 或 bootstrap 另造 `steerTurn` 直调。
- **订阅/唤醒不改变消息所有权**：消息始终作为目标会话的输入命令/ mailbox 信封存在，由目标会话自己的 drain/注入机制消费。
- **身份不变式**：`fromSessionId` 与 `senderKind` 由发送方 runtime 填充，接收方只读；子代理不得伪造为正式会话身份。
- **树内快速通路优先**：目标若在本会话子代理注册表内，走既有子代理投递，不经 v4 往返。
- **幂等**：跨进程投递沿用 `SessionMessageSendRequested` 的 `requestId` 去重；mailbox 信封以 `messageId` 命名，重复投递不产生重复可读消息。
- **入站链的唯一 owner**：会话 runtime 的 `inboundSessionMessageChain` 字段。写入者只有 `noteInboundSessionMessageChain`（mailbox drain 接线与 v4 intent admission 各一处）；工具侧只经 reader 读取，不得自行推导链深。
- **cap 的唯一裁决点**：`BootstrapSessionMessagePort.deliver`。接收侧（Host adapter、目标 runtime）不得因为 `hop` 大而丢消息——拒绝只发生在发送方，且必须回传原因。
- **roster 只读**：`SubagentRosterPort` 不得写任何状态，也不得成为子代理生命周期的第二个真相源；`running` 永远只能由进程内注册表断言。

## 失败语义

- 冷会话最终未能拉起（`ensureResumed` 失败）：返回 `stored`，只写 mailbox，不阻塞发送方。
- v4 投递被拒（会话不存在、revision 冲突）：降级为 mailbox `stored`，返回成功但标注实际落地方式。
- 目标 host 不在（路由缺失/超时 30s）：main 返回失败，发送方可回退 mailbox；不静默丢弃。
- mailbox 目录不可写：返回失败并明确原因，不假装成功。
- 目标会话在投递瞬间被卸载：以 revision/幂等门兜底，必要时重试一次；仍失败则落盘。
- 抄底语义：闲时轮借用前台模型时后台不可用——profile 显式后台仍抛 `BACKGROUND_UNAVAILABLE`（文案不变）；默认路径降级为前台并在结果与日志里标注，不静默。
- 链深超限：发送方拿到的是一次明确的业务失败（含链首 `messageId` 与当前 `hop`），消息不投递、不落盘、不唤醒目标；这是"拒绝"不是"降级"，不得改写成 `stored`。
- 历史子代理读取失败（session entry 读取异常）：`ListAgents` 退回只报注册表内容并在结果正文里说明历史不可读，不假装"没有历史子代理"。子代理生命周期 entry 落盘失败只 warn，不打断子代理运行。

## 迁移边界

- **破坏性**：`Agent` 默认语义由同步改为异步。必须同步更新 Agent 工具描述、系统提醒、bundled skills（如 `agent-lane-orchestrator`）中"前台同步拿结果"的用法；否则模型会把 `async_launched` 误判为失败。
- 历史会话无需迁移：旧工具调用记录里的 `run_in_background` 由读取面按输出 `status` 忽略。
- `AgentInputSchema` 保持非 strict，旧端传入的 `run_in_background` 被剥离，不报错。
- 消息开关默认值变更影响 desktop 与 CLI 子进程启动参数，需要两处同步。
- dwf（动态工作流）的 actor 通信（`submit_result`/`escalate`/ask 队列）不在本轮范围，不改。
- **闲时轮 E2E 夹具已同步**：`packages/services/src/session/offPeakMockGateway.ts` 删除了 `unexpected-background-explicit` 场景（它依赖已删除的输入字段，新契约下无法表达"调用级显式后台"）；"显式后台被拒绝"继续由 `unexpected-background-profile` 覆盖。仓库外的 E2E 断言需同步去掉该场景。

## 实施阶段

- **阶段 1（core/contracts）已落地**：Agent 默认即句柄 + `wait`；`ListAgents`；读取面改按 output.status。
- **阶段 2（core/contracts/adapters/bootstrap）已落地**：mailbox `deliver`；`SessionMessagePort` + 本进程三档投递（活动 `guide` / 空闲 `startNow` / 不可达 mailbox `stored`）；`SendMessage` 支持 `sess_*`；子代理注册 `SendMessage`；身份字段；消息开关默认开启（显式 `0`/`false` 关闭）。
- **阶段 3（services/desktop/shared）已落地**：`deliverSessionMessage` 三态 + 回执；mailbox `consume` 去重（CLI adapters 与 Host services 共 `@zcode/shared` 的落盘规则）；CLI→Host 触发通道走 v4 sideband 通知 `v4/session/message-send-requested`，Host 转 main 实时路由。
- **阶段 4（core/contracts）已落地**：`Agent` 支持调用级 `model`（`resolveInput` 用 `modelCatalogPort` 规范化、解不开即业务失败、只活一次不回写配置，优先级 `turn override > 调用级 > profile > 父模型`）。**已知不对称**：该选型只在本次前台 `run`（`wait: true` 且 profile 不强制后台）生效；后台/复活路径无选型通道，会跑在 profile/会话模型上。
- **阶段 5（contracts/shared/core/bootstrap/services/desktop）已落地**：防环链（D7）——链随消息结构化携带、接收方 runtime 记录、发送侧端口按 `SESSION_MESSAGE_MAX_HOP` 拒绝超限投递。
- **阶段 6（contracts/core/bootstrap）已落地**：`SubagentRosterPort` + `ListAgents` 合并历史（D8）。

### 阶段 3 的落地结论

跨进程（同一台机器、**不同 workspace**，即两个 CLI 进程）的实时投递链路：

- CLI 档 3（目标不在本进程）：`mailbox.deliver`（持久副本）→ `context.notify` v4 通知 `v4/session/message-send-requested`。
- Host services：`wireClient` 校验 params 后 fire `onDynamicSessionMessageSendRequested`；task adapter 转 `forwardSessionMessageSendRequested` → Host `parentPort`（`HostResponseTypes.SessionMessageSendRequested`）→ main `taskRealtimeBus` 按 `toSessionId` 路由。
- 目标 Host：`deliverSessionMessage` 用 `taskTargets` 定位目标，经 v4 `sendText(requestedDelivery: "guide")` 注入——不用 `startNow`，因为它会按可能滞后的 `activePromptInputIds` 投影误判并抢占目标正在跑的回合；`guide` 由目标 CLI admission 自行裁决注入/排队/开轮。命中后 `consume` 清掉持久副本；不可达则 `deliver` 兜底（与源侧同文件名，幂等）并回 success。
- 回执：main 把结果回传源 Host → `sendSessionMessageDeliveryResult`：源会话正在跑回合 → v4 `sendText(guide)` 注入；源会话空闲 → 直接跳过（记 `info`），不投任何回执。见"回执"决策。
- 该通知是 live sideband（`V4_NOTIFICATIONS`），不进入 conversation topic / 快照 / recovery；`zcodeAgentConnectionScope` 对任何 attachment 返回 `RpcEvent.None`，因此 `desktop-continuous` 与 `web-remote-replayable` 的既有语义不受影响。
- 覆盖范围说明：**同一 workspace 的跨会话投递不依赖本阶段**，阶段 2 的档 1/2 已覆盖。
- 已清理：`workspace_session_message_send_requested` 这条 workspace 事件消费链已确认无生产者（全仓仅有类型定义与 `host/index.ts` 的 `subscribeSessionMessageRequests` 消费侧，没有任何构造该事件或 `.fire` 的代码），已删除类型定义、`ZCodeWorkspaceEvent` 联合成员、`host/index.ts` 的 `subscribeSessionMessageRequests`/`forwardSessionMessageRequest` 及其调用点，以及只服务该链的 `hostRemoteWorkspaceProxyState.ensureWorkspaceSubscription`。CLI→Host 触发统一走 v4 sideband。跨机器（远端 workspace）的 mailbox 不共享，不在本阶段范围。

## 验收与验证

- core 单测：默认立即返回 `agentId`；`wait:true` 阻塞并返回正文；`ListAgents` 投影；`SendMessage` 目标解析（`agent_*`/`sess_*`）。
- bootstrap 集成：同进程投递（活动 → guide；空闲 → startNow 开新回合）；冷会话先 `ensureResumed`。
- services 单测：`deliverSessionMessage` 实时投递（统一 `guide`，不抢占）、不可达落 mailbox、命中后 `consume` 去重、回执投回源会话。
- 门禁：`pnpm typecheck:cli`、`pnpm lint`；触及根包补 `pnpm typecheck`。

## 遗留工作（分类）

**本轮范围内、已排期**：阶段 1、2、3、4、5、6 已全部落地（见上）。

**阶段性说明（同一 workspace 已完整可用）**：桌面里两个会话若属于同一 workspace（常见情形），它们在同一 CLI 进程内，阶段 2 的本进程三档已覆盖"发消息 + 唤醒"全链路，无需阶段 3。阶段 3 只补"不同 workspace（两个 CLI 进程）"的实时投递。

**本轮不做、需另立任务**：见文末「遗留工作评估」的 B 组（需拍板）与 C 组（工程排序）。防环与 `ListAgents` 跨重启已在阶段 5/6 落地，见 D7/D8。

**已清理**：`workspace_session_message_send_requested` 这条无生产者的 workspace 事件消费链（类型定义、`ZCodeWorkspaceEvent` 联合成员、`host/index.ts` 的 `subscribeSessionMessageRequests`/`forwardSessionMessageRequest` 及调用点、`hostRemoteWorkspaceProxyState.ensureWorkspaceSubscription`）。证明与删除见"阶段 3 的落地结论"末条。

**已决策（回执不唤醒空闲源会话）**：回执是补充通知，发送侧工具已同步拿到结果，不应唤醒空闲源会话。当前 v4 admission 没有"只追加不唤醒"的投递位（空闲会话 `queue` 也会开新一轮），可选方案 (a) 空闲时不投回执、(b) 引入真正的静默追加位。**采用 (a)**：源会话没有活动回合时直接跳过并记 `info`，只有源会话正在跑回合时用 `guide` 注入。理由与实现见 `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` 的 `deliverSessionMessageReceipt` 注释与"跨进程实时投递与唤醒（阶段 3）"。

**工程取舍（已决策，不留问题）**：D2 用 `sess_*` 主键寻址而非 title；D3 经 v4 写路径而非直调 runtime；D5 保留 `RespondToCoordinator` 而非合并；D6 只做一次性 model 请求、不做配置回写。

### 遗留工作评估（2026-10-03）

按「触发条件 / 改动面 / 需要谁决定」分三组，另附两条已决策不做。

**A. 已落地（本轮做完，仅需知悉）**

1. **跨会话消息防环**（阶段 5）—— 链随消息携带、core runtime 记录、发送侧端口按 `SESSION_MESSAGE_MAX_HOP=6` 拒绝。剩下的只是一个口径问题：cap 值是否合适（当前 6 跳，人类输入重置），要调只改 `contracts` 的一个常量。
2. **`ListAgents` 跨重启**（阶段 6）—— `SubagentRosterPort` 读父会话持久化的 `runtime/subagent_lifecycle` session entry，与进程内注册表合并。已知边界：`history` 条目只能按 `childSessionId` 寻址（`agent_*` 依赖内存注册表，重启即失效）；entry 只在子代理事件到达父 runtime 的事件汇时写入，被 stale-branch 丢弃的 stop 会让历史行报 `lost`（保守结果，不是 running）。

**B. 需要你拍板（产品取舍，不是技术债）**

3. **会话级消息的 UI 呈现** —— **已落地（2026-10-04）**，采用"渲染层加工"而非"协议投影"：信封字节形态一字未改（模型侧口径不变），改由 `packages/ui` 在对话流渲染时把 `<session-message>` 解析成结构化引用（pill + 悬浮详情），顺带解决「看不到消息从哪个会话来」。见 `packages/ui/spec/session-message-envelope-rendering.md`。剩下没做的是**逐会话收件箱视图**（列出某会话收到过的全部消息），那需要协议投影，等有真实诉求再做。
4. **跨机器（远端 workspace）mailbox 共享** —— 当前 mailbox 固定在本机 `~/.zcode/mailbox`，远端目标需要在远端 Host 落盘并让远端 CLI drain。与「手机远控 + 远端 workspace 是否要互发消息」这个需求绑定，需求未定前不动。

**C. 工程排序（我建议的次序，不需要你介入）**

5. **强制唤醒「从未被任何 host announce」的会话** —— 只有目标会话从未在本机启动过（刚装好、或远端 workspace 下的会话）才命中；命中时投递降级为 `stored`，消息不丢但不会实时到达。改动面最大（main 要按 workspace 解析承载 host 并拉起 CLI 进程，涉及进程生命周期），建议等线上反馈确认真的常遇到再做。
6. **dwf actor 与会话消息统一** —— **建议不做**：actor 的通信语义是「裁决」（`submit_result`/`escalate`/ask 队列），与会话间「聊天」不是同一条业务路径，合并会把工作流引擎的裁决模型拖进消息层。当前已用 denylist 明确禁止 actor 使用 `SendMessage`。

已决策不做（保持现状）：

- **回执的静默追加位**：现在源会话空闲时直接跳过回执。只有当「源会话空闲也要看到回执」成为真实诉求时，才值得在 v4 admission 增加 silent-append 投递位。
- **删除已无生产者的 workspace 事件链**：已在本轮清理完毕（见上），不保留兼容分支。
