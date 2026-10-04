# 子代理会话作为一等附属会话（一条链路、附属身份）

涉及包：`contracts`（会话角色策略、命令白名单、session entry 常量）、`core`（子 runtime 配置策略、工具面、协调者协议、启动规格落盘）、`bootstrap`（输入准入、冷恢复、会话记录与生命周期归属、发布）、`adapters`（mailbox 落盘/消费）、`services`（会话消息投递、usage 归属、任务索引排除）、`shared`（协议 schema）、`ui`（层级列表、可输入子会话面板）。

与既有 spec 的关系：本文取代 `subagent-session-messaging.md` 的两条前提——「子代理会话只读」（该文 D2/D8 的隐含前提）与「`history` 行只能用 `childSessionId` 寻址」（该文 D8 末条）。该文其余部分（D1 派发即句柄、D3 投递 owner、D4 身份模型、D5 树内通路、D6 调用级 model、D7 防环）继续有效。

## 背景与问题

子代理与本会话的**底层已经是同一套**：同一个 `AgentRuntime` 类（`packages/core/src/runtime/methods/subagent.ts` 的 `new AgentRuntime(childSessionId, ...)`）、同一条 `sessionStore.createSession`（`packages/core/src/runtime/methods/events.ts`）、同一个 sessionId 体系（`sess_subagent_agent_<uuid>`）、同一套 V4 订阅协议（子会话已能作为只读侧栏标签页打开）。差的是四道**人为分叉**：

1. **输入面**被 `guard.subagentReadOnly` 全量封死（`bootstrap/src/zcode-protocol/v4-bridge.ts` 的 `admitCommandInput`、`bootstrap/src/zcode-protocol/server-operations.ts` 的 legacy `session/send`）。其背后的语义是"child 是一次性 session，没有 record 也没有后继 turn"。
2. **收件箱缺失**：子运行时 deps 未注入 `sessionMailboxPort`，drain 钩子不注册。跨会话发给子代理的消息会落进 mailbox 却永不 drain（工具却报 `stored`）。本会话子代理因此**在运行中也接不到消息**。
3. **可还原身份缺一半**：冷恢复（`activateSessionForResume`）只还原 mode / model / cwd / `parentSessionId` / `taskType` / 工具白黑名单，**没有** `toolset`、`subagentContext`、`agentName`、`subagents.enabled`。子代理的启动参数（prompt / allowedTools / model）只在父会话的**内存事件**里（`persistDurableSessionEvent` 明确"事件只进父会话的内存 eventStore，会话去激活即被清空且冷恢复不回灌"），落盘的只有窄化的 lifecycle entry。
   - 由此产生一个**活的套娃后门**：`includeAgent` 的门是"`subagentPort` 在场"，而端口由 `config.subagents?.enabled === false` 决定（`createDefaultSubagentPort`）；冷恢复 config 没写这个开关，恢复出的子代理会拿到 `Agent` 工具。今天不可达只因输入面还锁着。
4. **列表归属**：`subagent_child` 被结构性排除在任务列表与任务索引之外（`TASK_LIST_SESSION_TYPES`、task-index syncer、`repairSubagentTaskIndex`），现有形态是"平级侧栏标签 + 父时间线里的 Agent 工作项"，没有任何父子层级表达。

目标（已与用户拍板）：让子代理会话成为**附属的正式会话**——同一条链路、同一个 sessionId、同一套会话能力，只有身份是子级。

## 设计决策

### D1 · 会话角色策略统一分叉

今天按 `taskType === "subagent_child"` 硬分叉的地方有 14 处（工具面、后台通知、usage 归属、遥测、只读门、列表过滤、roster 归属……）。本改造把这些判据收成一份**会话角色策略**：以 `taskType` 为输入，输出该角色的能力面（可用命令集、工具面修正、嵌套闸、交互归属、列表归属、usage 归属）。

