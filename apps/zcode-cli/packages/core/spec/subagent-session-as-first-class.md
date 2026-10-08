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
- 子会话由此**天然**获得：一条与普通会话同形的 record（可被协议与 UI 看见、可常驻可回收）、一个唯一 runtime、写死的 `subagents.enabled: false`。症状 1–3 一次性消失，不需要任何"接线"。**可裁决的输入准入（S2）与收件箱（S3）随后接上**——S1b 只搬构造，不开新输入通路。
- **起始偏好复用既有形状**：bootstrap 已经为 fork 提供了"子会话沿用父会话起始偏好"的机制（`server-operations.ts` 的 `SessionStartupPreferencesSource = { kind: "inherit", parent }`，含 memory / modelContextBudgetStrategy / nativeSearchEnhancements / compaction / shell selection）。子会话走**同一份**，不另造继承逻辑。这一步不是可选的：压缩偏好已是用户可配置项（2026-10-06 落地的压缩开关化，四项控件），漏继承会让子会话沿用陈旧策略。
- **治理纪律沿用仓库既有做法**：hook 事件名单已"下沉 `@zcode/shared` 单源 + 全量派生站点 + 奇偶校验测试"。本轮的会话角色策略照同一纪律办——单源表 + 类型级穷尽守卫 + 覆盖率/奇偶测试。策略表的价值是**不漂移**，不是减少分支；把散落分支收成一张同样复杂的表并不降低复杂度，这一点在决策里如实写明。
- **删除清单**（不保留旧路径）：core 手写的子 runtime 依赖字面量（`new AgentRuntime` 那次）、`ingestDetachedLiveSession` 及其归属簿记（见 S1b-4 的前置条件）。`deriveChildClientPorts` **保留**（派生点不动，见 D6；产物改由覆盖包送达），`guard.subagentReadOnly` 随 S2 的输入面一起拆。
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

- 删除 `guard.subagentReadOnly`，改为**会话角色策略**裁决命令集，拒绝时返回细分 reasonCode（`guard.subagentCannotDeriveSession` / `guard.subagentCannotEscalatePermission` / `guard.subagentCannotRunGoalLoop`，即"子代理会话不支持分叉 / 不支持改权限模式 / 不支持目标循环"），不再用笼统的只读错误。单源表与三个强制点见 S2。
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
- **闲时轮**：**复查后删除该实施项**——"闲时轮内子会话输入"是不可达状态（子会话的轮从不带 `offPeakTaskId`，也不注册闲时工具面），真正存在的同规则在工具层：闲时轮内 `SendMessage` 被 `assertNotOffPeakTurn` 拒绝并给出可执行提示。证据与验收见 S2 的「订正一」。

### D4 · 收件箱

由 D1 自动成立：子会话的运行时常量依赖由构造路径注入，`sessionMailboxPort` 与 drain 钩子（`UserPromptSubmit` / `PostToolUse` / `Stop`）随之生效。投递三态语义（`steered` / `woken` / `stored`）不变；`stored` 现在真的会被 drain。防环链照常（spawn 继承父链，用户从命令面输入不带链即清链）。

本决策不产生独立的实施步骤，它的验收并入 S1b。

### D5 · 生命周期：删除递归、中止沿树、其余不级联

- **删除即级联**：删除父会话时**递归删除**其子会话（沿 `parentSessionId` 且 `taskType === "subagent_child"` 的边；只按 `parentSessionId` 会误伤 fork 与选段侧聊，它们同样带 `parentID`）。
- **中止沿树级联**：中止（stop）父会话的运行轮时，中止其子/孙会话正在跑的轮。级联中止写终态，**不向父投通知**（父正在被中止）。
- **不级联的三种情形**（触发源不同，不得互相套用）：
  - 关闭标签页：仅失去订阅者，不影响子会话。
  - 常驻池空闲回收（`deactivateSession`，纯内存优化）：**不级联**——级联若挂在两条路径共用的清理函数上，父会话被空闲回收就会杀掉正在跑的后台子代理。
  - 父会话变 idle：不级联（它只是没有进行中的轮）。
- **借用不变式（S3 复核后的订正）**：子会话 runtime **借父 App 的进程内适配器实例**（`modelFactory` 来自父的 `ApiProviderModelRuntime`、`mcpPort` / `executionPort` / `fileSystemPort` / `httpClientPort` / `pdfDocumentPort` / `artifactStore` / `skillPort` / `permissionService` / `agentTelemetry` 同样借自父 App，见差异清单 1/3 与 S1b-2）。父 App 的 `close()` 会 `providerModelRuntime.dispose()` 且（父 `ownsMcpPort` / `ownsExecutionPort` 为真时）`mcpPort.close()` / `executionPort.close()`（`session-facade.ts:300-304`）。**因此父 App 必须比它的子 record 活得久**：
  - **删除/关闭路径**：先关子（递归），再关父。反过来会把还在收尾的子会话的资源撤走。
  - **常驻回收路径**：**有驻留子 record 的会话不可被 idle 回收**（新增 resident fact `hasResidentChildren`）。原稿写"现有实现对有 record 的 child 是跳过的"——S1b 之后该描述已不成立：子会话就是普通 record，常驻池对它一视同仁。缺口是真实可达的两条：(a) 用户直接给子会话发输入、子会话自己开轮时，父会话既无前台轮也无后台任务，原本可被回收；(b) 已结束但仍驻留的子会话被再次唤醒时，父早已被回收。两种情形下子会话都会用上已 `close()` 的 MCP / 执行端口与已 `dispose()` 的模型工厂。
  - 回收**仍然只动一个会话**（不递归、不级联）；被 pin 的父会话由子会话逐个被回收后自然解锁。代价：极端情况下驻留数可能超过 `highWaterCount`（正确性优先于内存上限，记录在案）。
- **可单开**：子会话可被单独常驻、单独订阅、单独开轮，不要求父会话也在运行（父通常仍在跑）——上一条的 pin 保证它借的资源还在。
- 子会话**自身**的常驻回收仍受"有活动轮"保护（现有 resident facts 语义不变）。
- **终态不新增枚举**：级联中止复用 `cancelled`（协议投影现有取值 `success | failed | cancelled | lost`），不为"父中止"与"用户中止"的细微差别扩 schema。
- **与 hook 面的关系**（2026-10-05/06 落地的 hook 改造）：
  - 子代理生命周期已有独立 hook 事件 `SubagentStart` / `SubagentStop`，发射点在 `core/src/subagent/runner.ts` 的 `runSubagentLifecycleHooks`，用的是**父 runtime 的 hook runner**。S1 重写该文件时必须**保留这两个发射点**，hook 面不能因重构而丢。
  - **级联终止不被 hook 阻断**：父删除/中止是 fail-closed 的收尾动作，不经过可阻断决定；否则"用户删掉父会话"可能被一个 hook 静默否决。
  - **发现的不一致（需修，登记为遗留）**：`SubagentStop` 在共享事件表里声明 `blockable: true`（`packages/shared/src/hooks.ts`），但上面那个发射点只消费 `additionalContexts`、**没有消费阻断决定**——用户写 `"block"` 会静默无效。要么接线、要么取消 `blockable` 声明，不能保持"声明了但不生效"。
  - `SessionEnd` 是独立的会话级事件，表达"会话结束"，与"删除"不是同一件事；递归删除只在删除路径触发。

### D6 · 阻塞交互仍落父会话（派生点不动，送达点移到构造入口）

permission / AskUserQuestion / ExitPlanMode 仍然改写到**父会话**，带 `origin.kind === "subagent"` 标识。

- 理由（保持不变）：没人开着子会话面板时，弹窗落在子会话会永久挂起。
- **派生点不变**（2026-10-07 订正原稿）：改写必须由**父 runtime** 派生——`child-client-ports.ts` 的文件头把这条写成了不变式（`parentSessionId` 只能由父填，调用方给不了错的值；历史上正是因为散在各 child 装配点而"两处错、一处对"）。而且 `origin` 需要 `agentId` / `description` / `parentToolCallId` / `parentTurnId` 这些**只有派发点才有**的运行时事实，record 层拿不到。所以本轮不改由谁派生，只改**由谁消费**：子 runtime 不再自己包一层，改为覆盖包携带父已派生好的 `permissionBroker` / `providerRuntimeHeadersPort`，由构造入口原样送进子 runtime deps。
- `providerRuntimeHeadersPort` 同理（同一 helper 一次派生两个端口）。
- 代价与补偿不变：用户盯着子会话面板时看不到父会话弹窗，**UI 必须补"有请求等待在父会话处理"的可点击提示**（见 UI 施工规格）。
- 冷恢复的孤立子会话没有父可派生 → 交互回落成它自己的 sessionId；这条路径今天就是这样，S2/S4 处理"UI 如何认领"。派生点已从 `taskType` 无关的 spawn 侧固定下来，不需要为它加分支。

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
    └─ SubagentChildSessionHost.createChildSession(bundle)   ← core 产出覆盖包后调用
         ├─ 读父 record 借出的装配事实（startupInputs + 进程内适配器实例）
         ├─ createRecord 同源路径物化子 record（taskType=subagent_child, parentID=父）
         │    ├─ 工具面由覆盖包的冻结白名单决定（不含 Agent 工具）
         │    ├─ subagents.enabled = false（写死，套娃闸）
         │    └─ 交互 broker / provider runtime headers 改写到父会话（origin.kind = subagent）
         ├─ 起始偏好 { kind: "inherit", parent }
         ├─ context.sessions.set(childSessionId, record)      ← 登记在 App 构造成功之后
         └─ resume 时 app.resume()（恢复 owner 与冷恢复同一条）
    └─ 在返回的 runtime 上：ensureSessionPersistedForExternalActivity → 写 launch spec → 跑首轮

用户输入子会话
  v4 命令 → admitCommandInput（读角色策略）→ 子 record 的 runtime → 正常开轮

删除父会话
  deleteSession(父) → 递归 children(父) → 每个子：中止进行中的轮 → 删除行与 record

中止父会话的运行轮
  abort(父) → 沿 children(父) 级联 → 中止子/孙进行中的轮（不投通知）
