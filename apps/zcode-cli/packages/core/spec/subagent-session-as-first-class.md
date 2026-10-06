# 子代理会话作为一等会话（一条链路、附属身份）

涉及包：`contracts`（`SubagentPort` 归属与入参、会话角色策略、session entry 常量与类型）、`core`（`Agent` 工具面、子代理派发入口、旧构造路径删除）、`bootstrap`（会话构造路径 `createRecord`、`SubagentPort` 实现、输入准入、阻塞交互 broker、生命周期级联）、`adapters`（mailbox 落盘/消费）、`services`（任务索引排除、usage 归属）、`shared`（协议 schema）、`ui`（层级列表、可输入子会话面板）。

与既有 spec 的关系：本文接续 `subagent-session-messaging.md` 的 D1、D3–D7，并**取代**其中两处结论——该文 D8 末条「`history` 行只能用 `childSessionId` 走跨会话路径」（将扩展为"可投递、可输入"），以及本文改造前追加的一条注记所声称的"子代理会话只读"前提（**该文原文并未声明这一点**，只读是 `guard.subagentReadOnly` 的实现现状）。

## 背景与问题

### 现状（已对着当前检出的源码逐条核实）

子会话与正式会话在**数据面**上已经是同一套：同一个 `AgentRuntime` 类、同一条 `sessionStore.createSession`、同一个 `sessionId` 体系（`sess_subagent_agent_<uuid>`）、同一套 V4 订阅协议（子会话已有自己的 topic 与 publisher，已能作为只读侧栏标签页打开）。

差在**运行时的构造路径**：子会话的运行时由父会话在 core 进程内直接 `new AgentRuntime(childSessionId, config, deps)` 构造（`core/src/runtime/methods/subagent.ts`），其中 `deps` 是一份**手写的字面量**（同一文件里那次 `new AgentRuntime` 调用的第三个实参）。这与 bootstrap 造正式会话的那条路径（`bootstrap/src/zcode-protocol/server-operations.ts` 的 `createRecord` → `createWorkspaceZCodeApp`）是**两条互不相干的路径**。

bootstrap 因此完全不知道这个运行时的存在：子会话没有 record，事件靠 `ingestDetachedLiveSession`（`server-operations.ts`）**借父 record 的 sink** 路由到自己的 topic，靠 `detachedChildParent` 记账，靠 `guard.subagentReadOnly` 挡住输入。

**四个症状是同一个根因**——「子会话绕过了会话构造路径」：

1. **输入面被封死**：准入要按 record 裁决，而子会话没有 record（`v4-bridge.ts` 的 `admitCommandInput` 注释原文即"detached child 没有 record 时只查元数据，不激活第二个 runtime"）。legacy `session/send` 同样有一道门。
2. **缺收件箱**：手写的依赖字面量漏了 `sessionMailboxPort`（bootstrap 造会话时本来就会注入），drain 钩子不注册，跨会话投给子代理的消息落进 mailbox 却永不 drain，工具却报 `stored`。
3. **冷恢复丢身份**：`createRecord` 的 `runtimeConfig` 不认识 `toolset` / `subagentContext` / `agentName` / `subagents.enabled`。其中 `subagents.enabled` 缺失导致一个**活的套娃后门**：`includeAgent` 的门是"`subagentPort` 在场"，端口只在 `subagents.enabled === false` 时收回，冷恢复出的子会话会拿到 `Agent` 工具（第二个注册点在 `embedded-search-branch.ts`，只改一处会被刷新路径加回来）。
4. **列表无层级**：子会话不属于任何会话集合，现有形态只能是"平级侧栏标签 + 父时间线里的 Agent 工作项"，层级要靠 `session/subagents` 现算（该投影要先读父会话全部消息再逐个子会话读全部消息）。

### 对标 OpenCode（sst/opencode，已对着源码核实）

OpenCode 里**没有"子代理实体"**：子会话就是一行带 `parentID` 的普通 session。运行态是 `Map<SessionID, Runner>`（`packages/opencode/src/session/run-state.ts`）；输入是同一个 `SessionPrompt.prompt({ sessionID })`；父→子是 `prompt({ sessionID: childId })`，子→父是 `prompt({ sessionID: parentId, parts: [synthetic] })`；删除沿 `parentID` 递归级联，abort 沿 spawn 树级联。**它没有"运行中 / 不运行"两套机制**——那只是"运行时住在哪"的差异，不是产品要求。

本方案采用同一形状。

### 搬迁构造路径的两条硬约束（2026-10-07 实测，原稿未覆盖）

落地 D1 前把「子会话交给会话构造路径」的接口事实逐条核实了一遍，发现两件决定实现形状的事。原稿把"端口搬到 bootstrap"写成一句话，实际不成立。

**约束一：父作用域端口只能由 core 提供，bootstrap 重建不出来。**

子运行时依赖里有一批是**父 runtime 的活对象**，不是 bootstrap 能从 `context` 重新构造的：

| 依赖 | 为什么 bootstrap 造不出来 |
| --- | --- |
| `permissionService`（非 explore） | 携带本会话已授予的权限状态 |
| `skillPort` | 是父 skillPort 的 `FilteredSkillPort` 包装（profile 白名单 + CUA 策略） |
| `mcpPort` | **借用**父的启动快照（`createBorrowedSubagentMcpAccess`）；重建会开第二份 MCP 连接 |
| `eventSink` | 包装父的 `notifyEventSinks`，子事件要镜像回父时间线 |
| `modelFactory` | 由父派生，绑定**本次调用**的选型（含调用级 `Agent.model` 覆盖，只在内存里） |
| `coordinatorResponsePort` | `enqueue = 父的 enqueueSubagentMessage` |
| `initialSessionMessageChain` | 父的防环链快照，只在 spawn 时取一次 |
| `agentTelemetryCausation` / `CausationMode` | 父的 span 归因（前台用真实父子 span，后台用 link） |
| `memoryRoot` | 由父的 profile / workspace 解析出的持久记忆根 |