- 角色策略是纯函数/不可变表，集中在 `contracts`，由 `core` / `bootstrap` / `services` 共用。
- 新增行为一律先加策略项，不再新增 `if (taskType === ...)` 短路。
- 改造不要求一次删除全部 14 处，但**本轮触碰到的每一处都必须改为读策略**。

### D2 · 子会话身份可持久化（launch spec）

新增 session entry：`SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC = "runtime/subagent_launch_spec"`（声明在 `contracts/src/interfaces/session-store.port.ts`，与 `SESSION_ENTRY_SUBAGENT_LIFECYCLE` 同处）。

- **写在子会话自己身上**，id 稳定（每个子会话一行），spawn 时写一次、**不可变**。身份事实的 owner 是子会话，不是父会话。
- 内容：`agentType`、`profileName`、`profileSource`（built-in / project / user）、`permissionMode`、`maxTurns`、`background`、`agentName`、`modelSelection`（派发时快照）、`toolset`、`toolAllowlist`、`toolDisallowlist`。
- **不存 persona 正文与工具面展开结果**：persona 与工具白名单由 `profileName` 在恢复时重解析。persona 的 owner 是 profile，把正文复制进存储会产生第二真相源。
- 与 lifecycle entry 的分工：lifecycle 记"跑过什么、什么状态"（可变、stop 覆写）；launch spec 记"以什么身份跑"（不可变）。

### D3 · 输入面按角色开放（中间档）

`guard.subagentReadOnly` 由"一律拒绝"改为"按角色策略裁决命令集"。

- **对子会话开放**：`sendText`（开新轮 / guide）、`compact`、`editUserQuery`、`retryTurn`。
- **继续拒绝**：`sendGoalCommand`、`resumeGoal`、`sendQueuedNow`、`forkAssistant`、`createSelectionSideSession` —— 前三者是长期自主循环，后两者会造出"子的子"，与本轮的树形归属和防环不变量冲突。
- 拒绝必须返回明确 reasonCode（沿用 `guard.subagentReadOnly` 之外的细分码，避免把"某命令非法"与"整个会话只读"混为一谈）。
- legacy `session/send` 与 V4 准入同时生效，不出现第二条绕过路径。
- **闲时轮**：闲时轮内子会话 composer 与 `SendMessage` 同规则禁用（闲时轮借用前台模型，子会话输入会绕过预算语义）。

### D4 · 收件箱接线

子运行时 deps 注入 `sessionMailboxPort`，drain 钩子（`UserPromptSubmit` / `PostToolUse` / `Stop`）对子会话生效。

- 投递结果语义不变（`steered` / `woken` / `stored`）；`stored` 现在真的会被 drain。
- `SendMessage(to: sess_subagent_*)` 从"假 stored"变为真实投递；不可达时仍落 mailbox 且**有 drain 保证**。
- 防环链对子会话照常生效（子会话在 spawn 时继承父链，用户从命令面输入不带链即清链）。

### D5 · 生命周期：归属树 + 可单开 + 父关即中止

- **归属树**：`parentSessionId` 是 owner 边。父会话被**卸载或删除**时级联到全部子会话：中止正在跑的轮、写终态、释放 publisher、卸载 record。
- **可单开**：子会话可被 `ensureSessionResident` 单独拉起、单独订阅、单独开轮，不要求父会话也在运行。
- **关标签页不级联**：UI 停止订阅（含 30s keep-warm 后退订）只是失去订阅者，不触发级联；子会话走自己的常驻回收规则。
- **父级联时立即中止正在跑的轮**（用户已拍板）：父的级联不受"有活动轮不可回收"保护。理由：用户已经关掉父、界面已经消失，让子代理继续烧 token 比中止更难解释。
- 子会话**自身**的常驻回收仍受"有活动轮"保护（现有 resident facts 语义不变）。两条规则的触发源不同，不得互相套用。
- 级联中止只写终态与 `killed` 状态，不向父投通知（父正在被卸载，通知无意义）。

### D6 · 权限与阻塞交互仍落父会话