```

## 失败语义

- **launch spec 缺失 / profile 解析不到**：子会话进入**受限模式**——输入面关闭、不注册 `Agent` 工具、使用通用 persona，UI 标注"身份未还原"。绝不猜一个 profile 出来。判据只有一个（**launch spec 读不到**），落地方式见 S4 前置 1：`inputRouting.mode = "reject"` + `reasonCode = "guard.subagentLimitedMode"` 是投影面，`admitCommandInput` 拒绝对话输入类命令是强制面。
- **父会话已被删除**：子会话不应存在（递归删除）；若因数据损坏出现孤儿，子会话可读、可单独常驻。**若它同时读不到 launch spec**（与上一条同一判据），输入面按受限模式关闭并在 UI 说明原因；spec 仍可读的孤儿按普通子会话处理——不在正常产品路径上（S3 已递归删除 + 驻留 pin），本条不为它加第二判据。
- **投递不可达**：落 mailbox 且**有 drain 保证**；mailbox 本身不可写时明确失败，不假装 `stored`。
- **非法命令**：返回细分 reasonCode，不返回笼统的只读错误。
- **闲时轮内的子会话输入**：明确拒绝并给出可执行提示，不静默丢弃。

## 迁移边界

- **存量子会话没有 launch spec**：冷恢复时退化为受限模式（不可输入）。不做批量回填——子会话的身份不能从窄化的 lifecycle entry 之外的地方可靠推断。用户若要继续使用，重新派发一个子代理即可。
- **`agent_*` 寻址保持不变**：现有提示词、`ListAgents`、节奏型工作流仍可按 `agent_*` 使用；新增的是 `sess_subagent_*` 可投递、可输入。
- **`ListAgents` / `SendMessage` 的模型可见描述必须同步**，且文案在 **core 的 handler**（`core/src/tool/handlers/list-agents.ts`、`send-message.ts`），不在 `contracts`。
- **`subagent-session-messaging.md` 的结论同步**：该文顶部注记已在本次改造中更新；落地时把 D8 末条改写为"可投递、可输入"。注意该文原文并**没有**"子代理会话只读"这几个字（那是改造前追加的注记），修的是结论不是措辞。
- **主会话回归门覆盖 `SESSION_TASK_TYPES` 的全部 7 类**（`interactive` / `fork` / `selection_side_chat` / `workflow_parent` / `workflow_child` / `subagent_child` / `nested_workflow_child`，见 `contracts/src/interfaces/session-store.port.ts`）：除 `subagent_child` 外的 6 类能力面必须与改造前逐项一致。`workflow_child` 有自己的工具 denylist（`app/workflow-actor-tools.ts`），不能被本改造覆盖或绕过。
  - **已登记的一处例外**：expert 路径的 `workflow_child` runtime 失去 `Agent` 工具（差异清单 24）。原因是它改前就有"有 Agent 工具、无构造移交端口"的缺口，删除 core 内联构造后那条路会变成硬失败；取舍与后续若要恢复的做法都记在差异清单 24 里。其余 5 类无例外。

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

拆成四个各自可验证的子步骤（S1b-1 已落地 `4c942f6`）。**本阶段的硬要求是"结构搬迁、行为不变"**：
所有能力面的增开（收件箱、输入、删除级联）都留给 S2/S3，S1b 结束后子会话的可达行为应与改造前逐项相同。

#### S1b-1 · 启动输入提取（已完成）

`create-app.ts` 里按当前磁盘现状解析的四项启动输入（config / plugin / agent profile / 内置技能包）提成
`app/startup-inputs.ts` 的 `resolveStartupInputs()`；`createZCodeApp` 默认调它，并接受 `options.startupInputs`
直接复用。**不加进程级缓存**（约束二：冷恢复必须看得见新插件目录）。

#### S1b-2 · 覆盖包 + 由构造入口物化子 record

两个新概念，定义在 core 的 `src/subagent/child-session-host.ts`（bootstrap 从 `@zcode/core` 导入，
**只导出类型**，bootstrap 只在装配期实现 host 并消费 bundle）：

| 名字 | 方向 | 内容 |
| --- | --- | --- |
| `SubagentChildLaunchBundle` | core → bootstrap | `parentSessionId` / `childSessionId` / `agentType` / `agentName` / `description` / `background` / `resume`，加 `runtimeConfig`（会话级覆盖）与 `deps`（父作用域端口） |
| `SubagentChildSessionHost` | bootstrap 实现、core 调用 | `createChildSession(bundle) → AgentRuntime`（返回**已登记**进 `context.sessions` 的 runtime） |
| `SubagentChildBorrowedPorts`（bootstrap） | 父 App → 子 App | `startupInputs` + 六个进程内适配器实例（execution / fs / http / image / pdf / artifactStore） |
| `SubagentChildAppScope`（bootstrap） | 父 record → 子构造 | `{ bundle, borrowed }`，经 `ZCodeAppOptions.subagentChildScope` 传入 |

职责划分（**这张表是本节的核心，实现照它办**）：

| 类别 | 内容 | owner |
| --- | --- | --- |
| 会话级 runtimeConfig 覆盖 | `mode` / `planEnabled` / `modelSelection` / `modelContextBudgetStrategy` / `workingDirectory` / `envInfo` / `modelStreaming` / `bashTimeoutPolicy` / `midConversationSystem` / `bashShellSelection` / `currentDate` / `subagentContext` / `agentName` / `maxTurns` / `parentSessionId` / `taskType` / `dynamicWorkflowEnabled` / `toolset` / `toolAllowlist` / `toolDisallowlist` / `embeddedSearchBackend` / `nativeSearchEnhancementsEnabled` / `subagents` / `mcp` | core（父语境的实时快照） |
| 父作用域端口 | `permissionService`（非 explore 为父实例） / `permissionBroker`（父改写后的子包装） / `providerRuntimeHeadersPort`（reroute 到父） / `coordinatorResponsePort` / `skillPort`（FilteredSkillPort） / `mcpPort`（借用父启动快照） / `modelFactory`（绑定本次调用选型） / `eventSink`（镜像回父） / `agentTelemetry` + causation + causationMode / `initialSessionMessageChain` / `modelRequestAdmission` / `memoryRoot` / `toolScheduler` / `resolveEffectiveModelSelection` / `traceContext` | core |
| 装配事实 | `startupInputs` + execution / fs / http / image / pdf / artifactStore 实例 | 父 App（`ZCodeApp.subagentChildBorrow`） |
| record 与 App 外壳 | sessionId / traceContext / eventStore（自有实例）/ sessionStore（借）/ record 字段集 / sessionFacade / inputFacade / pluginFacade / workflowFacade | bootstrap 构造入口 |

**子会话受限模式的差异清单**（S1b 阶段原按"`options.subagentChildScope` 在场"编写；**S5 收口订正**：收窄的判据是 `isSubagentChildSession({ subagentChildScope, taskType })`，**两条构造路径都算子会话**——冷恢复没有覆盖包，只能靠 `taskType`。下面凡标"已改变/订正"的条目以此为准）：

不构造（会生成第二份进程级资源或子会话本就不该有的能力）；**第 2 条已按 S5 拍板移出本组（改为照常建）**，保留编号只为让"差异清单 2"这个引用仍然可追：

1. `modelAdapter` + `ApiProviderModelRuntime`：不建第二份模型适配器与模型运行时；`modelFactory` 取覆盖包里的继承工厂。随之不建 `modelTelemetry`（子 span 走覆盖包的 `agentTelemetry`），故 `setModelIoFullRetentionEnabled`、两处 `shutdown()` 在子模式下必须可缺席。
2. `workspaceHookRuntimeSecurity`（hook trust / admission）：**S5 收口拍板改为「与主会话同形」——子会话照常建**（原文写的是"不建"）。原文把它当"子会话不该持有的能力"，但 hook 信任是**工作区级 / 用户级**的决策，不是会话能力面：S2 角色策略表（`packages/shared/src/zcode-protocol-v4/input-role-policy.ts`）本就把 4 条 hook 信任命令对 `subagent_child` 放行（"缺席即放行"），原文的"不建"反而让这 4 条命令在子会话里静默降级成 `workspace_hooks_require_trust_capable_host`，与已批准的策略表自相矛盾。每个会话各持一份 coordinator、只读同一份 trust 文件，不产生第二份权威。判定与理由见第 21 条与 S5。
3. `createMcpAdapter`：不建（会在子会话里再连一遍 MCP）；`mcpPort` 取覆盖包，`ownsMcpPort = false`。
4. `createNodeSkillAdapter`：不建（父的 skill 根已解析）；`skillPort` 取覆盖包。
5. `createNodeContextSourceAdapter`：不建；子会话的 Context 由覆盖包按父快照注入（`currentDate` / `subagentContext` / `envInfo`）。
6. `createScriptWorkflowBridge`（连带 `workflowPort`）、`createDynamicWorkflowRunService`、`createDynamicWorkflowSnippetService`、`createModelCatalogPort`：都不建——这些端口在子会话 deps 里本就不在场（今天也不在），建了只是空转。**特别地，`deps.workflowPort` 必须保持缺席**。
7. `createSessionMailboxPortFromEnv`：**S1b 阶段**不建（当时子会话没有 mailbox，先开等于放出一条未经裁决的输入通路）。**S3 已改变**：收件箱与角色策略一起落地，子会话现在照常拿到 mailbox——但它必须拿**父那一份注入实例**，不自己按 env 建第二份（`resolveSessionMailboxPort` 的注释里有踩坑记录）。
8. 浏览器控制：子会话不接（父调用不传 `browserControlPort`，`nodeReplBrowserBroker` 块自然跳过）。
9. `inputHistoryStore`：不建（子会话没有用户输入历史；S2 开放输入面时再定）。
10. `scheduleStartupLogRetentionCleanup`：不调度（进程级职责，父会话已调度）。
11. 协议侧注入：`sessionMessagePort` 照常注入（子会话要能 `sess_*` 发信）；`sessionMailboxPort` **S3 起也照常注入**（同第 7 条，见 S3 节）；`subagentRosterPort` **不注入**——但收窄现在落在 App 构造入口（`create-app.ts`），不在这里，因为它必须用覆盖两条构造路径的判据（见下面第 21 条与 S5）。

借父 / 复用：

12. `executionPort` / `fileSystemPort` / `httpClientPort` / `imageProcessorPort` / `pdfDocumentPort` / `artifactStore`：借父实例，`ownsExecutionPort = false`。启动遥测的两个"是否注入"同样按"是否来自外部"判（`hasInjectedArtifactStore` 对子会话恒 true、`hasInjectedMcpPort` 看覆盖包），否则会把借来的 store 报成自建。
13. `startupInputs`：必传，复用父的四项解析结果。
14. `sessionStore`：借父（同一个 DB），`ownsSessionStore = false`。
15. `permissionService`：取覆盖包——`workflowFacade` 需要它（explore 是独立只读权限配置，其余继承父实例）。
16. `workflowFacade`：照常构造（保持 `ZCodeApp` 面完整；子会话 runtime 没有 workflowPort，方法不会被触达）。
17. 起始偏好：`{ kind: "inherit", parent }`（与 fork 同一份机制，含 memory / 压缩偏好 / 原生搜索 / shell 选择）。

刻意改变的两处（记明理由）：

18. `eventStore`：子会话**沿用父 record 的 store 实例**（`eventStore: parentRecord.eventStore`），不新建。该 store 按 sessionId 分区，子事件落在自己的分区里；bootstrap 的 `loadPersistedEvents(childSessionId)` 与 `resolveConversationBackingRecord` 一律走同一实例读取，与 `script-workflow-child-runtime.ts` 的既有约定一致（那条注释写明"私建内存 store 时子 transcript 永远读不到"）。这是**沿用既有约定**，不是新选择。
19. 起始偏好走 `{ kind: "inherit", parent }`（D1 明确要求，且 fork 已在用同一份机制）：子会话因此继承父会话的 memory 开关、原生搜索增强、压缩偏好与 shell 选择。与改造前的差别是"子会话不再吃全局默认策略"，这是**有意**的（用户可配置的压缩策略漏继承会让子会话沿用陈旧策略）。
20. 父 record 的 `onSessionEvent` 里那条"事件 sessionId ≠ 本 record sessionId"的分支（现走 `ingestDetachedLiveSession`）本阶段**保留不动**：它按 `(childSessionId, eventId)` 去重，子会话拿到 record 后事件会经两条路径到达网关，但投影只发布一次。改动与删除见 S1b-4。
21. `runtimeConfig.hooks`：**S5 收口拍板改为「与主会话同形」，不再对子会话收窄**——子会话照常跑用户/插件的工具级 hook。原写法是"子会话强制 `enabled: false`"，理由是"hook runner 的构造条件（`config.hooks?.enabled || deps.workspaceHookSnapshot` + `deps.executionPort`）不按 taskType 收窄，子会话会继承 `hooks` 配置并借到父的 executionPort，于是子代理工具调用开始执行用户 hook"。**这个理由把方向搞反了**：hook 是用户对自己 Agent 施加的**规则**，不是子会话可行使的**能力**——收窄它等于给子代理开一条绕过用户护栏（如 `PreToolUse` 拦危险命令）的口子，护栏能被"委派给子代理"绕过就不成护栏；而且子会话本就已在跑内建 mailbox drain hook（只要有收件箱端口，"子会话完全不跑 hook"从来不成立）。判定：子代理的工具级 hook **该跑**。`SubagentStart` / `SubagentStop` 仍由**父** runtime 发射，与这一条无关（那两个事件照常发，不会重复触发）。
    - **S5 收口时的实测与订正（2026-10-08）**：这一条原先只写在 `if (childScope)` 分支里。子会话有**两条**构造路径——派发带覆盖包、冷恢复（S1a）走普通 `createRecord` **没有**覆盖包，只靠 `runtimeConfig.taskType === "subagent_child"` 认身份。于是当时冷恢复出的子会话把收窄全漏掉了（同一种会话两条路径行为不同，且没有任何测试会红）。收口先按唯一判据 `isSubagentChildSession({ subagentChildScope, taskType })` 把两条路径对齐——随后**拍板翻转方向**：既然 hook 是用户护栏而非子会话能力，正确做法是**取消** hooks 与 hook trust 两处收窄，让两条路径都与主会话同形。现在只剩 `subagentRosterPort` 一处收窄（子会话没有子代理可列举，`includeAgent` 门也挡着），仍以本判据为准；`resolveSubagentChildHooksConfig` 已随之删除。回归：`bootstrap/test/subagent-child-session-predicate.test.ts`。
22. 已逐项审计、确认**不需要守卫**的继承项（因为既有门控已经挡住了）：内存提取（`resolveEnabledProjectMemoryRoot` 走 `isMainMemoryTaskType`，`subagent_child` 不在名单里）、标题生成（`shouldAttemptSessionTitleGeneration` 有 `parentSessionId` 与 `taskType !== "interactive"` 两道闸）、顶层 `userInstructions`（有 `subagentContext` 的 runtime 走 `SubagentContextBuilder`，只读 `subagentContext.userInstructions`，不会双份注入 AGENTS.md）、`isRemoteWorkspace`（唯一消费者是内存提取，已被 taskType 挡住）。另：子会话日志改用子会话自己的 logger（带子会话 traceId/sessionId），属诊断面改善。
23. 实现期补记两处（实施时才发现，写进契约免得后人踩）：
    - **`titleGeneration` 在子会话最终缺席**（覆盖包不带它，子路径也没有 `params` 可读）。这是"子会话 runtimeConfig 面比正常会话少一个键"，靠上一条那两道闸兜住；S2 若开放子会话改模型/标题行为，要重新审视这一项。
    - **装配期必填端口一律 fail-closed**：覆盖包里的父作用域端口类型上保留可选性（强制 core 显式回答"这一项子会话有没有"），而 `workflowFacade` 的 `agentTelemetry` / `permissionService` 等在构造期就要求非空。bootstrap 用 `requireAssemblyPort(value, name)` 取值，缺席即抛 `ZCode app assembly is missing the <name> port`——**不静默自建**（自建会丢掉父的 span 归因与已授予权限状态）。真实路径不会触发：core 传的 `agentTelemetry.port` 与 `permissionService` 都是它自己已兜底的非空实例。
24. **`Agent` 工具与构造移交端口同生共死（新不变式）**，逐条核对了 CLI workspace 里全部 3 处 `new AgentRuntime(`：

    | runtime | 有 `Agent` 工具？ | 有 host？ | 结论 |
    | --- | --- | --- | --- |
    | app 顶层（`create-app.ts`） | 是（父） | 是 | 一致 |
    | 子代理子会话（构造入口受限模式） | 否（覆盖包写死 `subagents.enabled: false`） | 否 | 一致 |
    | script workflow child（`script-workflow-child-runtime.ts`） | 否（本就有 `subagents: { enabled: false }`） | 否 | 一致 |
    | **expert workflow child（`workflow-facade.ts`）** | **改前是**（spread 父 `runtimeConfig`，`features.subagent` 缺省 true） | 否 | **不一致，本轮修掉** |

    第 4 行是本轮**改前就存在的"有工具无端口"缺口**：删除 core 的内联构造后，它的 `Agent` 工具会从"能派发"变成"撞 `ConfigurationError` 硬失败"（而不是像今天这样静默成功）。修法是给它写成 `subagents: { enabled: false }`，与同门的 script workflow child 一致；这个 runtime 不走构造入口、在 `context.sessions` 里也没有 record，补 host 只会让孙会话的 `parentSessionId` 指向一条查不到的会话（S3 的递归删除沿树走，会踩到悬空父）。actor 本就不该嵌套编排（`workflow-actor-tools.ts` 已因此减掉 `CreateWorkflow` / `AmendWorkflow`）。
    - **这是对「除 `subagent_child` 外 6 类 taskType 能力面逐项一致」的一处有意偏离**：`workflow_child`（expert 路径）失去 `Agent` 工具。取舍是「一个能用但会悬空的嵌套能力」对「显式关闭的嵌套能力」——后者与既有 actor 治理同向。**若产品上确实需要 expert workflow actor 派生子代理，那是一次独立改动**：要把 workflow child 也升格成正式 record 并让 core 传它自己的 `parentSessionId`，不在 S1b 范围。
    - 同一不变式也解释了为什么 `agentTelemetry` / `permissionService` 走 `requireAssemblyPort`：那两项是**装配期必填**，与「有工具必有端口」是同一个思路——缺件就显式失败，不猜。

record 物化与登记：

- 新增 `createSubagentChildRecord(context, parentRecord, bundle)`：`taskType = "subagent_child"`、`parentSessionId` 来自父 record、`resume` 来自覆盖包；**不复用** S1a 的 launch spec 回填分支（那是冷恢复路径）。
- **两条路径的共用点下沉到 record 装配尾段**：抽出 `createSessionRecordShell(context, input)`（record 形状 + `subscribeEvents` / `unsubscribe`），由 `createRecord` 与 `createSubagentChildRecord` 各调一次。原先写的"共用 `materializeSessionRecord`"不成立——那个函数只是 `resolveSessionStartupPreferences` + `createRecord` 的薄包装，而入参 `ZCodeSessionRecordParams` 是协议参数联合类型，表达不了覆盖包，且它会注入子会话必须不传的 `permissionBroker` / `automationPort` / `browserControlPort` / `workspaceHook*`。共用点下沉后，同形性仍由"调同一个函数"结构性保证。
- 登记 `context.sessions.set(childSessionId, record)` 由 `createChildSession` 在 **App 构造成功之后**执行（不留半登记状态），并在 `bundle.resume` 时**先登记再** `app.resume()`（resume 期间回放出来的事件才能按 childSessionId 正确扇出）。
- **冷恢复路径不变**：`taskType === "subagent_child"` 的孤立子会话（父已不在）仍走 `createRecord` 的完整模式（S1a 已落地）——那时没有父可借，必须自建端口；两条路径产出的 record 形状一致，差异只在"端口从哪来"。
- `createSubagentChildHost` 从 `server-operations.ts` **导出**，供 `test/subagent-child-session.test.ts` 直接钉住这条移交缝（它是 spec S1b 的验收面：父 record 缺席 / 借不到装配事实都必须显式失败）。

失败语义：

- 父 record 缺席、或父 App 没有借出装配事实 → `createChildSession` **抛错**，派发失败并冒泡给 Agent 工具；不静默降级成"跑一个没有 record 的子会话"。
- App 构造失败由 `createZCodeApp` 自己的 catch 清理；此时尚未登记，注册表不留痕。

#### S1b-3 · core 交出子 runtime 构造权

- `runExploreAgent` 改为：算好 profile / skill / MCP / 模型选型 / 工具面 → 组覆盖包 → `host.createChildSession(bundle)` → 在对返回的 runtime 上继续原来那串（`ensureSessionPersistedForExternalActivity` → 写 launch spec → `notifySessionReady` → 非 resume 时 `recordPendingModelChange` / `emitModelSelected` → `registerMessageSink` → `executeTurn` → finally 收尾）。**顺序不变**（launch spec 必须在 session 行之后写）。
- 恢复归属：`resume` 由 `createChildSession` 内部承担（`app.resume()`，与冷恢复同一条），core 不再调 `runtime.resumeFromStore`，只驱动 `executeTurn`。
- 删除：手写的子 runtimeConfig 字面量、手写的 27 键 deps 字面量、那次 `new AgentRuntime(...)`。
- `deriveChildClientPorts` 的调用**保留**（D6：派生点由父 runtime 独占，不能搬到 record 层），只是它的产物改为经覆盖包送达子 runtime。
- 硬约束：`subagent/runner.ts` 的 8 个 `SubagentStart` / `SubagentStop` 发射点与 payload 字段全部保留。

#### S1b-4 · 实测 + 清残留（已完成，结论：不删）

**派发成本：实测「被省掉的那一半」足够大，剩下的部分是纯进程内装配。**

- 子会话改造前**不构造 App**，所以改造后确实新增了「每次派发构造一次受限模式 App」的成本。要证明的不是"零成本"，而是"没有把完整会话启动搬进每次派发"。
- 实测（本机 NVMe、`E:\ZCode` 为工作目录，6 轮）：`resolveStartupInputs` 单次 **23 / 25 / 26 / 28 / 33 / 63 ms**（首轮 63 ms 冷，其后 23–33 ms），观测到 7 个插件、19 个 agent profile、1 个内置技能根、1 个内置 MCP server。这就是子会话**不再付**的那一段（父会话已解析，覆盖包连同 `startupInputs` 一起借出）；插件发现是**同步**的磁盘遍历，冷盘/网络家目录会显著高于此。
- 受限模式另外跳过的进程级/IO 构造项（逐项见差异清单）：MCP 适配器与其启动快照、`createModelAdapter` + `ApiProviderModelRuntime.start()`、skill 适配器、context source 适配器、dwf journal 窄化 + run service + snippet service + model catalog、workspace hook trust/admission、启动期日志保留清理、session mailbox。剩下的只有 `AgentRuntime` 与各 facade 的对象装配（旧路径本来也要构造那个 `AgentRuntime`）。
- **可观测出口**：这些阶段在 `bootstrap.app.startup.{plugins,config,storage,mcp,runtime}.completed` 里各自带 `durationMs`，子会话 App 走同一套 mark。所以线上任何一次派发的成本都能从日志直接读，不需要重新压测。

**detached 残留：查清了，**不删**（含一处对原定分支的偏离，理由如下）。**

- **前置条件不成立**：`ingestDetachedLiveSession` 服务的**不只是** core 子代理。script／dwf workflow actor 今天仍然**没有自己的 bootstrap record**，只靠父 record 的 sink 路由 —— 证据是 `v4-bridge.ts` 的 `loadPersistedEvents`（`resolveConversationBackingRecord`：child 自身没有 record 时按持久 `parentID` 落到父 record）与 `script-workflow-child-runtime.ts` 的共享 event store 约定。所以「改为显式 early-return 并整体删除」这条路不成立。
- **父/子归属簿记也不是子代理残留**，所以原稿写的"只删 children 归属簿记那一半"同样不成立：`detachedChildParent` / `detachedChildrenByParent` 由**同一个** `record.app.sessionId` 分支写入（`server-operations.ts` 的父 `onSessionEvent` 无条件把父 id 传进去），它服务的正是这些仍然无 record 的 actor；而它唯一的读者 `cleanupSessionRuntime` 的递归释放**仍在用**（父会话清理时立即释放其 detached 子发布器）。删掉它会把"父清理即释放"降级成"等 60s prune tick"，是一处纯行为变化、换不来任何简化。
- **因此本轮不动 detached 机制**。等 script／dwf actor 也登记 record 之后，这一段（含 60s tick）可以整体删除；那时 `pruneDetachedChildPublishers` 的存在理由会一起消失。
- **双路径 ingest 已核实无害**（子会话拿到 record 后，其事件既走自己的 record 订阅、也经父 sink 的这条分支）：`ingest` 的序列归一化按 `(sessionId, eventId)` 去重，重复事件直接返回空序列；而尾部的 `fanOutToIndex` / `flushStates` 都在 `ingestNormalizedEvent` 里（`v4-gateway.ts:1015`），**去重事件根本走不到**，所以第二次 ingest 的代价只有一次 Set 查表。
- `hasLiveConversation` **保留全文**：`host.sessionExists` 那一半是 `subscribeReserved` / `rowsRange` / `plans` / `fileChanges` 的主线判据，与 detached 集合无关。
- `guard.subagentReadOnly`：随 S2 的输入面一起拆（本阶段保留只读门，避免半开状态）。
- `subagent-lifecycle` entry（roster）保留：它承载"跑过什么、什么状态"，与身份无关。

验收（S1b 整体）：**已逐条落实**，其中三条有直接契约测试。
- 子会话创建后出现在 `context.sessions` 里；`subagent_child` 的 record 与普通会话同形（`eventStore` / `unsubscribe` / `persistence` 齐备）。（`bootstrap/test/subagent-child-session.test.ts`）
- 子会话**不注册** `Agent` 工具（含刷新路径 `embedded-search-branch.ts`）。
- 派发成本不回归（见 S1b-4）。
- 送侧：移交包的身份事实、套娃闸、父域端口与送序。（`core/test/subagent-child-session.test.ts`）
- **主会话（7 类 taskType）冷恢复与派发行为逐项不变**；子会话可达行为与改造前逐项相同（差异只有第 18 条）。
- 阻塞交互（permission / AskUserQuestion / provider runtime headers）仍然落到**父会话**，子事件只带 `origin`。（`core/test/subagent-child-session.test.ts` 的父域端口组）
- core 侧不再有第二处构造子 runtime 的代码（`new AgentRuntime` 在 subagent 链路上只剩 0 处）。

### S2 · 输入面（角色策略 + 命令集）

改动面（2026-10-07 对着源码订正）：**`@zcode/shared`（角色策略单源表 + 细分 reasonCode，新增模块）**、`bootstrap`（三处强制点改为消费该表）、**`core` 无需改动**（闲时轮一条见下"订正一"）。

#### 策略表：单源、总覆盖、类型级穷尽

新增 `packages/shared/src/zcode-protocol-v4/input-role-policy.ts`，并从同目录 `index.ts` 导出。选这个位置而不是 CLI 的 `contracts`，理由是三条硬约束同时成立才叫"单源"：

1. 表的键之一是 `CommandType`，它就声明在 `packages/shared/src/zcode-protocol-v4/command.ts:268`。表离开 `CommandType` 的定义处，"新增命令必须显式裁决"就只能靠跨包再派生一次。
2. 另一个键是会话角色，根 `shared` 已有 `zcodeSessionKindSchema`（`zcode-protocol-legacy-types.ts:83`，7 类，与 CLI `contracts` 的 `SESSION_TASK_TYPES` 同集合）。
3. **UI 也要读它**（S4 的子会话 composer 要据此禁用/隐藏动作），而根 `packages/ui` 不可能反向依赖 `apps/zcode-cli/packages/contracts`。

形状——**以命令为主键的总表**，每键必须显式裁决（`satisfies` 保证漏键即编译失败，这就是"类型级穷尽守卫"）：

```ts
export type InputCommandDenialReason =
  | "guard.subagentCannotDeriveSession"      // 从子会话派生新会话
  | "guard.subagentCannotEscalatePermission" // 子会话内权限模式不可改
  | "guard.subagentCannotRunGoalLoop"        // 子会话不承载会话级自主目标循环
  | "guard.selectionSideChatRestrictedCommand"; // 既有码，原样保留

export interface InputCommandRoleRule {
  /** 本命令在这些角色下被拒（缺席 = 放行）。 */
  deniedFor?: Partial<Record<SessionRole, InputCommandDenialReason>>;
  /** 该命令是否属于"输入类"（进 ledger / 三档投递）；与准入判定是两件正交的事。 */
  conversationInput?: true;
}

export const INPUT_COMMAND_ROLE_POLICY = { /* 35 键，逐条写 */ } satisfies Record<CommandType, InputCommandRoleRule>;

export function resolveInputCommandAdmission(input: {
  sessionRole: SessionRole;
  command: CommandType;
}): { admitted: true } | { admitted: false; reasonCode: InputCommandDenialReason };
```

- **默认放行**：除 `deniedFor` 列出的组合外一律准入。`deniedFor` 只有两列有值——`subagent_child` 与 `selection_side_chat`；其余 5 类角色无任何拒绝项（与改造前逐项一致）。
- `SessionRole` 直接复用 `zcodeSessionKindSchema` 的 7 类；**不做**"运行中/不运行"两套（用户已定的方向：父子共用一套机制）。
- `conversationInput` 标记取代今天的 `isConversationInputAdmissionCommand` 集合（`v4-bridge.ts:398`）——那个集合是硬编码的 5 条，与准入判定混在一起；拆开后，"哪些命令进 ledger"仍只此一处声明。

`subagent_child` 的完整裁决（35 条逐条定案，其余放行）：

| 命令 | 裁决 | 理由码 |
| --- | --- | --- |
| `createSession` / `createSelectionSideSession` / `forkAssistant` / `startSavedWorkflow` / `resumeWorkflowRun` / `amendWorkflowRunSettings` | 拒 | `guard.subagentCannotDeriveSession` |
| `switchCollaborationMode` | 拒 | `guard.subagentCannotEscalatePermission` |
| `sendGoalCommand` / `resumeGoal` / `pauseGoal` | 拒 | `guard.subagentCannotRunGoalLoop` |
| 其余 25 条（含 `sendText` / `compact` / `stop` / `switchModelConfig` / `renameSession` / `deleteSession` / 全部队列操作 / `sendQueuedNow` / `guideQueueItem` / `applyFileRewind` / `editUserQuery` / `retryTurn` / `setAssistantFeedback` / `discardSharedContext` / `resolveInteraction` / `snoozeInteractionAutoResolution` / `setAutoDrain` / `cancelBackgroundWork` / 4 条 workspace hook 信任类） | 放行 | — |

对原稿的两处修订照旧成立：`sendQueuedNow` 与 `guideQueueItem` **放行**（它们只是操作子会话**自己**的队列）。workspace hook 信任类命令**不进策略表**为"拒绝项"、保持放行——那是用户级信任决策，不是会话能力面。

#### 三处强制点统一消费同一函数

| 位置 | 现状 | 改法 |
| --- | --- | --- |
| `v4-bridge.ts` 的 `admitCommandInput` | 自建 9 条名单 + 抛 `guard.subagentReadOnly` | 改为对**全部** 35 条命令先查策略表（在 `isConversationInputAdmissionCommand` 提前返回**之前**），拒绝则抛带 `reasonCode` 的错误 |
| `server-operations.ts` 的 `sendPrompt`（legacy `session/send`） | 抛 `guard.subagentReadOnly` | 改为查策略表，命令固定为 `sendText` |
| `commands/executor.ts` 的 `selection_side_chat` 门 | 自建 7 条名单 + `V4SelectionSideChatRestrictedCommandError` | 改为查策略表；**保留**这一处作为纵深（它覆盖原生 handler 的执行期，而 `admitCommandInput` 覆盖准入期），但判定只剩一个来源 |

删掉的：`guard.subagentReadOnly` 两个字符串站点（`v4-bridge.ts:1595`、`server-operations.ts:1946`）与 `SELECTION_SIDE_CHAT_RESTRICTED_COMMANDS` 自建集合（`executor.ts:10`）。

#### 订正一 · "闲时轮拒绝子会话输入"不成立（复查后删除该实施项）

原稿写"闲时轮借用前台模型，子会话输入会绕过预算语义"。对着源码复查后**该状态不可达**，因此不写实现代码（写了就是死代码）：

- `offPeakTurn` 只从 host turn options 注入（`prompt-turn.ts:93,100-103`），而闲时派发恒是**主会话**的 turn 且带显式 `offPeakTaskId`；子会话的轮从不带它（`send-message.ts:216` 的 `runtimeScope === "subagent"` 投影可证）。
- 子会话**不注册**闲时工具面：`runtime-tools.ts:74` `includeOffPeak: Boolean(deps.offPeakPort) && runtime.config.taskType !== "subagent_child"`，所以 `assertNotOffPeakTurn`（`core/src/tool/handlers/off-peak.ts:39`）在子会话里无可拦截的调用点。
- 已有的"同规则"确实存在，但它在**工具层**：闲时轮内 `SendMessage` 被 `assertNotOffPeakTurn` 拒绝并给出可执行提示"`Spawn a new foreground Agent with the full context instead of resuming a completed one.`"（`core/src/tool/handlers/send-message.ts:39,75`）。这条**不需要新代码**，只列入验收（断言提示文本与拒绝语义仍在）。

#### 订正二 · 打开输入面**同时**修掉一个静默降级

`SendMessage` 发往 `sess_subagent_*` 时是构造 `sendText` 信封走 V4 面（`session-message-wiring.ts:51-76`）。今天那个信封必然撞上只读门，于是被捕获后**静默降级成投递信箱**并返回 `status: "stored"`（`session-message-port.ts:121-125` 的 `v4 delivery not accepted: …`）。S2 打开输入面后该信封被正常准入，三态语义（`steered` / `woken` / `stored`）因此真正生效——**这是 S2 的验收项，不是 S3 的**（S3 只是把收件箱与 roster 一起接上）。

#### 前置与依赖（已由 S1b 满足）

准入路径对 record 的要求——`context.sessions.get(sessionId)` 有活 record、`record.persistence === "immediate"`（跳过 deferred 分支）、子会话有持久 session 行（`session_input` 有外键）、`saveSessionInput` 存在——S1b 之后全部成立。`guide` 依赖 `activeTurn.steerable`，子会话轮走 `beginActiveTurn(..., "regular", true, …)`（`turn.ts:275`），天然可引导。

验收（S2）：
- 子会话可 `sendText` 开新轮并跑完；三档投递（`startNow` / `queue` / `guide`）对子会话都生效，`guide` 能注入正在跑的子会话轮。
- `compact` / `editUserQuery` / `retryTurn` / `switchModelConfig` / `stop` / 队列操作可用。
- 上表 10 条拒绝项各返回**对应**的细分 reasonCode（不是笼统只读错误）。
- `sendQueuedNow` / `guideQueueItem` 放行。
- **表驱动矩阵测试**：遍历 `commandPayloadSchemas` 的**全部** 35 键 × {`subagent_child`, `selection_side_chat`, `interactive`}，断言 `admitted === true` 或 `reasonCode` 等于表里的值；并断言表的键集合与 `Object.keys(commandPayloadSchemas)` **完全相等**（漏键即失败，这是穷尽守卫的运行时那一半）。
- **回归**：7 类角色里除 `subagent_child` 外，全部命令的准入判定与改造前逐项一致（`selection_side_chat` 的既存 7 条拒绝项与 reasonCode 值不变）。
- 闲时轮：断言 `SendMessage` 在闲时轮的拒绝语义与提示文本不变（订正一）。
- `SendMessage` 到 `sess_subagent_*` 返回 `steered` / `woken`（而非 `stored` 降级），且不再出现 `v4 delivery not accepted` 日志（订正二）。

### S3 · 生命周期（递归删除 + 沿树中止 + 借用不变式）

改动面：`bootstrap`（新增会话树遍历/关停模块、删除递归、中止级联、resident fact 新增与回收门、为子会话开收件箱）。**无需改动 `core`**（订正：原稿写的"core 中止时写终态"不成立——中止走的是 Core 既有的取消收口，见下）。

#### 树的边（唯一判据）

`parentSessionId === X && taskType === "subagent_child"`。**只按 `parentSessionId` 会误伤 fork 与选段侧聊**——它们同样带 `parentID`（`core/src/runtime/methods/session-fork.ts` 多处写 `parentSessionId`），但不是子代理。深度被 D8 结构性限成 1 层（子会话没有 `Agent` 工具），遍历仍写成递归，不依赖该假设。

遍历源 = `context.sessions`（**驻留记录**）。非驻留的子会话没有 runtime，无需也无可关停；持久化行按现有 delete 语义保留。

#### 新增模块 `bootstrap/src/zcode-protocol/session-tree.ts`

导出五个件，删除与中止共用同一份树遍历：

```ts
// 直接子会话（驻留记录中按 (parentSessionId, taskType) 命中）
export function listSubagentChildSessionIds(context, parentSessionId: string): string[];
// 全部后代，先子后孙（预序）
export function listSubagentDescendantSessionIds(context, rootSessionId: string): string[];
// 单会话关停（delete/close 语义）：unsubscribe → app.close → gateway.disposeSession
//   → context.sessions.delete → eventStore.deleteSession。**顺序不可换**：
//   disposeSession 必须早于注册表删除（gateway 靠 context.sessions 定位 workspace 才能推 session.removed）。
export async function closeSessionRecord(context, sessionId: string): Promise<void>;
// 整棵子树关停：先递归子/孙，再关自己（借用不变式要求父后于子）。
export async function closeSessionTree(context, rootSessionId: string): Promise<void>;
// 沿树中止后代会话进行中的轮（不投通知；**根由调用方自己停**，因为根要走
// expectedForegroundExecutionId 精确匹配与 goal-pause barrier）：
//   runtime.stopActiveForegroundExecution({ reason }) + record.activeAbortController?.abort(reason)
export function stopSubagentDescendantTurns(context, rootSessionId: string, reason: string): void;
```

#### 三处接线

| 位置 | 现状 | 改法 |
| --- | --- | --- |
| v4 `deleteSession` handler（`commands/handlers/session-mgmt.ts`）→ `host.closeSession`（`v4-bridge.ts` 内联**4 步**） | 只关自己；**不释放内存 event store** | 改为 `await closeSessionTree(context, sessionId)`——递归 + 补齐 `eventStore.deleteSession` |
| legacy `session/close` op（`server-operations.ts:2752` 的 `closeSession`，**5 步**） | 只关自己 | 改为 `await closeSessionTree(context, params.sessionId)`（保留其 `shouldCloseSessionForExpectedPersistence` 前置判断） |
| v4 `stop` handler（`commands/handlers/session-flow.ts` 的 `stop`） | 只停自己 | 停止根之后追加 `host.stopSubagentDescendantTurns(record.app.sessionId, "parent session stopped")`（新增 host 能力，binder 内联实现调 `stopSubagentDescendantTurns`；handler 只持有 host，没有 context） |

**顺带修掉的既存不一致**：`closeSession` 存在两份实现且步骤数不同（v4 内联 4 步漏了 `eventStore.deleteSession`，legacy 5 步有）。上表把它收敛成 `closeSessionRecord` 一处，v4 与 legacy 只剩调用点。

#### 中止级联为什么不需要新代码也不投通知

- 子会话的派发轮经 `childRuntime.executeTurn(...)`（`core/src/runtime/methods/subagent.ts:441`），而 `executeTurn` 走 `enqueueCancellableRuntimeCommand` → `runRuntimeCommand` → `beginForegroundExecution`（`runtime-command-queue.ts:196,396-421`）：**子会话的轮就是子 runtime 的 `activeForegroundExecution`**。因此 `stopActiveForegroundExecution({ reason })` 能精确中止它（前台 `wait:true` 与后台派发都成立）。
- 中止 → `foregroundExecution.controller.abort` → 该轮以 `CoreErrorType.TurnCancelled` 收口，`turn.ts:809` 映射成 `status: "cancelled"`。终态由 Core 既有路径写，bootstrap 不额外写。
- **不投通知**：父正在被中止，不给它排 task-notification。
- 子会话的 `activeAbortController` 是 bootstrap 层句柄（v4 `sendText` 开轮时置位）；派发轮由 Core 持有 controller，所以两件事都要做——`stopActiveForegroundExecution` 覆盖派发轮与 v4 输入轮，`activeAbortController?.abort` 覆盖 bootstrap 层取消窗口。**child 不跑 goal-pause barrier**：子会话结构上无法有 goal（S2 的 `guard.subagentCannotRunGoalLoop` 拒绝目标命令），调用它只是空转。

#### 常驻回收：父被子 pin（借用不变式的另一半）

- `session-resident-pool.ts` 的 `SessionResidencyFacts` 增加 `hasResidentChildren: boolean`；`isEligible` 增加 `!facts.hasResidentChildren`。
- `session-residency.ts` 的 `readResidencyFacts` 供应它：扫 `context.sessions` 找 `(parentSessionId === sessionId && taskType === "subagent_child")` 的驻留记录（O(驻留数)，上界是 `highWaterCount`）。
- 这一条**只挡父会话被回收**，不改子会话自己的资格；回收仍单会话、不递归。
- 已被 `hasRunningBackgroundTasks()` / `hasActiveOrQueuedTurnWork()` 覆盖的两种情形不受影响（后台子代理运行中父本就被 pin）；补的是"子会话驻留但父无任何在前工作"的两条可达缺口（见 D5 借用不变式）。
- 代价（记录在案）：极端情况下驻留数可超过 `highWaterCount`——正确性优先于内存上限。

#### 为子会话开收件箱（保留 roster 关闭，订正 S1b 注释）

- `workspace-model-runtime.ts` 去掉 `sessionMailboxPort` 上的 `!isSubagentChild` 门：子会话要有收件箱，`stored` 落库的消息才有人 drain（D4；S1b 时先不开是因为"未裁决的输入通路"，S2 已把角色策略接上）。
- **`subagentRosterPort` 保持关闭**（订正 S1b 注释里"两项一起开"的说法）：`ListAgents` 的注册门就是 roster 是否存在（`list-agents.ts:61` 的注释"注册门已保证父会话才装上本工具"），而子会话结构上不能派生子代理，roster 对它是**恒空**——开了等于给一个假能力，并推翻该注册门的既有断言。因此只对齐 mailbox，不捎带 roster。
- `sessionMessagePort` 已注入（S1b），不动。

验收（S3）：
- 删除父会话 → 驻留的子/孙 record 从 `context.sessions` 消失，且**子先于父**关停；每个节点的内存 event store 都被释放；重复删除幂等（不抛错）。
- 删除只命中 `(parentSessionId, taskType="subagent_child")`：同 workspace 的 fork / 选段侧聊**不被删**（树遍历单测直接断言）。
- 中止父会话的运行轮 → 子/孙进行中的轮以 `cancelled` 收口；子会话 record **仍在** `context.sessions`（中止不关会话）。
- 父被 idle 回收：**有驻留子会话时不被回收**（pool 直接跳过，且不级联子会话）；子会话全部回收后父重新可回收。
- 关闭父标签页、父变 idle → 子会话不受影响。
- 子会话被单独唤醒（v4 `sendText`）后能跑完一整轮——它借的 `mcpPort` / `executionPort` / `modelFactory` 仍活着（借用不变式的回归面）。
- 子会话自身空闲可被回收，回收后再被单独唤醒仍可跑完。

### S4 · UI（施工规格见下节）

改动面：
- `bootstrap`（前置 1 的强制面：record 事实 + `AvailabilityContext` + `computeInputRouting` + 准入拒绝）、
- `shared`（前置 2 的角标字段 `SessionSummary.runningSubagentCount` + 角色策略的受限模式理由码）、
- `ui`（左栏层级列表、子会话面板形态化、状态角标、授权提示、原因文案）。

### S5 · 收口

**残留清单（2026-10-07 逐项复核；结论：无可删代码项，只需订正 spec 口径）**

| 原定删除项 | 复核结论 |
| --- | --- |
| `ingestDetachedLiveSession`、`detachedChild*`、`pruneDetachedChildPublishers` | **不删**。S1b-4 已查清：它们服务的还有 script / dwf workflow actor（今天仍没有自己的 bootstrap record），且 `cleanupSessionRuntime` 的递归释放仍在用；删掉会把"父清理即释放"降级成"等 60s prune tick"。等 actor 也登记 record 后整体删除。 |
| 只读门（原稿的 `guard.subagentReadOnly`） | **已删**：随 S2 的输入面一起拆，全仓 grep 零命中。 |
| 手写的子 runtimeConfig 字面量、27 键 deps 字面量、那次 `new AgentRuntime(...)` | **已删**（S1b-3 交付，子 runtime 构造只剩一条路径）。 |
| "逐项清点分叉" | **已由覆盖率断言取代**，见下。 |

**角色策略覆盖率（订正原稿的「19 处」）**：那个 19（core 13 + bootstrap 4 处真分叉 + 2 处只读门）是改造**前**的实测，现在不成立——只读门已删、4 处准入分叉已收敛进单源表，三处强制点（legacy `sendPrompt`、V4 的 `v4-bridge.resolveRoleCommandAdmission`、原生执行器 `zcode-protocol-v4/commands/executor.ts`）都只调 `packages/shared/src/zcode-protocol-v4/input-role-policy.ts` 的 `resolveInputCommandAdmission`，没有第二套判定。

覆盖率断言落在 `packages/shared/test/input-role-policy.test.ts`，是"策略表为准的遍历断言"而非逐项清点：策略表键集与 `commandPayloadSchemas` **完全相等**（新增命令不改表即红）、`subagent_child` / `selection_side_chat` 的完整拒绝集与 reasonCode 逐条钉死且其余命令逐条断言放行、其余 5 类角色对全部命令放行、`conversationInput` 恰为 5 条、受限模式的四条契约。类型级那一半是 `satisfies Record<CommandType, InputCommandRoleRule>`。

剩余的 `"subagent_child"` 字面量（按 `grep -rn '"subagent_child"' <pkg>/src` 实测：core 14 处代码 + 2 处注释，bootstrap 10 处代码 + 3 处注释）已逐处复核归属，**没有输入准入分叉**，都属于身份/工具面/遥测/观察，保留：

- 工具面：`tool-allowlist.ts`、`runtime-tools.ts` 的 agent / automation / offPeak / coordinator 面；
- runtime 作用域投影：`runtimeScope`、`isSubagentChildRuntime`（工具上下文按它判身份）；
- 标注类：`model-request-session-type.ts`、`turn-model-step-usage.ts`、`runtime-telemetry.ts` 把子会话标成 `subagent`；
- 生命周期与树：`session-tree.ts` 的单点常量（S3 的唯一树边判据）、`subagent-session-query.ts` 与 `subagent-observation.ts` 的 children 查询、`server-operations.ts` 的 record 构造与受限模式置位。
- `packages/services` 的 3 处按 `sessionKind` 判定（任务索引排除子会话）按 D7 不改：`zcodeTaskIndexSyncer.ts:1674` 早退、`zcodeTaskServiceAdapter.ts:1638`、`repairSubagentTaskIndex.ts:34`。

**文档同步（2026-10-07 完成）**：

- `subagent-session-messaging.md` 补三处：D2 增加「S1b / S2 之后的订正」（子会话升格为 record 后，投递三档判定与正式会话同形，`steered` / `woken` 对子会话才真正可达，此前一律静默降级成 `stored`）；D8 注明**本端口不是左栏层级的数据源**（左栏走父会话投影，见前置 2）；失败语义增加「投递给受限模式子会话」的完整语义（准入拒绝 → `stored`，且因三个 drain 挂钩都要求先跑起回合，这封信封在它被修复前不会被消费），并把"把 `detail` 透出给模型"作为一条带触发条件的工程项登记进它的遗留工作。
- `CONTEXT.md` 的 Subagent Session 词条改成现在时描述**已落地**的事实（可输入 / 可续聊 / 可被单独唤醒、受限模式恒拒输入、删除递归 / 中止沿树 / 常驻不级联、不进任务索引、不得再派生子代理），删掉原来"改造目标…尚不可输入"的目标态措辞，并在 `_Avoid_` 里补上"把子会话与 fork / 选段侧聊混为一谈（树边只认 `parentSessionId` + `taskType === "subagent_child"`）"。

**收口时修掉的两处"两条路径不一致"（都属于静默行为变化，已修 + 已加回归断言）**：

| 症状 | 根因 | 修法 |
| --- | --- | --- |
| 收件箱端口：派发路径的子会话**没有**收件箱，冷恢复的反而有（S3 的"对子会话照常注入"对派发路径完全无效） | `create-app.ts` 的三元 `childScope ? undefined : (injected ?? env)` 把**注入进来的那份也一起丢了** | 抽出 `resolveSessionMailboxPort`（注入优先；子会话无注入不自建），调用点改用它。回归：`bootstrap/test/subagent-child-mailbox-port.test.ts` |
| hooks / hook trust：冷恢复的子会话**照跑**用户与插件的工具级 hook、并持有 hook 信任权限；派发的子会话两样都没有 | 差异清单 2 / 21 的收窄只认覆盖包，冷恢复路径没有覆盖包 | 先抽出唯一判据 `isSubagentChildSession({ subagentChildScope, taskType })` 把两条路径对齐；再**拍板取消**这两处收窄（hook 是用户护栏、不是子会话能力，见第 21 条），两条路径都改为与主会话同形。`subagentRosterPort` 的收窄保留并改用同一判据。回归：`bootstrap/test/subagent-child-session-predicate.test.ts` |

**已拍板（2026-10-08）：子代理（子会话）跑用户配置的工具级 hook，与主会话同形。**

- 判定：hook 是用户对自己 Agent 施加的**规则**，不是子会话可行使的**能力**。能力面该收窄（不派生子代理、不跑 automation / off-peak、受限模式拒输入……），但把规则豁免掉是反方向的——等于让用户写在 `PreToolUse` 里的护栏（拦危险命令等）被"委派给子代理"绕过。护栏能被绕过就不成护栏。
- 第二条决定性证据：**原有的"子会话不建 hook trust / admission"与已批准的策略表自相矛盾**。S2 角色策略表 `packages/shared/src/zcode-protocol-v4/input-role-policy.ts` 对 4 条 hook 信任命令在 `subagent_child` 上**放行**（`respondWorkspaceHookReview: {}` 等，"缺席即放行"），理由是"那是用户级信任决策，不是会话能力面"；而"不建 `workspaceHookRuntimeSecurity`"却让这 4 条命令在子会话里静默降级成 `workspace_hooks_require_trust_capable_host`。
- 落地：**取消**差异清单第 2、21 条的两处 hooks / hook trust 收窄。子会话按自己的会话身份跑同一套 hook、接同一份信任准入（信任是工作区级 / 用户级事实，各会话各持 coordinator、只读同一份 trust 文件，不产生第二份权威）。`SubagentStart` / `SubagentStop` 仍由父 runtime 发射，不受影响、不重复触发。
- 代价（如实记录）：子代理的每次工具调用都会触发用户 hook（子进程开销随子代理数放大），且每个子会话多一份 trust coordinator 与一份 admission。这是护栏真正生效应付的代价，且与主会话行为一致，不再有"哪种会话才拦"的分裂。
- 与 D1 的对齐：Claude Code 的 hook 在子代理内同样运行，本方案与其一致；"hook 脚本可平移"的兼容目标不受影响。
- 回退口径：若将来要改回收窄，**两条构造路径必须一起改**（用 `isSubagentChildSession` 判据），不能再出现"一条路径生效、另一条静默漏掉"。

## UI 施工规格（S4）

### S4 前置：两处订正（施工前必读，两条都会挡住下面任何一条）

#### 前置 1 · 受限模式缺协议信号（真缺口，本轮补）

原稿的失败语义写了"launch spec 缺失 → 受限模式 → **输入面关闭（等同现状只读）** + UI 标注身份未还原"，但 S1b 只落实了 fail-closed 的 `subagents: { enabled: false }` 那一半：

- `buildSubagentChildRuntimeConfigOverrides(undefined)` 只回 `{ subagents: { enabled: false } }`，**不回填任何身份事实**；此时子会话落回**默认工具面**（父在被派发时冻结的 explore 白名单整个丢失）。这是一处**能力放宽**，不只是"少了个提示"。
- "输入面关闭"没有任何实现：`admitCommandInput` 的角色裁决只按 `taskType` 判（S2），受限子会话的 `taskType` 同样是 `subagent_child`，因此照样放行 `sendText`。
- 于是 S4 要的两条 UI 要求（composer 禁用 + 顶部一行说明原因）**没有数据可依**。

补法（单源＝既有的 `inputRouting`，不新增快照字段）：

| 环节 | 改法 |
| --- | --- |
| record 事实 | `ZCodeProtocolSessionRecord` 增静态事实 `subagentLimitedMode?: true`；`createRecord` 在 `taskType === "subagent_child" && subagentLaunchSpec === undefined` 时置位（判定点就是已有的那次 `readSubagentLaunchSpec`，不新增读盘） |
| 投影 | `AvailabilityContext` 增 `subagentLimitedMode: boolean`；`computeInputRouting` 的**首条**判定返回 `{ mode: "reject", reasonCode: "guard.subagentLimitedMode" }`——排在 `compacting` 与 phase 判定**之前**，因为受限会话的输入面与 phase/队列无关 |
| 准入（强制面） | `resolveRoleCommandAdmission` 对受限子会话的**对话输入类**命令（`isConversationInputCommand`）拒绝，`reasonCode` 同上。UI 禁用是体验，准入拒绝才是边界 |
| UI | composer 既有的 `mode === "reject"` 门已禁用发送与改写回车提交；本轮补"顶部一行说明原因"，按 `reasonCode` → i18n 映射渲染 |

`inputRouting.mode = "reject"` 这条既有形状本就是为"输入被拒 + 给得出原因"设计的（schema 注释：`mode=reject` 必带 `reasonCode`），本轮把它从"无生产者"变成受限子会话的生产者。

**实施落点（已落地，2026-10-07 复核后补记；三处比原表多出来的都是正确性所必需，不是扩边）**：

| 落点 | 文件 | 备忘 |
| --- | --- | --- |
| record 事实 | `bootstrap/src/zcode-protocol/server-types.ts` + `server-operations.ts` | `createSessionRecordShell` 增可选入参并以条件展开写键（不写 `undefined` 键） |
| 投影上下文 | `bootstrap/src/zcode-protocol-v4/projection-state.ts`（`AvailabilityContext` + `createInitialConversationSnapshot` 第三参）、`product-projection.ts`、`conversation-topic-publisher.ts` | ⚠ **两处 context 都要带该字段**：`deriveContext` **和 `controlPatch` 里的内联 context**。只补前者会让任何 control 变化（含轮起止）用假值 context 重算 `inputRouting`，受限会话一进 running 就退回 `enqueue`——这是实测撞到的 TS2345，不是防御性冗余 |
| 取值通路 | `v4-gateway.ts` 的 host 能力 `getSessionSubagentLimitedMode` + `ensurePublisher`；`v4-bridge.ts` 的 `resolveRoleCommandAdmission` 与 host 绑定 | 取值与 `seedPublisherConfig` 同姿态（可选 + try/catch 后置默认）；`rehydrate` 的**两个候选 publisher** 都要带该字段，漏传则重水化后失效 |
| 准入强制面（**第三处**，原表只写了 V4 准入） | `server-operations.ts` 的 legacy `sendPrompt` 路径 | `input-role-policy.ts` 文件头写明"三处强制点（V4 准入 / legacy `session/send` / 原生执行器）统一消费本表"；legacy 侧不注入该事实，受限子会话仍能经 `session/send` 续聊，边界就漏一条 |
| 角标 | `shared/src/zcode-protocol-v4/sessions-index.ts`（`runningSubagentCount?`）+ `bootstrap/.../sessions-index-projection.ts`（派生 + `summariesEqual` 判等） | 为 0 或缺席时整键不出；`summariesEqual` 必须覆盖它，否则角标变化不产 delta |

`AvailabilityContext` 不导出（模块内部类型），测试用 `Parameters<typeof computeInputRouting>[0]` 取型，不为测试扩大源文件导出面。

**孤儿会话的边界（有意收窄，记录在案）**：受限模式的判据只有一个——**launch spec 读不到**。"父会话已删除"不另设第二判据：S3 之后父删除会递归删除子会话，且父被驻留子会话 pin 住，正常产品路径产不出"有父指针但父行不存在"的子会话；真出现这类数据损坏行，它的 launch spec 通常仍在，行为与普通子会话一致。为一个不可达路径加分支等于死代码，因此原文那句"孤儿会话按受限模式关闭输入面"改为**按同一判据**（spec 也读不到时才是受限模式）。

#### 前置 2 · 左栏数据源订正（推翻原稿 D7 指定 `SubagentRosterPort` 的说法）

原稿 D7 写"数据源改用 `SubagentRosterPort`，不用 `session/subagents`"。复核后（2026-10-07）这句话在两处不成立：

- `SubagentRosterPort` 是 **CLI 侧端口**（`createWorkspaceZCodeApp` 注入给父 runtime，供 `ListAgents` 合并历史），**没有**跨到 renderer，UI 拿不到它。UI 侧现有入口是 `useSessionSubagents`（→ `zcodeAgentService.listSessionSubagents` → `session/subagents`）。
- 该端口**按设计不能断言 `running`**（`subagent-roster.port.ts` 文件头："`running` 永远只能由本进程的 runtimeTaskRegistry 断言——历史里只有 spawn、没有终态时必须报 `lost`"）。而左栏区块要的就是 `running` 脉动点，roster 单靠自己给不出。

实测可用且同源的权威数据（都不新增第二真相源）：

| 用途 | 来源 | 依据 |
| --- | --- | --- |
| 子区块的 `running` 明细（标题 + 状态） | 父会话 conversation 权威投影 `snapshot.subagents` | `product-projection.ts` 的 `materializeSubagentProjection`：由 transcript 的 `subagent` 行 + `pendingInteractions.origin` + `backgroundWorks` 派生，`waiting` / `blocked` 都在这里判定 |
| 子区块的 `ended` 明细（≤8 行）与"还有 N 个" | 父会话**投影**的 `endedTotal` + 既有分页查询 `session/subagents` 的 `ended` 页 | 与 `SubagentDirectorySidePane` 逐字相同的用法（`snapshot.subagents.running` + `useSessionSubagents`），目录面板已在生产使用这条组合 |
| 父未选中时的**计数角标** | `SessionSummary.runningSubagentCount`（sessions-index 新增，服务端从同一 snapshot 派生） | 列表 delta 已有推送通道；父会话有在跑子代理时它必然是 live 投影，派生零额外 IO |

查询只在**父条目被选中**时发一次（≤8 行 + 一次分页查询），不进任务索引、不常驻轮询——D7 的实质要求（轻查询、不进任务索引、不可用要有失败态）全部保留，改的只是"用哪个端口"。`useSessionSubagents` 的 `error` 承担失败态（原稿要求的"显式标记不可用"在 UI 上落成这一条，不再要求改 CLI 侧只读端口契约——那条契约的注释本身就是为 `ListAgents` 写的）。

### 左栏任务列表：层级态

- **位置**：父会话条目**下方**的子区块，仅在父条目处于选中态时渲染。
- **数据**：父被选中时取自父会话投影的 `subagents.running`（`running` 明细）与 `session/subagents` 的 `ended` 首页（≤8 行）；"还有 N 个"用投影的 `endedTotal`。不塞任务索引（见前置 2）。两条实测口径写死在这里，避免后人当 bug 改：同一 `childSessionId` 短暂地同时出现在"运行中"与"已结束"分页里时**只保留运行中那行**（否则出现重复行与重复 React key）；"还有 N 个" = `endedTotal` − 已显示的已结束行数，其中 `endedTotal` 的投影口径是 `childSessionIds.length - running.length`，运行中的本来就不计在内（`packages/ui/src/v4/subagentSubBlockModel.ts` + 其单测）。
- **取投影的通路（实测后的结论，左栏原本没有数据面）**：左栏子树**不在**任何 V4 conversation provider 内（`V4ConversationProvider` 只挂 `V4ChatPane`，`V4PaneConversationProvider` 只挂各 side pane；左栏是同一 layout 里的 `<aside>` 兄弟节点）。因此子区块**自带一个 `V4PaneConversationProvider`**（scope 取该父条目的 workspace/identity/remoteSessionId），再在其内 `useV4Conversation().layer.acquire(parentTaskId)` + `useConversationProjection`，读法与 `SubagentDirectorySidePane` 逐字相同。代价可忽略：`acquireWorkspaceConnection` 按 endpoint+workspaceKey 建连接并 refCount，主 pane 订阅的同一 workspace 会**复用**这条 transport/layer，不新增连接。远端 workspace 未连接时该 provider 返回 `null`，子区块自然不渲染（fail-closed，与 side pane 行为一致）。
- **子条目控件形态**：
  - 缩进一级；左侧 `BotIcon`（约 12–14px，颜色缺省 `text-foreground-subtle`）。
  - 标题：子会话 title，单行截断。
  - 右侧状态指示：`running` / `waiting` / `blocked` 用 `LoaderCircle`（转）或 `PauseCircle`；已结束按 `session/subagents` 的终态 `success` `CheckCircle2` / `failed` `CircleAlert` / `cancelled` `Ban` / `lost` `CircleDashed`。**沿用 `subagentDirectory.status.*` 的同一套图标与文案，不新造第二套状态语汇**；不新增 `killed` 取值，不单靠颜色区分（配 `aria-label`）。已结束项的状态与图标逐字复用 `SubagentDirectorySidePane` 里那个 `StatusIcon`（该函数应上提为共享件，不要复制一份）。
  - 点击 → 经壳层既有的 `handleOpenSubagentSession`（`OpenScopedSubagentSideTabRequest` → `openSubagentSessionSidePane`）。左栏目前**没有**这条 prop/context，需要新增：照 `WorkflowRunOpenProvider`（`v4/workflowRunOpenContext.tsx`，挂在 `WorkspaceShellLayout` 里包住 `WorkspaceSidebar`）的先例加一个 context，避免把回调穿过 4 个 section。
- **插入点（三个，不是一个）**：左栏的"一行"有**两种行组件**，必须都覆盖：
  - Timeline / Pinned 走 `MemoTaskItem`（`TaskListItem.tsx` 的 `<li>`），列表是**普通 `.map`**（非虚拟化）→ 在 `ul` 内该行之后追加同级的子区块节点（`<li>` 或 `<div>`）。
  - Archived 走**自己内联的 `<li>`**（`WorkspaceArchivedTasksFlatSection.tsx`）→ 同上追加。
  - Grouped 走 `GroupedTaskItem`（`workspace-grouped-tasks/task-item.tsx` 的包装 `div`，顶层与组内**共用一个组件**）→ 插在包装 `div` 内、`<GroupedTaskRow/>` **之后**（在行自己的背景/内边距之外，不会被 `bg-selected` 卡片吞掉）；Grouped 有虚拟化，但两处虚拟列表都用 `rowVirtualizer.measureElement`，元素变高会被重新量回，不会与相邻行叠压。
  - Grouped 的顶层与组内共用 `GroupedTaskItem`，所以 Grouped 只需改一处；加上 Timeline/Pinned 一处与 Archived 一处，共三个插入点。
  - ⚠ 行级点击陷阱：`TaskListItem` 的 `<li>` 自身带 `onClick={handleSelect}` 与 `tabIndex`。子区块内的按钮必须 `event.stopPropagation()`（否则点子代理会连带再选一次父会话、并触发父行的 `onContextMenu` 绑定）。
- **状态**：
  - 空：**不渲染区块**，不显示空态占位。
  - 加载：区块位置渲染 2 行同高占位（仓库**没有**通用 Skeleton 组件，`TaskListLoadingHint` 是"Spinner + 文案"的整列表提示，不适合块内——用与子条目同高的两行占位，`animate-pulse` + 现有圆角/缩进 token 即可）。
  - 失败（含查询不可用）：一行 `text-ui-xs text-foreground-subtle` 文案 + 重试按钮（`useSessionSubagents` 的 `error` + `refresh()`；`refresh` 目前无人消费，本轮是它的第一个重试入口）。文案 id 用 `subagents.list.loadFailed` / `subagents.list.retry`，不新增 `common.retry` 复用。
  - 超过 8 个：区块底部一行"还有 N 个已结束的子代理"，点击打开现有子代理目录面板。
- **父未选中**：不渲染子区块；若该父会话有 `running` 子代理，父条目右侧显示计数角标（`Badge variant="secondary"`，纯数字），数据取 `SessionSummary.runningSubagentCount`（`running` 与 `waiting` / `blocked` 都算"在跑"——它们都是未收口的子代理）。该字段 CLI 侧已派生（S4 前置 1 一并落地），**UI 侧还差四处透传**才能到行组件：`v4/taskListRowActivity.ts`（活动 sidecar 加字段）→ `v4/mapSessionSummaryToTaskMeta.ts`（sessions-index 摘要映射）覆盖 Grouped/Workspace 列表；`packages/shared/src/zcode-protocol-v4/controller.ts` 的 window-host controller 活动 schema 加可选字段 → `packages/desktop/src/host/windowHostControllerService.ts` 透传，覆盖 `useGlobalTaskList`（Timeline/Pinned/Archived）。角标插在**右侧元信息簇内、时间之前**，避开左侧 16px 前导槽（error/unread/spinner/pin 都占那里）。因此它继承该簇的既有可见性（父行挂着「等待确认」胶囊时整簇让位、归档确认中隐藏）：计数是次要信号，不为它在同一排挤掉交互提示。这属于既有优先级的自然结果，不是新增规则。
- **动效**：不做展开/收起开关。区块只在**该父条目被选中**时出现，选中本身就是"我要看这条会话"的意图；再叠一个手动收起，等于把"看不看子代理"变成第二个要维护的状态。占位行用 `animate-pulse`，不做新动效。
- **远端父会话**：子条目可见但只读（D10）。
- **文案**（落在 `packages/ui/src/i18n/locales/{zh-CN,en-US}.ts`）：
  - `subagents.list.loadFailed`：`子代理列表加载失败` / `Failed to load subagents`
  - `subagents.list.retry`：`重试` / `Retry`
  - `subagents.list.moreEnded`：`还有 {count} 个已结束的子代理` / `{count} more finished subagents`
  - `subagents.list.runningBadge`：`{count} 个子代理正在运行` / `{count} subagents running`（**角标的无障碍名**：徽标本身只画数字，屏幕阅读器读到一个孤立数字没有意义，所以需要 `aria-label`）
  - 子条目的状态词复用既有的 `subagentDirectory.status.*`（`running` / `waiting` / `blocked` / `success` / `failed` / `cancelled` / `lost` 七态齐备），不另起一套文案。

### 侧栏子会话面板：从只读变可输入

- **顶部条**：`BotIcon` + 标题 + 身份徽标 + 状态词。
  - 状态词由**父会话投影**派生（面板本就要为下面的授权提示建父会话租约，不新增订阅）：从 `snapshot.subagents.running` 按 `childSessionId` 命中 → `running` 运行中 / `waiting` 等待确认 / `blocked` 受阻；未命中 → 已结束（`subagents.pane.status.ended`）；父投影尚未就绪 → **不渲染**（不闪一个错的词）。
  - 落地方式：`SessionPane` 增可选 `paneTopStrip?: ReactNode`，在根布局对话区**之上**渲染；`observe` 形态或未传时为 `null`，既有行为不变。
- **输入区**：复用正式会话 composer。差异：
  - 隐藏权限模式切换（D9 不可改）。
  - 保留模型选择（可切）。
  - **保留三档投递**（普通 / 引导 / 立即，`requestedDelivery: queue | guide | startNow`）：这是 2026-10-05 落地的 composer 能力，对子会话同样有意义——"引导"就是不打断当前轮、在 tool batch 边界注入，"立即"才抢占。
  - **保留队列面板**：子会话忙时同样会排队，队列项操作（引导 / 立即 / 编辑 / 重排 / 删除 / 自动放行）按 D3 放行，不另做简化版。
  - 保留上下文用量与 compact 入口。
  - 保留行内 `editUserQuery` / `retryTurn` 控件（D3 放行）。
  - 受限模式（`snapshot.inputRouting.mode === "reject"`）：composer 保持挂载但禁用，顶部一行说明原因，文案由 `inputRouting.reasonCode` 映射（`guard.subagentLimitedMode` → `subagents.pane.limitedMode`；未知 code 走通用 `subagents.pane.inputRejected`）。**不新增快照字段**：原因走既有的 `inputRouting.reasonCode`。
- **形态选择**：`SessionPane` 现有的 `readOnly` 太粗（同时关掉 composer、drop target、取消后台任务、edit/retry/fork），`selectionSideChat` 则已经实现了"保留 composer + 隐藏 edit/retry/fork/goal"这一形状——子会话要的是**第三种黑名单**（保留 composer 与 edit/retry，去掉 fork/goal/权限模式）。实现上把黑名单参数化并给这一形态命名，不要新增一个整块的布尔开关。四个形态与各自的能力面：

  | 形态 | composer | drop target | edit / retry | fork | 助手反馈 | goal 展示 | goal 命令 | 权限模式选择器 | 取消后台任务 | 划词动作 | 别名为框选副屏 opener | 文件撤销 | 工作流 run journal 查询 |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | `interactive`（默认） | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 有 | 是 | 有 | 有 |
  | `observe`（远端只读 workspace / workflow actor） | 无 | 无 | 无 | 无 | 无 | **有** | 无 | 无 | 无 | 无 | 否 | 仅 `allowWorkspaceFileRewind` | 无 |
  | `selectionSideChat`（框选副屏） | 有 | 有 | **无** | 无 | 无 | 无 | 无 | 有 | 有 | 无 | 否 | 有 | 有 |
  | `subagentChild`（子代理子会话，**本轮新增**） | 有 | 有 | **有** | 无 | 无 | 无 | 无 | **无** | 有 | 无 | 否 | 有 | 有 |

  实现落点（键名与上表逐列对应，落在 `packages/ui/src/v4/sessionPaneCapabilities.ts`）：`readOnly` → `shape === "observe"`；`forkActionsEnabled` → `fork && seed`；`suppressGoalCommands` → `!goalCommands`（即 `shape !== "interactive"`）；goal 的**展示**两处（`statusPanelModel.goal` 与状态面板的 `goal` 入参）→ `goalPanel`，**与 goal 命令分开**——只读视图本来就看得到 goal 进度、只是没有控制入口，把展示一起关掉是信息量退化而不是"统一语义"（S4 复核时发现并订正：原方案这一段写作"六项抑制条件统一为 `shape !== "interactive"`，`observe` 被 `readOnly` 已经挡住、语义不变"，但 `observe` 的 goal 区块此前是渲染的，按原写法会静默关掉它）；`pauseGoal` / `resumeGoal` → `goalCommands`；`assistantFeedback` 单独成列（真值向量与 `goalCommands` / `selectionActions` 目前一致，但同值不是同一业务，不合并）；权限模式选择器仅在 `subagentChild` 形态下不挂载。
- **`subagentChild` 形态只给本地子会话（D10 的落点）**：面板形态按 workspace 是否远端分支——`isRemoteWorkspaceTarget({workspacePath, workspaceIdentity, remoteSessionId})`（`lib/workspaceServiceResolver.ts`，`useWorkspaceTaskLists.ts:294` 同源用法）为真则 `observe`，否则 `subagentChild`。远端不开口子：父↔子 mailbox 不跨机器共享，开输入面等于放出一个"能打字但接不通父会话"的面板。顶部条（状态词 + 授权提示）对远端**照常渲染**，`observe` 只是没有 composer。
- **权限模式选择器为什么只能在 UI 侧藏**：composer 的模式选择器读的是 **workspace 级** `configOptions`（`v4-workspace-config.ts` 的 `toV4WorkspaceConfigState`，数据源是"该 workspace 第一个在册会话的 settings"）——它是 workspace 作用域的，同一个 workspace 的父会话与子会话共用一份，服务端按会话裁剪会把父会话的选择器一起关掉。因此这里由 UI 形态决定，强制面仍由 S2 的 `guard.subagentCannotEscalatePermission` 承担（纵深：藏起来 + 发出去也被拒并给出 reasonCode）。
- **Plan 勾选项一并隐藏**：它与三种权限模式在同一个菜单里、走同一条 `switchCollaborationMode`，而该命令对子会话被 S2 拒绝；只藏一半会留下一个必定失败的控件。
- **授权请求提示（新增，必需）**：当父会话上存在属于本子代理的待处理交互（`origin.kind === "subagent"` 且 childSessionId 匹配）时，面板顶部显示可点击提示，点击切到父会话标签页；无请求时隐藏。
  - 读法与该条件的**唯一权威实现**逐字对齐（`product-projection.ts` 的 `materializeSubagentProjection`）：遍历父投影 `snapshot.pendingInteractions`，先 `if (!("origin" in interaction.payload)) continue;`（`workspaceHookReview` 的 payload 没有 `origin` 字段），再判 `origin?.kind === "subagent" && origin.childSessionId === 自身`。
  - 点击切父会话复用壳层既有的 `handleSelectTaskInChat`（它负责 workspace 激活、`selectWorkbenchSession`、切回 chat 视图）；pane 侧只经新增的可选 prop `onOpenParentSession` 上报目标坐标（`parentSessionId` + tab 上已有的 workspace/identity/remoteSessionId），不自己拼协议或路径。
  - 视觉：**等待确认色族** `bg-interaction-confirmation-surface` / `text-interaction-confirmation-foreground`（`DESIGN.md`：等待确认不得用 success 色族）。
- **已终止子会话**：终态摘要落在**顶部条的状态词**（`subagents.pane.status.ended`），不再单独在面板底部加一条——composer 占据面板底部，另加底栏会与它争夺同一位置，而"这个子代理已结束"恰恰是打开面板时最该在顶部一眼看到的信息。composer 仍可用（续聊=开新轮）。
- **空态**：复用现有会话空态。
- **文案**：
  - `subagents.pane.identityBadge`：`子代理 · {agentType}` / `Subagent · {agentType}`
  - `subagents.pane.pendingInParent`：`有 {count} 个请求等待在父会话处理` / `{count} request(s) pending in the parent session`
  - `subagents.pane.limitedMode`：`此子代理的身份未能还原，暂不可输入` / `This subagent's identity could not be restored; input is disabled`
  - `subagents.pane.inputRejected`：`此会话当前不接受输入` / `This session does not accept input right now`
- **文案落地方式**：`{zh-CN,en-US}.ts` 是**扁平 dotted key 的 `Record<string, string>`**（不是嵌套对象），按既有 `subagentDirectory.*` 的写法加同级的 `subagents.*` 键即可。

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
9. 在子会话尝试 fork / 切换权限模式 → 控件不存在（fork 行内动作不渲染、模式选择器不挂载），发命令直发也被拒并给出 reasonCode。
10. 子代理尝试派生子代理 → `Agent` 工具不可用，返回明确错误而非隐式挂起。
11. 构造一个读不到 launch spec 的子会话（用改造前的存量子会话，或删掉它的 `runtime/subagent_launch_spec` 行）→ 冷恢复后 composer 禁用、顶部一行"此子代理的身份未能还原，暂不可输入"；发一条 `sendText` 直发也被拒（`guard.subagentLimitedMode`），不是只靠 UI 藏。

## 验证

- 单测入口（仓库没有统一 test 脚本覆盖这些包，需手工指定）：根 `pnpm test` 只跑 `packages/shared/test/**`；CLI 侧逐包 `node --import tsx --test apps/zcode-cli/packages/<pkg>/test/<file>.test.ts`；`packages/ui/test/**` 有测试文件但**没有脚本入口**，需手工跑且带 `TSX_TSCONFIG_PATH=packages/ui/tsconfig.json` 才能解析 `@/` 别名。
  - launch spec 写入（FK 顺序）与读取；无 spec → 受限分支。
  - 冷恢复的子 record：`subagentPort === undefined`、工具面不含 `Agent`、`subagents.enabled === false`。
  - 角色策略的**命令矩阵**（遍历全部命令类型）。
  - 删除递归与中止级联；`deactivateSession` **不**级联。
  - 起始偏好继承：子会话的 compaction / memory / 预算策略与父一致；父偏好热更新后**新派生**的子会话不沿用旧值（既有回归面，见 `bootstrap/src/zcode-protocol/compaction-preferences.ts` 的快照刷新）。
  - hook 发射点保持：`SubagentStart` / `SubagentStop` 仍按原 payload 字段发射。
  - **子会话收窄的判据**（S5 补）：`isSubagentChildSession` 对两条构造路径都为真（覆盖包在场 / 只有 `taskType`），对其余 taskType 为假（`bootstrap/test/subagent-child-session-predicate.test.ts`）。hooks 与 hook trust **已不是收窄项**（拍板与主会话同形，见差异清单 2 / 21），故无对应断言；现存唯一收窄是 `subagentRosterPort`。收件箱端口侧：注入的端口优先、子会话无注入不自建（`bootstrap/test/subagent-child-mailbox-port.test.ts`）。这两组断言守的是"同一种会话两条构造路径行为必须同形"。
  - **策略表覆盖率**：照 `packages/shared/test/hook-event-copy-parity.test.ts` / `core/test/hook-copy-parity.test.ts` 的先例，断言"命令类型集合 ⊆ 策略表键集合"——新增命令时测试先红，而不是等准入处静默放行。
  - **受限模式**（S4 前置 1）：`subagentLimitedMode` 为真时 `computeInputRouting` 返回 `{mode:"reject", reasonCode:"guard.subagentLimitedMode"}`（且优先于 `compacting` / phase 判定）；同一事实下 `resolveRoleCommandAdmission` 拒绝对话输入类命令、放行非输入类命令（`deleteSession` / `renameSession` / `stop` 仍可用——受限的是输入面，不是会话管理）。
  - **`Store` 元数据路径不妄断**：冷会话（无活 record）的准入不因"读不到 launch spec"把普通会话判成受限——该判据只由活 record 携带。
  - **角标派生**（S4 前置 2）：`deriveSessionSummary` 的 `runningSubagentCount` 等于 `snapshot.subagents.running.length`（含 `waiting` / `blocked`），且 `summariesEqual` 覆盖它——只变这一个字段也必须产 delta，不被 conflation 吃掉。
  - **形态能力矩阵**（S4）：`packages/ui/test/sessionPaneCapabilities.test.ts` 逐格断言上表 13 个布尔列 × 4 个形态——`Record<BooleanCapability, boolean>` 的类型约束保证"矩阵漏一列"是编译错误而不是静默通过。配套约束：`SessionPane.tsx` 里每一处 `capabilities.*` 都必须对应表里某一列；`assistantFeedback` 原先借用的 `goalCommands` 列（真值相同）已在复核时拆成独立列，否则将来某形态只想改其中一项就会误伤另一项。
  - **输入拒绝文案映射**（S4）：`resolveInputRejectionMessageId` 把 `guard.subagentLimitedMode` 映射到受限模式专属文案，未知/缺失 code 落到通用文案。
- 集成：子会话 `sendText` 开新轮；跨会话投递在空闲/运行中两态都能消费（现有 `core/test/session-mailbox-sender-kind.test.ts` 是同源先例）。
- 端到端：上述 11 条验收路径。仓库**没有 E2E 框架与脚本**（`playwright-core` 在依赖里但没有 e2e 入口），交互验收只能由 agent 驱动浏览器手工执行。其中 6 / 7 / 9 / 10 / 11 的关键判据已有自动化背书（删除递归与中止级联、形态能力矩阵、工具面不含 `Agent`、受限模式的投影与准入），**1–5 与 8 依赖真实派发**，必须在跑起来的应用里手工走一遍才算验收（截至 2026-10-07 尚未执行，见「遗留工作」）。
- 门禁（命令均已实测，不是照抄 AGENTS.md）：
  - 根 `pnpm lint` / `pnpm fmt:check` **都不覆盖** `apps/zcode-cli`：根 `.oxlintrc.json` 的 `ignorePatterns` 含 `apps/zcode-cli`，且给 `oxfmt --check` / `oxlint` 传该目录下的文件会返回 `No files found to lint` / `Expected at least one target file`（`--no-ignore` 也绕不过）。
  - CLI 侧可用的类型门禁：`pnpm typecheck:cli`。
  - CLI 侧可用的 lint：**逐子包**跑 `pnpm --dir apps/zcode-cli/packages/<pkg> run lint`（= 该子包的 `oxlint src --no-ignore`）。**不要写 `pnpm --dir apps/zcode-cli run lint`**——它的脚本是 `turbo run lint`，而该独立 workspace 里 `turbo` 不可解析（实测 `Command "turbo" not found`）。
  - CLI 的 lint 是**既存红债**，不能当绿灯：本检出 `packages/core` 实测 31 errors / 10 warnings（`max-lines` 超 400、`NOOP_CALL` 未使用等）。CLI 改动按"不新增错误"衡量，不要求清零。
  - CLI 的 `format:check` 只覆盖 `package.json` 与 `**/*.{json,ts,mjs}`，**不覆盖 markdown**——本文与其它 spec 不在任何格式化门禁内。
  - 触及根包（`packages/ui`、`packages/shared` 等）：`pnpm typecheck` + `pnpm lint` + `pnpm fmt:check`。
  - `pnpm architecture:check -- --changed`。

## 遗留工作（分类）

**本轮范围内、按阶段排期**：S1a、S1b、S2–S5 —— **全部已落地**（各阶段事实与复核结论见上文各节）。

**验收缺口（本轮未执行，须补）**：**端到端环节**依赖真实派发（派一个后台子代理、看它在左栏出现、给它发一句话、跑完看状态迁移、重启看身份还原）。仓库没有 E2E 框架（`playwright-core` 在依赖里但没有 e2e 入口），只能用跑起来的应用手工走一遍；而本机数据根现在**跑不起一轮真实 agent**：隔离数据根 `~/.zcode-rayn/v2` 下 `credentials.json` 只有一条 bot 凭据、`provider_config.json` 只含 `providerOrder` / 规则而没有任何模型 provider（实测 2026-10-08，只读了键名与结构，未读取凭据值），因此无法自动完成"派发 → 观察 → 重启"这一段。**在此之前不要说"验收通过"**——能靠单测背书的部分（删除递归与中止级联、形态能力矩阵、工具面不含 `Agent`、受限模式的投影与准入、左栏区块行模型、两条构造路径的收窄判据、收件箱端口取法）已经覆盖，"真实派发 + 重启"这两类环节没有任何自动化。

**本轮不做、需另立任务**：

- 远端子会话的输入面（依赖跨机器 mailbox 共享，是既有未决问题）。
- fork / 选段侧聊（会让父子关系从"树"变成"图"，需重设防环与归属）。
- 子会话归档与保留策略。
- 子代理再派生（结构性禁止，不是待办）。
- 存量无 launch spec 子会话的回填（已决策：不回填，重新派发即可）。
- **`SubagentStop` 的可阻断声明与实现不一致**（D5）：共享事件表声明 `blockable: true`，但 `core/src/subagent/runner.ts` 的发射点不消费阻断决定。修法二选一（接线，或取消声明），与本改造无耦合，可独立处理。
- **原生执行器的纵深防御面比准入面窄**：`core/src/executor.ts` 的执行期兜底只对 `selection_side_chat` 查角色策略表，受限 `subagent_child` 不在这条兜底里。当前由准入层挡住（S4 前置 1 已覆盖 V4 准入 + legacy `session/send` 两处），但将来若出现绕过 `admitCommandInput` 的原生 handler，这层就缺一块。改它要动 `executor.ts`，不属本轮触碰文件（举一反三记在这里，不顺手扩边）。
- **`packages/formal-proof` 的 `computeAvailability` 黄金一致性**：`projection-state.ts` 注释提到与 `formal-proof/src/model.ts` 的 parity 测试，但本检出里找不到对应测试文件，因此"本轮未动 `computeAvailability` 裁决表"目前无自动化背书，只有人工确认。

**已决策不做（保持现状）**：

- 把 `subagent_child` 塞进任务索引——层级展示走父会话 conversation 投影 + `session/subagents`（见前置 2 的订正；子会话在 `services/src/zcode-agent/zcodeTaskIndexSyncer.ts` 里本就提前 return，不落 task row）。
- 权限弹窗改落子会话——保持落父会话 + origin 标识，避免"无人订阅时弹窗丢失"。
- persona 正文入存储——persona 的 owner 是 profile。
- 新增 `killed` 终态——复用 `cancelled`，不为细微差别扩协议。