所以 D1 的正确形状不是"core 交出构造权"，而是：**core 产出「子会话覆盖包」（runtimeConfig 覆盖 + 上面这批父作用域端口），bootstrap 的会话构造入口消费它并把 record 登记进 `context.sessions`。** 构造入口只有一处，覆盖包是该入口的一个入参。这仍然是"一条链路"，只是链路两端的职责重新划了。

**约束二：正式会话构造入口每次都做同步磁盘解析，不能直接拿来给每次派发复用。**

`createZCodeApp` 每次调用都会：`loadFileConfig`（用户/项目配置）、`discoverNodePluginsSync`（**同步**发现插件）、`loadZCodeAgentProfiles`（agent profile）、`resolveBundledSkillRoots`（内置技能包）。这些**没有进程级缓存，而且不该加**——现有语义明确写着"冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新 Plugin"，加缓存会改掉冷恢复看得见新插件这条行为。

子代理是**模型在轮内派发的**，一轮三五个是常态。若每次派发都走一遍完整入口，等于每次派发付一次会话启动成本（含同步插件发现）。原稿没有考虑这一项。

所以子会话必须走**同一个入口的受限模式**：入口内部按 `taskType === "subagent_child"` 收窄能力面（不建动态工作流 run service、automation、off-peak、node_repl 等子会话本就不该有的能力），并接受父侧已解析好的启动输入，不重复做上面那四项磁盘解析。这是「一个入口 + 内部收窄」，不是「两条构造路径」。

### 同期落地的能力（已并入本方案）

2026-10-05 / 10-06 主工作区落了三批与本方案直接相交的改动，方案已按它们校正：

- **跨会话消息三档投递**（`d23d6ba`）：`sendText` 新增 `requestedDelivery: startNow | queue | guide`，新增 `guideQueueItem`，队列项可提升为引导。影响 D3 的命令清单（原稿"拒绝 `sendQueuedNow`"是错的，已修订）。
- **hooks 框架改造**（`126b011` / `caca944` / `cc07cff` / `bcb73f4`）：子代理生命周期成为独立 hook 事件 `SubagentStart` / `SubagentStop`，载荷已带 `childSessionId` / `agentType` / `allowedTools` / `model`；`SessionEnd` 成为独立事件；事件名单下沉 `@zcode/shared` 单源并全量派生。影响 D2（launch spec 与 hook 载荷同词）、D5（终止不被阻断、发射点必须保留、发现 `SubagentStop` 声明可阻断但未消费）、S1（`subagent/runner.ts` 是重写目标也是 hook 宿主，冲突面大）。
- **上下文压缩开关化**（`4c73c90` / `c7ec42d` / `5b39818` / `c08571c`）：压缩策略成为用户可配置项，且已修过一处"子会话继承到陈旧偏好"的问题。影响 D1（起始偏好必须走 `{ kind: "inherit", parent }`）与验证（新增继承回归断言）。

## 设计决策

### D1 · 子会话由同一条会话构造路径创建（根因修复）

- 子会话的 record 由 bootstrap 的既有构造入口创建（`createRecord` → `createWorkspaceZCodeApp`），与任何会话一样进入 `context.sessions`。
- **core 产出「子会话覆盖包」**：`runtimeConfig` 的会话级覆盖（`toolset` / `subagentContext` / `agentName` / 冻结的 `toolAllowlist` / `toolDisallowlist` / `maxTurns`）＋ 一批**父作用域端口**（见上一节的表：`permissionService` 非 explore 分支、`skillPort`、`mcpPort`、`eventSink`、`modelFactory`、`coordinatorResponsePort`、`initialSessionMessageChain`、`agentTelemetryCausation` / `CausationMode`、`memoryRoot`）。父会话的 `Agent` 工具不再自己 `new AgentRuntime`。
- **bootstrap 的构造入口消费覆盖包并进入子会话受限模式**：不建子会话本就不该有的能力（动态工作流 run service、automation、off-peak、node_repl broker），并接受父 record 已解析好的启动输入，避免每次派发重复做配置 / 插件 / profile / 内置技能包四项磁盘解析。端口不必从 core "搬"到 bootstrap——`sessionMailboxPort` / `sessionMessagePort` / `subagentRosterPort` 本来就在 bootstrap 侧。
- 子会话由此**天然**获得：`sessionMailboxPort`、写死的 `subagents.enabled: false`、可裁决的输入准入、可被 `SendMessage` 命中的 record。症状 1–3 一次性消失，不需要任何"接线"。
- **起始偏好复用既有形状**：bootstrap 已经为 fork 提供了"子会话沿用父会话起始偏好"的机制（`server-operations.ts` 的 `SessionStartupPreferencesSource = { kind: "inherit", parent }`，含 memory / modelContextBudgetStrategy / nativeSearchEnhancements / compaction / shell selection）。子会话走**同一份**，不另造继承逻辑。这一步不是可选的：压缩偏好已是用户可配置项（2026-10-06 落地的压缩开关化，四项控件），漏继承会让子会话沿用陈旧策略。
- **治理纪律沿用仓库既有做法**：hook 事件名单已"下沉 `@zcode/shared` 单源 + 全量派生站点 + 奇偶校验测试"。本轮的会话角色策略照同一纪律办——单源表 + 类型级穷尽守卫 + 覆盖率/奇偶测试。策略表的价值是**不漂移**，不是减少分支；把散落分支收成一张同样复杂的表并不降低复杂度，这一点在决策里如实写明。
- **删除清单**（不保留旧路径）：core 手写的子 runtime 依赖字面量、`ingestDetachedLiveSession`、`detachedChildParent` / `detachedChildrenByParent`（含 `collectMemoryDiagnostics` 的 `detachedLive` 指标）、`pruneDetachedChildPublishers` 及其低频 tick、`deriveChildClientPorts` + `subagent-interaction-broker` 的父改写（改由 D6 在 record 层承担）、`guard.subagentReadOnly`。
- **遗留的旧路径**：`subagent-lifecycle` entry（roster）保留，它承载"跑过什么、什么状态"，与身份无关。