permission / AskUserQuestion / ExitPlanMode 继续由 `deriveChildClientPorts` 改写到父 sessionId，带 `origin.kind === "subagent"` 标识（现状不变）。

- 理由：保证"没人开着子会话面板时弹窗也不会丢"。
- 代价：用户盯着子会话面板时可能看不到父会话的弹窗。因此 **UI 必须补一条"有请求等待在父会话处理"的提示**（见 S5 施工规格）。

### D7 · 列表：层级展开 + 可输入子会话面板

- **不把 `subagent_child` 塞进任务索引**：那会踩到 task-index syncer 与 `repairSubagentTaskIndex` 两条既存路径。改为**独立的子会话查询投影**（复用现有 `session/subagents`），由左栏按需查询。
- 左栏只在**父条目被选中**时以层级态展开子会话，不占顶层。
- 侧栏子会话面板从只读变为可输入（完整 composer）。

### D8 · 子代理不得再派生子代理（保持）

`subagents.enabled: false` 对子会话永远成立，且**恢复路径也必须显式写入**。它是本轮开放输入面的前置：输入面一开，冷恢复的子会话就能跑新轮，套娃后门随即变成活的。

### D9 · 模型与工具面在出生时冻结

- 子会话跟随自己持久化的 `modelSelection`（派发时快照），可在子会话内显式切换；**不跟随**父会话后续换模型。
- persona 与工具白名单在**第一次冷恢复时**由 profile 重解析；profile 已被编辑则以新 profile 为准（profile 是 owner）。父会话后续改权限模式不影响已存在的子会话。
- 子会话内的**权限模式不可改**（build/plan/yolo 是权限提升面）。要改回父会话改。

### D10 · 本轮边界

- 远端 / 跨机器的子会话：不做输入面（远端 mailbox 不共享是既有未决问题），只在列表里可见、只读。
- usage 归属：仍按 `subagent` 记账，不拆成独立会话统计。
- 已结束子代理的保留：沿用现有 ended 分页，不新增保留策略。
- 子会话删除：允许单独删除（连记录一起）；父删除时级联删除。不提供归档。

## 行为

### 场景 1 · 派发

派发后台子代理后，子会话立刻出现在**父会话的层级列表**里（父条目选中时可见）。子会话同时获得自己的 launch spec entry。

### 场景 2 · 用户在子会话里开新轮

用户在子会话面板输入 → 走正常命令准入（`sendText`）→ 子会话开新轮。子会话的执行不阻塞父会话；父会话收到正常的子代理活动投影（沿用现有镜像），不产生新的阻塞等待。

### 场景 3 · 子代理跑完后续聊

已终止的子会话，用户仍可在面板里输入 → 开新轮（复用同一 `childSessionId` 与身份）。这与现有 `agent_*` 复活是同一种业务（同 agentId 续跑），只是入口从"父会话的 SendMessage"扩展到"用户直接在子会话里说"。

### 场景 4 · 父会话关闭

父会话标签页关闭**不级联**（只是停止订阅）。父会话被卸载或删除 → 级联中止全部子会话、写终态 `killed`、释放 publisher、卸载 record。

### 场景 5 · 给子会话发消息

`SendMessage(to: sess_subagent_*)` 与 `SendMessage(to: agent_*)` 都可用；前者走跨会话端口（steered / woken / stored），后者走本会话子代理注册表（现有三态）。`agent_*` 在进程重启后仍失效（内存注册表为空），此时用 `sess_subagent_*`。

### 场景 6 · 冷恢复后继续

重启后打开子会话 → 冷恢复从 launch spec + profile 还原身份 → 面板显示原 agentType 与 persona；用户可继续开新轮。launch spec 缺失或 profile 解析不到 → 进入**受限子会话**（见失败语义）。

### 场景 7 · 父会话未选中

父会话有正在跑的子代理时，左栏父条目显示运行中计数角标。

## 所有权与不变式

- **角色策略是唯一判据**：会话能力面由角色策略决定，不得在业务代码里新增 `taskType` 硬比较。
- **身份 owner 是子会话自己**：launch spec entry 写在子会话的 entries 上、不可变；父会话的 lifecycle entry 只记生命周期，不是身份的第二个真相源。
- **生命周期 owner 是父会话**：归属树以 `parentSessionId` 为边；级联只由"父被卸载/删除"触发，不由"失去订阅者"触发。
- **中止语义不对称**：父级联时"立即中止"优先于"有活动轮不可回收"；子会话自身回收时"有活动轮不可回收"优先。两者不得互相推导。
- **嵌套闸恒真**：任何构造/恢复子会话运行时的路径，`subagents.enabled` 都必须为 `false`。这是 fail-closed 的安全边界。
- **交互归属不变**：阻塞交互的 sessionId 恒为父会话；子会话只带 origin 标识。
- **不进入任务索引**：`subagent_child` 永远不出现在任务列表与任务索引里；层级展示走独立投影。
- **只读不再是全量语义**：`guard.subagentReadOnly` 退化为"命令不在角色白名单内"，不再是"该会话不可输入"。

## 失败语义

- **launch spec 缺失 / profile 解析不到**：子会话进入**受限模式**——保持不可输入（等同现状的只读）、不注册 `Agent` 工具、使用通用 persona，并在 UI 标注"身份未还原"。绝不猜一个 profile 出来。
- **父会话已不存在**：子会话不应存在（级联删除）；若因数据损坏出现孤儿，子会话可读、可单独常驻，但输入面按受限模式关闭，UI 说明原因。
- **mailbox 不可写**：投递明确失败，不假装 `stored`。
- **非法命令**：返回明确的细分 reasonCode（例如"子代理会话不支持分叉"），不返回笼统的只读错误。
- **闲时轮内的子会话输入**：明确拒绝并给出可执行提示（该能力在闲时轮不可用），不静默丢弃。

## 迁移边界

- **存量子会话没有 launch spec**：冷恢复时退化为受限模式（不可输入）。不做批量回填——子会话的身份不能从窄化的 lifecycle entry 之外的地方可靠推断。用户若要继续使用，重新派发一个子代理即可。
- **`agent_*` 寻址保持不变**：现有提示词、`ListAgents`、节奏型工作流仍可按 `agent_*` 使用；新增的是 `sess_subagent_*` 可投递、可输入。
- **`ListAgents` / `SendMessage` 工具描述必须同步**：删除"历史行只能用 childSessionId 寻址、不能投递"的表述（那是本轮要修的缺陷），改为"历史行按 childSessionId 寻址，可投递"。
- **`subagent-session-messaging.md` 的两条前提作废**：落地时同步修改该文 D2/D8 与"失败语义"，并删除 `rebuild` 期的只读说明。
- **角色策略上线不改变主会话行为**：`interactive` / `fork` / `workflow_parent` 的能力面必须与改造前逐项一致，作为回归门。

## 实施阶段（方案）

### S1 · 身份可持久化 + 冷恢复还原 + 关掉套娃后门（前置）

改动面：
- `contracts`：新增 `SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC` 常量与数据结构。
- `core`：子 runtime 创建时写 launch spec entry（`runtime/methods/subagent.ts`）。
- `bootstrap`：`activateSessionForResume` / `createRecord` 对 `taskType === "subagent_child"` 读 launch spec、重解析 profile，并**显式写入 `subagents: { enabled: false }`**、`toolset`、`agentName`、`subagentContext`、`permissionMode`；解析不到即受限模式。

验收：
- 冷恢复的子会话**不注册** `Agent` 工具（现有后门关闭）。
- 冷恢复的 persona 与工具面与派发时一致（同 profileName）。
- 无 launch spec 的存量子会话进入受限模式，且单测覆盖该分支。
- 主会话（`interactive`）冷恢复行为逐项不变。

门禁：`pnpm typecheck:cli`、`pnpm lint`；触及根包时补 `pnpm typecheck`。

### S2 · 输入面（角色策略 + 中间档命令集）