### D2 · launch spec：只存推导不出来的身份事实

新增 session entry：`SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC = "runtime/subagent_launch_spec"`，声明在 `contracts/src/interfaces/session-store.port.ts`（与 `SESSION_ENTRY_SUBAGENT_LIFECYCLE` 同处），并同步进同文件的 `SESSION_ENTRY_TYPES` 元组。

- **写在子会话自己身上**，id 稳定（`subagent-launch-spec:<childSessionId>`），spawn 时写一次、**不可变**；写入点必须在 `ensureSessionPersistedForExternalActivity` **之后**（`session_entry.session_id` 对 `session(id)` 有外键约束，构造期写会 FK 失败）。
- 内容只有**推导不出来**的字段：`agentType`、`profileName`、`profileSource`、`toolset`、`toolAllowlist`（冻结）、`toolDisallowlist`、`maxTurns`、`background`、`agentName`。
- **工具面必须冻结**（新增理由）：子会话"继承父全部工具"的那份白名单来自**父 runtime 的实时工具注册表**（`resolveSubagentToolAllowlist` 用 `this.getTools()` 枚举），bootstrap 侧无从重推；它是 spawn 时事实，只能快照。
- **不重复存已有事实**（避免第二真相源）：`permissionMode` 已在 `session.permission.mode` + `SESSION_ENTRY_EXECUTION_STATE`；`modelSelection` 已有专用 entry `SESSION_ENTRY_MODEL_SELECTION`。launch spec 只在 spawn 时**保证**这两处被写入，不另存一份。
- **不存 persona 正文**：persona 的 owner 是 profile，恢复时按 `profileName` 重解析。
- **与 hook 面同词**：子代理身份已在 `SubagentStart` / `SubagentStop` 载荷里被表达（`agentId` / `agentType` / `childSessionId` / `prompt` / `allowedTools` / `model`，见 `core/src/subagent/runner.ts` 的 `runSubagentLifecycleHooks`）。launch spec 复用同一套字段名与语义，不新增第二套"子代理身份"表达；差别只在 launch spec 是**持久**的那一份。

### D3 · 输入面：子会话就是一条普通会话的输入

- 删除 `guard.subagentReadOnly`，改为**会话角色策略**裁决命令集，拒绝时返回细分 reasonCode（例如"子代理会话不支持分叉"），不再用笼统的只读错误。
- **默认放行**——一切"在本会话内产生或管理输入"的命令：`sendText`（含三档投递）、`compact`、`editUserQuery`、`retryTurn`、`stop`、`switchModelConfig`、`setFollowupMode`、队列操作（`sendQueuedNow` / `guideQueueItem` / `editQueueItem` / `reorderQueueItem` / `deleteQueueItem` / `setAutoDrain`）、`renameSession`、`deleteSession`、`cancelBackgroundWork`。
  - **对原稿的两处修订**：原稿把 `sendQueuedNow` 归入"队列接管语义"并拒绝，是错的——它只是"把已排队的那条立即发出"，与普通会话无异；落在子会话**自己**队列上的操作应当放行。2026-10-05 新增的 `guideQueueItem`（队列项提升为引导）同理。
  - **`sendText` 的 `requestedDelivery: startNow | queue | guide` 三档与主会话一致**：对正在跑的子会话，"引导"就是在 tool batch 边界注入——正是 `subagentPort.sendMessage` 原本要做的同一件事。统一之后不再需要单独的子代理转向通道。
- **拒绝（三类）**：
  1. **从子会话派生新会话**：`createSession`、`createSelectionSideSession`、`forkAssistant`、`startSavedWorkflow`、`resumeWorkflowRun`、`amendWorkflowRunSettings`。归属是树不是图（D5）。
  2. **权限提升**：`switchCollaborationMode`（D9：子会话内权限模式不可改）。
  3. **会话级自主目标循环**：`sendGoalCommand`、`resumeGoal`、`pauseGoal`。目标循环是自主模式，会让"父级联中止"变得不可预测；子会话靠用户输入与消息驱动推进。
- **不由本策略管**：工作区 hook 信任类命令（`respondWorkspaceHookReview` / `toggleWorkspaceHookReviewItem` / `revokeWorkspaceHookTrust` / `requestWorkspaceHookReview`）是**用户级信任决策**，不是会话能力面；保持现状准入，不塞进角色策略表——否则等于把用户级权限伪装成会话属性。
- **强制点统一在 `admitCommandInput`**：该函数本就对每个命令被调用，但目前只裁决 6 类、对 5 类返回 intent，`switchCollaborationMode` / `switchModelConfig` / queue 系列 / `stop` / `renameSession` 目前**完全没有**子会话判据——策略必须覆盖**全部**命令类型，不能只覆盖对话输入类。
- legacy `session/send` 与 V4 准入同时生效，不出现第二条绕过路径。
- **闲时轮**：闲时轮内子会话输入与 `SendMessage` 同规则禁用并给出可执行提示（闲时轮借用前台模型，子会话输入会绕过预算语义）。

### D4 · 收件箱

由 D1 自动成立：子会话的运行时常量依赖由构造路径注入，`sessionMailboxPort` 与 drain 钩子（`UserPromptSubmit` / `PostToolUse` / `Stop`）随之生效。投递三态语义（`steered` / `woken` / `stored`）不变；`stored` 现在真的会被 drain。防环链照常（spawn 继承父链，用户从命令面输入不带链即清链）。

本决策不产生独立的实施步骤，它的验收并入 S1b。

### D5 · 生命周期：删除递归、中止沿树、其余不级联

- **删除即级联**：删除父会话时**递归删除**其子会话（沿 `parentSessionId` 且 `taskType === "subagent_child"` 的边；只按 `parentSessionId` 会误伤 fork 与选段侧聊，它们同样带 `parentID`）。
- **中止沿树级联**：中止（stop）父会话的运行轮时，中止其子/孙会话正在跑的轮。级联中止写终态，**不向父投通知**（父正在被中止）。
- **不级联的三种情形**（触发源不同，不得互相套用）：
  - 关闭标签页：仅失去订阅者，不影响子会话。
  - 常驻池空闲回收（`deactivateSession`，纯内存优化）：**不级联**。现有实现对"有 record 的 child"是跳过的，这个语义必须保持——级联若挂在两条路径共用的清理函数上，父会话被空闲回收就会杀掉正在跑的后台子代理。
  - 父会话变 idle：不级联（它只是没有进行中的轮）。
- **可单开**：子会话可被单独常驻、单独订阅、单独开轮，不要求父会话也在运行。
- 子会话**自身**的常驻回收仍受"有活动轮"保护（现有 resident facts 语义不变）。
- **终态不新增枚举**：级联中止复用 `cancelled`（协议投影现有取值 `success | failed | cancelled | lost`），不为"父中止"与"用户中止"的细微差别扩 schema。
- **与 hook 面的关系**（2026-10-05/06 落地的 hook 改造）：
  - 子代理生命周期已有独立 hook 事件 `SubagentStart` / `SubagentStop`，发射点在 `core/src/subagent/runner.ts` 的 `runSubagentLifecycleHooks`，用的是**父 runtime 的 hook runner**。S1 重写该文件时必须**保留这两个发射点**，hook 面不能因重构而丢。
  - **级联终止不被 hook 阻断**：父删除/中止是 fail-closed 的收尾动作，不经过可阻断决定；否则"用户删掉父会话"可能被一个 hook 静默否决。
  - **发现的不一致（需修，登记为遗留）**：`SubagentStop` 在共享事件表里声明 `blockable: true`（`packages/shared/src/hooks.ts`），但上面那个发射点只消费 `additionalContexts`、**没有消费阻断决定**——用户写 `"block"` 会静默无效。要么接线、要么取消 `blockable` 声明，不能保持"声明了但不生效"。
  - `SessionEnd` 是独立的会话级事件，表达"会话结束"，与"删除"不是同一件事；递归删除只在删除路径触发。

### D6 · 阻塞交互仍落父会话（实现点从 spawn 移到 record）

permission / AskUserQuestion / ExitPlanMode 仍然改写到**父会话**，带 `origin.kind === "subagent"` 标识。

- 理由（保持不变）：没人开着子会话面板时，弹窗落在子会话会永久挂起。
- 实现点变化：不再由 spawn 时的 `deriveChildClientPorts` 承担，改为 `createRecord` 在构造 `createProtocolInteractionBroker` 时按 `taskType === "subagent_child"` 改写到 `parentSessionId`。同一份 record 构造路径同时服务 spawn 与冷恢复，两条路径行为一致。
- 代价与补偿不变：用户盯着子会话面板时看不到父会话弹窗，**UI 必须补"有请求等待在父会话处理"的可点击提示**（见 UI 施工规格）。

### D7 · 列表：层级展开 + 数据源用 roster

- **数据源改用 `SubagentRosterPort`（父会话的 `runtime/subagent_lifecycle` entry）**，不用 `session/subagents`：后者要先读父会话全部持久消息、再逐个子会话读全部消息，是重型投影；roster 按父键轻查询、行数等于派发数，语义正好匹配"父未选中时显示运行中计数"和"层级列表"。
- `SubagentRosterPort` 缺 store 时**返回空数组**是错的（会让 UI 把"能力缺席"当成"没有子代理"），必须改为显式标记不可用，UI 据此走失败态。
- **不把 `subagent_child` 塞进任务索引**：那会踩到 task-index syncer 与 `repairSubagentTaskIndex` 两条既存路径。层级展示走 roster 独立投影，不进任务列表。
- 左栏只在**父条目被选中**时以层级态展开子会话，不占顶层。
- 侧栏子会话面板从只读变为可输入（完整 composer）。

### D8 · 子代理不得再派生子代理

`subagents.enabled: false` 由 D1 的构造路径**写死在子会话 record 的 runtimeConfig 里**，不再依赖"某条路径记得写"。这是 fail-closed 的安全边界，也是输入面开放的前置。

### D9 · 身份来源划分（消除原稿的自相矛盾）

同一个"身份"由三个 owner 分担，各自可推导性不同：

| 事实 | owner | 可变性 | 恢复时的行为 |
| --- | --- | --- | --- |
| persona / system prompt | profile | 可变 | 按 `profileName` 重解析；profile 被编辑则以新 profile 为准 |
| 工具面（toolset / allowlist / disallowlist）、agentName | launch spec | 不可变 | 用冻结快照（无法重推，见 D2） |
| modelSelection | `SESSION_ENTRY_MODEL_SELECTION` | 可变 | 跟随自己持久化的选择；**不跟随**父会话后续换模型 |
| permissionMode | `session.permission.mode` | 不可变（子会话内） | 子会话内**不可改**，要改回父会话改 |