改动面：
- `contracts`：会话语义角色策略（命令白名单、细分 reasonCode）。
- `bootstrap`：`v4-bridge.ts` 的 `admitCommandInput`、`server-operations.ts` 的 legacy `session/send` 改为读策略。
- `core`：闲时轮内子会话输入的拒绝路径。

验收：
- 子会话可 `sendText` 开新轮并跑完；`compact` / `editUserQuery` / `retryTurn` 可用。
- `forkAssistant` / `createSelectionSideSession` / `sendGoalCommand` / `resumeGoal` / `sendQueuedNow` 返回细分 reasonCode。
- 闲时轮内子会话输入被明确拒绝。
- 主会话全部输入命令行为不变（回归）。

### S3 · 收件箱接线

改动面：`core`（子运行时 deps 注入 `sessionMailboxPort`）、`bootstrap`（若需要额外装配）、`contracts`（工具描述）。

验收：
- 跨会话向子会话投递在**空闲**与**运行中**两种状态下都能被消费（空闲唤醒 / 运行中注入）。
- 不可达时落 mailbox，随后子会话自醒能 drain 到。
- `ListAgents` / `SendMessage` 描述与实现一致。

### S4 · 生命周期（归属树 + 立即中止）

改动面：`bootstrap`（`cleanupSessionRuntime` 的级联、`pruneDetachedChildPublishers`、resident pool 适配）、`core`（中止时写终态）。

验收：
- 父卸载/删除 → 子立即中止，终态 `killed`，publisher 释放，record 卸载。
- 父仅关标签页 → 子不受影响。
- 子会话可被单独唤醒、单独常驻；自身空闲可被回收后再单独唤醒。
- 子会话自身有活动轮时不被 idle 回收（现状保持）。

### S5 · UI（施工规格见下节）

改动面：`ui`（左栏层级列表、子会话面板、状态角标、授权提示）、`shared`（如需补协议字段）。

验收：见下节"验收路径"。

### S6 · 收口

- 同步 `subagent-session-messaging.md`（D2/D8、失败语义）。
- 更新 `CONTEXT.md` 词汇。
- 14 个 `taskType` 分叉点逐项确认已改为读策略。

## UI 施工规格（S5）

### 左栏任务列表：层级态

- **位置**：父会话条目**下方**的子区块，仅在父条目处于选中态时渲染。
- **数据**：新增一次"子会话列表"查询，来源为现有 `session/subagents` 投影（不塞任务索引）；查询按父会话 id。
- **子条目控件形态**：
  - 缩进一级（16px）；左侧 `BotIcon`（12px，颜色取 profile 的 `color`，缺省 `text-foreground-subtlest`）。
  - 标题：子会话 title（现有由派发 prompt 生成的 first_input title），单行截断。
  - 右侧状态指示：`running` 脉动圆点（`text-ui-accent` + `animate-pulse`）；`completed` CheckIcon（`text-success`）；`failed` TriangleAlert（`text-destructive`）；`killed` MinusIcon（`text-foreground-subtlest`）。
  - 点击 → `openSubagentSessionSidePane(childSessionId)`（复用现有入口，不新增打开通道）。
- **状态**：
  - 空：**不渲染区块**，不显示空态占位（避免选中父会话时的视觉噪音）。
  - 加载：区块位置渲染 2 行同高骨架，避免父列表跳动。
  - 失败：一行 `text-ui-xs text-foreground-subtlest` 文案 + 重试按钮。
  - 超过 8 个：区块底部一行"还有 N 个已结束的子代理"，点击打开现有子代理目录面板（承载分页）。
- **父未选中**：不渲染子区块；若该父会话有 `running` 子代理，父条目右侧显示计数角标（`Badge variant="secondary"`，内容为纯数字）。
- **动效**：展开/收起复用现有 collapsible；不做新动效。
- **文案**：
  - `subagents.list.loadFailed`：`子代理列表加载失败` / `Failed to load subagents`
  - `subagents.list.retry`：`重试` / `Retry`
  - `subagents.list.moreEnded`：`还有 {count} 个已结束的子代理` / `{count} more finished subagents`