一致性验收相应改为："冷恢复的 persona 与**当前** `profileName` 解析结果一致；工具面与**派发时冻结的**快照一致"——两者不再是同一句话。

### D10 · 本轮边界

- 远端 / 跨机器的子会话：不做输入面（远端 mailbox 不共享是既有未决问题），只在列表里可见、只读。
- usage 归属：仍按 `subagent` 记账，不拆成独立会话统计。
- 已结束子代理的保留：沿用现有 ended 分页，不新增保留策略。
- 子会话删除：允许单独删除（连记录一起）；父删除时递归删除。不提供归档。

## 所有权与不变式

- **运行时 owner 唯一**：一个子会话只有一个运行时，由会话构造路径创建并登记进 `context.sessions`。不存在"父内嵌一份 + 冷恢复再一份"。
- **身份来源三分为上表（D9）**，任一事实只有一个 owner，不设第二真相源。
- **嵌套闸恒真**：`subagents.enabled === false` 由构造路径写死，spawn 与冷恢复同一条路径，不存在"某条路径漏写"的可能。
- **删除沿 `(parentSessionId, taskType="subagent_child")` 边递归**；中止沿同一棵树的进行中轮级联。
- **中止语义不对称**：父级联中止优先于"有活动轮不可回收"；子会话自身回收时"有活动轮不可回收"优先。两者触发源不同，不得互相推导。
- **交互归属不变**：阻塞交互的 sessionId 恒为父会话，子会话只带 `origin` 标识。
- **不进入任务索引**：`subagent_child` 永远不出现在任务列表与任务索引里。
- **只读不再是会话级语义**：命令级的拒绝必须给细分 reasonCode。

### 所有者和事件顺序

```
派发（前台）
  Agent 工具（core，跑在父 runtime 里）
    └─ SubagentPort.launch（bootstrap 实现）
         ├─ sessionStore.createSession(childSessionId, taskType=subagent_child, parentID=父)
         ├─ 写 launch spec entry（子会话自己身上，不可变）
         ├─ createRecord → createWorkspaceZCodeApp
         │    ├─ 工具面由 launch spec 的冻结白名单决定（不含 Agent 工具）
         │    ├─ subagents.enabled = false（写死）
         │    ├─ sessionMailboxPort / sessionMessagePort 一并注入
         │    └─ 交互 broker 改写到父会话（origin.kind = subagent）
         ├─ context.sessions.set(childSessionId, record)
         └─ 在子 record 上跑轮 → 结果回 Agent 工具

用户输入子会话
  v4 命令 → admitCommandInput（读角色策略）→ 子 record 的 runtime → 正常开轮

删除父会话
  deleteSession(父) → 递归 children(父) → 每个子：中止进行中的轮 → 删除行与 record

中止父会话的运行轮
  abort(父) → 沿 children(父) 级联 → 中止子/孙进行中的轮（不投通知）
```

## 失败语义

- **launch spec 缺失 / profile 解析不到**：子会话进入**受限模式**——输入面关闭（等同现状只读）、不注册 `Agent` 工具、使用通用 persona，UI 标注"身份未还原"。绝不猜一个 profile 出来。
- **父会话已被删除**：子会话不应存在（递归删除）；若因数据损坏出现孤儿，子会话可读、可单独常驻，但输入面按受限模式关闭，UI 说明原因。
- **投递不可达**：落 mailbox 且**有 drain 保证**；mailbox 本身不可写时明确失败，不假装 `stored`。
- **非法命令**：返回细分 reasonCode，不返回笼统的只读错误。
- **闲时轮内的子会话输入**：明确拒绝并给出可执行提示，不静默丢弃。

## 迁移边界

- **存量子会话没有 launch spec**：冷恢复时退化为受限模式（不可输入）。不做批量回填——子会话的身份不能从窄化的 lifecycle entry 之外的地方可靠推断。用户若要继续使用，重新派发一个子代理即可。
- **`agent_*` 寻址保持不变**：现有提示词、`ListAgents`、节奏型工作流仍可按 `agent_*` 使用；新增的是 `sess_subagent_*` 可投递、可输入。
- **`ListAgents` / `SendMessage` 的模型可见描述必须同步**，且文案在 **core 的 handler**（`core/src/tool/handlers/list-agents.ts`、`send-message.ts`），不在 `contracts`。
- **`subagent-session-messaging.md` 的结论同步**：该文顶部注记已在本次改造中更新；落地时把 D8 末条改写为"可投递、可输入"。注意该文原文并**没有**"子代理会话只读"这几个字（那是改造前追加的注记），修的是结论不是措辞。
- **主会话回归门覆盖 `SESSION_TASK_TYPES` 的全部 7 类**（`interactive` / `fork` / `selection_side_chat` / `workflow_parent` / `workflow_child` / `subagent_child` / `nested_workflow_child`，见 `contracts/src/interfaces/session-store.port.ts`）：除 `subagent_child` 外的 6 类能力面必须与改造前逐项一致。`workflow_child` 有自己的工具 denylist（`app/workflow-actor-tools.ts`），不能被本改造覆盖或绕过。

## 实施阶段（方案）

### S1a · launch spec 落库 + 冷恢复认领身份（无构造搬迁，可独立落地）

这一半不依赖构造路径搬迁，且同时修掉症状 3（冷恢复丢身份）与它后面的套娃后门，是本轮的安全前置。

改动面：
- `contracts`：`SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC = "runtime/subagent_launch_spec"` 常量、entry 数据结构、`SESSION_ENTRY_TYPES` 同步。
- `core`：spawn 时在 `ensureSessionPersistedForExternalActivity` 之后写 launch spec（外键约束要求 session 行先存在）；无 `sessionStore` 时跳过（此时也没有冷恢复，不构成静默降级）；落盘失败只 warn，不让 spawn 失败。
- `bootstrap`：`createRecord` 的 `runtimeConfig` 对 `taskType === "subagent_child"`：读 launch spec 并回填 `toolset` / `agentName` / 冻结白名单 / `toolDisallowlist` / `maxTurns`；**无条件**写死 `subagents: { enabled: false }`（fail-closed，spec 缺失也写）。缺 spec → 受限模式（只写 `enabled: false` 并记一条 debug）。
- 无需改动 `includeAgent` 的两个注册点：它们读的是 `runtime.subagentPort`，而端口只在 `subagents.enabled === false` 时收回，所以折叠在 runtimeConfig 一处即可。

**S1a 不做 persona 回填**（`subagentContext`）：症状 3 说的是「身份」，persona 的 owner 是 profile，要按 `profileName` / `profileSource` 重解析才能回填，而那段解析逻辑（`buildExploreAgentPrompt` 等）在 core。launch spec 已把这两个寻址键落库，回填留给 S1b（那时子会话由同一个构造入口物化，可以顺路解析 profile）。在输入面开放（S2）之前，冷恢复子会话本来也不可输入，persona 缺口不影响任何可达行为。

验收：launch spec 写入（FK 顺序）与读取；无 spec → 受限分支；`subagents.enabled === false` 恒真且据此收回 `subagentPort`（套娃闸，单测钉住这一环）；主会话（7 类 taskType）不受影响。

### S1b · 子会话升格为正式 record（根因修复，依赖 S1a）

改动面：
- `contracts`：子会话覆盖包的入参类型（要携带父侧解析好的冻结工具面与父作用域端口集合）。
- `core`：`Agent` 工具改为经端口派发；删除手写的子 runtime 依赖字面量与那次 `new AgentRuntime`；删除 `deriveChildClientPorts`（父改写改由 D6 在 record 层承担）。
- `bootstrap`：构造入口实现覆盖包消费（受限模式：收窄能力面 + 复用父已解析的启动输入）；交互 broker 的父改写；起始偏好走 `{ kind: "inherit", parent }`。
- `core` 必须保留 `subagent/runner.ts` 里的 `SubagentStart` / `SubagentStop` hook 发射点（D5）。
- 本阶段**保留只读门**（D3 在 S2 才拆），避免半开状态。

**已知冲突面**：`core/src/subagent/runner.ts` 刚被 hook 改造大改过（`SubagentStart` / `SubagentStop` 发射点、`injectHookAdditionalContext`、payload 组装），而它正是 S1b 要重写的文件；`core/src/runtime/methods/subagent.ts` 手写的依赖字面量里也已包含 hook 相关字段。重写时以"保留 hook 发射点 + 保留 payload 字段"为硬约束，不能顺手删掉。

验收：
- 子会话创建后出现在 `context.sessions` 里，且 `SendMessage(to: sess_subagent_*)` 走到正常的会话投递路径（不再有第二份 runtime）。
- 子会话**不注册** `Agent` 工具（含刷新路径 `embedded-search-branch.ts`）。
- 子会话有 `sessionMailboxPort`，mailbox drain 钩子已注册。
- **派发成本不回归**：单次子代理派发相对改造前不出现"每次派发付一次完整会话启动"的量级差异（按第「约束二」节的收窄策略实现，并实测确认）。
- 主会话（7 类 taskType）冷恢复与派发行为逐项不变。

### S2 · 输入面（角色策略 + 命令集）

改动面：`contracts`（角色策略与细分 reasonCode）、`bootstrap`（`admitCommandInput`、legacy `session/send`、`switchCollaborationMode` 拒绝 / `switchModelConfig` 放行）、`core`（闲时轮拒绝路径）。

验收：
- 子会话可 `sendText` 开新轮并跑完；三档投递（`startNow` / `queue` / `guide`）对子会话都生效，`guide` 能注入正在跑的子会话轮。
- `compact` / `editUserQuery` / `retryTurn` / `switchModelConfig` / `stop` / 队列操作可用。
- `forkAssistant` / `createSelectionSideSession` / `createSession` / `startSavedWorkflow` / `resumeWorkflowRun` / `amendWorkflowRunSettings` / `sendGoalCommand` / `resumeGoal` / `pauseGoal` / `switchCollaborationMode` 返回细分 reasonCode。
- `sendQueuedNow` / `guideQueueItem` **放行**（修订原稿的拒绝判断）。
- 表驱动矩阵：遍历**全部**命令类型 × 子会话，断言 admitted 或具体 reasonCode（命令类型以 `packages/shared/src/zcode-protocol-v4/command.ts` 的 `commandPayloadSchemas` 为准，当前 35 条）。
- 主会话全部输入命令行为不变（回归）。

### S3 · 生命周期（递归删除 + 沿树中止）

改动面：`bootstrap`（删除递归、中止级联、resident/reclaim 路径区分；不得挂在 `disposeSession` 与 `deactivateSession` 共用的清理函数上）、`core`（中止时写终态）。

验收：
- 删除父会话 → 子会话被递归删除；中止父会话的运行轮 → 子/孙进行中的轮中止。
- 关闭父标签页、父会话空闲回收、父变 idle → 子会话均不受影响。
- 子会话可被单独唤醒、单独常驻；自身空闲可被回收后再单独唤醒；有活动轮时不被 idle 回收。