### 侧栏子会话面板：从只读变可输入

- **顶部条**：`BotIcon` + 标题 + 身份徽标（`子代理 · {agentType}` / `Subagent · {agentType}`）+ 状态词。
- **输入区**：复用正式会话 composer。差异：
  - 隐藏权限模式切换（不可改，D9）。
  - 保留模型选择（可切）。
  - 保留上下文用量与 compact 入口。
  - 受限模式（身份未还原）或孤儿会话：composer 禁用，顶部一行说明原因。
- **授权请求提示（新增，必需）**：当父会话上存在属于本子代理的待处理交互（`origin.kind === "subagent"` 且 childSessionId 匹配）时，面板顶部显示可点击提示（`text-warning`）：`有 {count} 个请求等待在父会话处理` / `{count} request(s) pending in the parent session`，点击切到父会话标签页。无请求时隐藏。
- **已终止子会话**：面板底部显示终态摘要；composer 仍可用（续聊=开新轮）。
- **空态**：复用现有会话空态。
- **文案**：
  - `subagents.pane.identityBadge`：`子代理 · {agentType}` / `Subagent · {agentType}`
  - `subagents.pane.pendingInParent`：`有 {count} 个请求等待在父会话处理` / `{count} request(s) pending in the parent session`
  - `subagents.pane.limitedMode`：`此子代理的身份未能还原，暂不可输入` / `This subagent's identity could not be restored; input is disabled`

### 验收路径（E2E）

1. 派发一个后台子代理 → 选中父会话 → 左栏父条目下方出现子条目（running 脉动点）。
2. 点击子条目 → 侧栏打开子会话，可看到它的工具调用与消息。
3. 在子会话输入"总结你的发现" → 子会话开新轮并完成；父会话不被阻塞。
4. 子代理跑完后 → 子条目状态变 `completed`；父会话未选中时父条目显示计数角标。
5. 触发一次需要授权的子代理工具调用 → 弹窗出现在父会话；子面板顶部出现"有 1 个请求等待在父会话处理"，点击跳到父会话。
6. 关闭父会话标签页 → 子代理不受影响；卸载/删除父会话 → 子代理立即中止，子条目状态 `killed`，且不能再开新轮。
7. 重启应用 → 子条目仍在；点开可继续聊，身份为原 `agentType` 的 profile。
8. 在子会话尝试 fork / 切换权限模式 → 控件不存在或明确拒绝，并给出可读原因。
9. 子代理尝试派生子代理 → `Agent` 工具不可用，返回明确错误而非隐式挂起。

## 验证

- 单测：launch spec 写入与读取；冷恢复还原身份（含"无 spec → 受限"分支）；角色策略的命令白名单（矩阵）；嵌套闸在恢复路径恒真。
- 集成：子会话 `sendText` 开新轮；跨会话投递在空闲/运行中两态都能消费；父卸载级联中止。
- 端到端：上述 9 条验收路径。
- 门禁：`pnpm typecheck:cli`、`pnpm lint`；触及根包时补 `pnpm typecheck`；`pnpm architecture:check -- --changed`。

## 遗留工作（分类）

**本轮范围内、按阶段排期**：S1–S6（见上）。

**本轮不做、需另立任务**：

- 远端子会话的输入面（依赖跨机器 mailbox 共享，是既有未决问题）。
- fork / 选段侧聊（会让父子关系从"树"变成"图"，需重设防环与归属）。
- 子会话归档与保留策略。
- 子代理再派生（结构性禁止，不是待办）。

**已决策不做（保持现状）**：

- 把 `subagent_child` 塞进任务索引——层级展示走独立投影。
- 权限弹窗改落子会话——保持落父会话 + origin 标识，避免"无人订阅时弹窗丢失"。
- persona 正文与工具面展开结果入存储——persona 的 owner 是 profile，恢复时重解析。