### S4 · UI（施工规格见下节）

改动面：`ui`（左栏层级列表、子会话面板、状态角标、授权提示）、`shared`（列表投影若需补字段）。

### S5 · 收口

- 删除 S1b 列出的全部旧路径残留（`ingestDetachedLiveSession`、`detachedChild*`、`pruneDetachedChildPublishers`、只读门、旧 deps 字面量）。
- 同步 `subagent-session-messaging.md`（D2/D8、失败语义）。
- 更新 `CONTEXT.md` 词汇（注意：词条不得以现在时描述目标态）。
- **角色策略覆盖率检查**取代"逐项清点分叉"：以策略表为准做遍历断言。作为对照，当前 `subagent_child` 字面判据实测为 **19 处**（core 13 + bootstrap 4 处真分叉 + 2 处只读门），另有 `packages/services` 3 处按 `sessionKind`（这三处按 D7 不改）。

## UI 施工规格（S4）

### 左栏任务列表：层级态

- **位置**：父会话条目**下方**的子区块，仅在父条目处于选中态时渲染。
- **数据**：`SubagentRosterPort` 的父键查询（不塞任务索引）。
- **子条目控件形态**：
  - 缩进一级（16px）；左侧 `BotIcon`（12px，颜色取 profile 的 `color`，缺省 `text-foreground-subtlest`）。
  - 标题：子会话 title，单行截断。
  - 右侧状态指示：`running` 脉动圆点（`text-ui-accent` + `animate-pulse`）；`success` CheckIcon（`text-success`）；`failed` TriangleAlert（`text-destructive`）；`cancelled` / `lost` MinusIcon（`text-foreground-subtlest`）。**不新增 `killed` 取值**，不单靠颜色区分（配 `aria-label`）。
  - 点击 → `openSubagentSessionSidePane(childSessionId)`（复用现有入口，不新增打开通道）。
- **状态**：
  - 空：**不渲染区块**，不显示空态占位。
  - 加载：区块位置渲染 2 行同高骨架（高度取现有列表行 token）。
  - 失败（含 roster 不可用）：一行 `text-ui-xs text-foreground-subtlest` 文案 + 重试按钮。
  - 超过 8 个：区块底部一行"还有 N 个已结束的子代理"，点击打开现有子代理目录面板。
- **父未选中**：不渲染子区块；若该父会话有 `running` 子代理，父条目右侧显示计数角标（`Badge variant="secondary"`，纯数字）。
- **动效**：展开/收起复用现有 collapsible；不做新动效。
- **远端父会话**：子条目可见但只读（D10）。
- **文案**（落在 `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`）：
  - `subagents.list.loadFailed`：`子代理列表加载失败` / `Failed to load subagents`
  - `subagents.list.retry`：`重试` / `Retry`
  - `subagents.list.moreEnded`：`还有 {count} 个已结束的子代理` / `{count} more finished subagents`

### 侧栏子会话面板：从只读变可输入

- **顶部条**：`BotIcon` + 标题 + 身份徽标 + 状态词。
- **输入区**：复用正式会话 composer。差异：
  - 隐藏权限模式切换（D9 不可改）。
  - 保留模型选择（可切）。
  - **保留三档投递**（普通 / 引导 / 立即，`requestedDelivery: queue | guide | startNow`）：这是 2026-10-05 落地的 composer 能力，对子会话同样有意义——"引导"就是不打断当前轮、在 tool batch 边界注入，"立即"才抢占。
  - **保留队列面板**：子会话忙时同样会排队，队列项操作（引导 / 立即 / 编辑 / 重排 / 删除 / 自动放行）按 D3 放行，不另做简化版。
  - 保留上下文用量与 compact 入口。
  - 保留行内 `editUserQuery` / `retryTurn` 控件（D3 放行）。
  - 受限模式（身份未还原）或孤儿会话：composer 禁用，顶部一行说明原因。
- **形态选择**：`SessionPane` 现有的 `readOnly` 太粗（同时关掉 drop target、取消后台任务、edit/retry/fork），`selectionSideChat` 则已经实现了"保留 composer + 隐藏 edit/retry/fork/goal"这一形状——子会话要的是**第三种黑名单**（保留 edit/retry，去掉 fork/goal/权限模式）。实现上把黑名单参数化并给这一形态命名，不要新增一个整块的布尔开关。
- **授权请求提示（新增，必需）**：当父会话上存在属于本子代理的待处理交互（`origin.kind === "subagent"` 且 childSessionId 匹配）时，面板顶部显示可点击提示，点击切到父会话标签页；无请求时隐藏。
- **已终止子会话**：面板底部显示终态摘要；composer 仍可用（续聊=开新轮）。
- **空态**：复用现有会话空态。
- **文案**：
  - `subagents.pane.identityBadge`：`子代理 · {agentType}` / `Subagent · {agentType}`
  - `subagents.pane.pendingInParent`：`有 {count} 个请求等待在父会话处理` / `{count} request(s) pending in the parent session`
  - `subagents.pane.limitedMode`：`此子代理的身份未能还原，暂不可输入` / `This subagent's identity could not be restored; input is disabled`

### 视觉约束

- 授权提示用**等待确认色族**（`DESIGN.md`：等待确认不得用 success 色族），不能用 `text-warning` 直接顶替语义未知的色板项。
- 其余沿用 `text-ui-xs`、`Badge variant="secondary"`、现有缩进与图标尺寸 token。

### 验收路径（E2E）

1. 派发一个后台子代理 → 选中父会话 → 左栏父条目下方出现子条目（running 脉动点）。
2. 点击子条目 → 侧栏打开子会话，可看到它的工具调用与消息。
3. 在子会话输入"总结你的发现" → 子会话开新轮并完成；父会话不被阻塞。
4. 子代理跑完后 → 子条目状态变 `success`；父会话未选中时父条目显示计数角标。
5. 触发一次需要授权的子代理工具调用 → 弹窗出现在父会话；子面板顶部出现"有 1 个请求等待在父会话处理"，点击跳到父会话。
6. 关闭父会话标签页 → 子代理不受影响；删除父会话 → 子会话被递归删除。
7. 中止父会话的运行轮 → 子代理进行中的轮被中止，不产生通知。
8. 重启应用 → 子条目仍在；点开可继续聊，身份为原 `agentType` 的 profile。
9. 在子会话尝试 fork / 切换权限模式 → 控件不存在或明确拒绝，并给出可读原因。
10. 子代理尝试派生子代理 → `Agent` 工具不可用，返回明确错误而非隐式挂起。

## 验证

- 单测入口（仓库没有统一 test 脚本覆盖这些包，需手工指定）：根 `pnpm test` 只跑 `packages/shared/test/**`；CLI 侧逐包 `node --import tsx --test apps/zcode-cli/packages/<pkg>/test/<file>.test.ts`；`packages/ui/test/**` 有测试文件但**没有脚本入口**，需手工跑且带 `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json` 才能解析 `@/` 别名。
  - launch spec 写入（FK 顺序）与读取；无 spec → 受限分支。
  - 冷恢复的子 record：`subagentPort === undefined`、工具面不含 `Agent`、`subagents.enabled === false`。
  - 角色策略的**命令矩阵**（遍历全部命令类型）。
  - 删除递归与中止级联；`deactivateSession` **不**级联。
  - 起始偏好继承：子会话的 compaction / memory / 预算策略与父一致；父偏好热更新后**新派生**的子会话不沿用旧值（既有回归面，见 `bootstrap/src/zcode-protocol/compaction-preferences.ts` 的快照刷新）。
  - hook 发射点保持：`SubagentStart` / `SubagentStop` 仍按原 payload 字段发射。
  - **策略表覆盖率**：照 `packages/shared/test/hook-event-copy-parity.test.ts` / `core/test/hook-copy-parity.test.ts` 的先例，断言"命令类型集合 ⊆ 策略表键集合"——新增命令时测试先红，而不是等准入处静默放行。
- 集成：子会话 `sendText` 开新轮；跨会话投递在空闲/运行中两态都能消费（现有 `core/test/session-mailbox-sender-kind.test.ts` 是同源先例）。
- 端到端：上述 10 条验收路径。仓库**没有 E2E 框架与脚本**（`playwright-core` 在依赖里但没有 e2e 入口），交互验收只能由 agent 驱动浏览器手工执行。
- 门禁（命令均已实测，不是照抄 AGENTS.md）：
  - 根 `pnpm lint` / `pnpm fmt:check` **都不覆盖** `apps/zcode-cli`：根 `.oxlintrc.json` 的 `ignorePatterns` 含 `apps/zcode-cli`，且给 `oxfmt --check` / `oxlint` 传该目录下的文件会返回 `No files found to lint` / `Expected at least one target file`（`--no-ignore` 也绕不过）。
  - CLI 侧可用的类型门禁：`pnpm typecheck:cli`。
  - CLI 侧可用的 lint：**逐子包**跑 `pnpm --dir apps/zcode-cli/packages/<pkg> run lint`（= 该子包的 `oxlint src --no-ignore`）。**不要写 `pnpm --dir apps/zcode-cli run lint`**——它的脚本是 `turbo run lint`，而该独立 workspace 里 `turbo` 不可解析（实测 `Command "turbo" not found`）。
  - CLI 的 lint 是**既存红债**，不能当绿灯：本检出 `packages/core` 实测 31 errors / 10 warnings（`max-lines` 超 400、`NOOP_CALL` 未使用等）。CLI 改动按"不新增错误"衡量，不要求清零。
  - CLI 的 `format:check` 只覆盖 `package.json` 与 `**/*.{json,ts,mjs}`，**不覆盖 markdown**——本文与其它 spec 不在任何格式化门禁内。
  - 触及根包（`packages/ui`、`packages/shared` 等）：`pnpm typecheck` + `pnpm lint` + `pnpm fmt:check`。
  - `pnpm architecture:check -- --changed`。

## 遗留工作（分类）

**本轮范围内、按阶段排期**：S1a、S1b、S2–S5（见上）。

**本轮不做、需另立任务**：

- 远端子会话的输入面（依赖跨机器 mailbox 共享，是既有未决问题）。
- fork / 选段侧聊（会让父子关系从"树"变成"图"，需重设防环与归属）。
- 子会话归档与保留策略。
- 子代理再派生（结构性禁止，不是待办）。
- 存量无 launch spec 子会话的回填（已决策：不回填，重新派发即可）。
- **`SubagentStop` 的可阻断声明与实现不一致**（D5）：共享事件表声明 `blockable: true`，但 `core/src/subagent/runner.ts` 的发射点不消费阻断决定。修法二选一（接线，或取消声明），与本改造无耦合，可独立处理。

**已决策不做（保持现状）**：

- 把 `subagent_child` 塞进任务索引——层级展示走 roster 独立投影。
- 权限弹窗改落子会话——保持落父会话 + origin 标识，避免"无人订阅时弹窗丢失"。
- persona 正文入存储——persona 的 owner 是 profile。
- 新增 `killed` 终态——复用 `cancelled`，不为细微差别扩协议。
