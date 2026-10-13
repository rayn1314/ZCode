# 任务面板与目标截止时间（Goal Task Panel + endAtMs）

涉及包：`contracts`（`SessionGoal` 与 schema）、`adapters`（`session_target` 迁移与 SQL）、`core`（截止硬停与续跑提示）、`bootstrap`（协议命令）、`shared`（legacy 协议 schema、task 类型与 validation）、`services`（面板查询通路）、`cli`（命令中心状态词表）、`ui`（workspace 主视图面板）。

与既有 spec 的关系：本文只**扩展**会话目标的字段与新增一个 UI 主视图，不改变 `subagent-*` 系列、`context-compaction-controls.md`、hook 框架各文的结论。目标续跑（goal continuation）语义保持原样，本文不新增任何每轮提示注入。

状态：**已实现**（2026-10-12）。实现与本稿的两处偏离记在文末「实现订正记录」。

## 背景与问题

### 现状（已对当前检出的源码逐条核实）

ZCode 已有一套完整的「会话目标（goal / session target）」机制，用户要的「持续性任务」在运行时层面已经成立：

- **任务描述**：会话内 `/goal <目标>` 命令（`packages/ui/src/v4/slashCommands.ts:86-94`），落到 `session/goal` 协议的 `set/replace/pause/resume/clear`（`packages/shared/src/zcode-protocol/index.ts:1904-1931`），handler 在 `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/server-operations.ts:2199-2312`。
- **完成判定与自动续跑**：每轮用户 prompt 提交带 `continueActiveTargetAfterTurn: true`（`apps/zcode-cli/packages/bootstrap/src/app/input-facade.ts:128-131`），turn 结束后由运行时命令队列进入续跑循环（`apps/zcode-cli/packages/core/src/runtime/methods/runtime-command-queue.ts:154-178`）。循环先用 LLM 完成校验器判定目标是否达成（`apps/zcode-cli/packages/core/src/runtime/methods/target-completion-verification.ts:41-89`）：达成则置 `complete` 并停止；未达成则注入 `<system-reminder source="target_continuation">` 继续下一轮（`target.ts:145-190`）。校验器自身失败（无 `nextAction`）时保守停止，避免把内部错误变成无限迭代（`target.ts:116-128`）。
- **持久化**：SQLite 表 `session_target`，建表见 `apps/zcode-cli/packages/adapters/src/storage/session-store/migrations.ts`（`0004` 建表、`0005` 重建含预算、`0011` 加 `summary_title`、`0013` 加 `active_run_*`），SQL 在 `apps/zcode-cli/packages/adapters/src/storage/session-target.ts`。
- **预算硬停先例**：`token_budget` 在上限达到时由 SQL 一次性把 `status` 翻成 `budget_limited`（`finishSessionTargetRun`；`accountSessionTargetUsage` 同形），续跑候选要求 `status === "active"`，因此自动续跑自然停止（`target.ts:187-206`）。
- **UI**：会话状态面板的 `GoalStatusSection` 展示目标标题与用时，仅提供暂停/恢复（`packages/ui/src/v4/ConversationStatusPanel.tsx:457-582`）。

### 问题

1. **没有可见的管理面**：设定目标必须进某个会话敲 `/goal`，无法在一个地方看到「本工作区有哪些任务、各自什么状态、还剩多少时间」。
2. **没有时间退出条件**：目标只有 token 预算（且当前无任何调用方传入，恒为 `null`），没有「到早上 10 点为止」这类墙钟截止，用户只能把时间写进目标文本里靠模型自觉。
3. **停止原因不可辨**：`budget_limited` 在 v4 投影里被归为 paused（`projection-rows.ts` 的 `mapGoalStatus`），UI 看不出目标是被系统自动停下的、更看不出为什么。

### 需求（用户口径，2026-10-12 确认）

- 前端形态是一个**任务面板**：设定任务、查看状态、编辑与停止。
- 任务需要**时间退出条件**（「到早上 10 点之前」），并且是**硬性截止**，不依赖模型自觉；到点后允许**一轮**收尾，之后必停。
- **不做**「每轮系统提示注入任务内容」：任务信息只沿既有 goal 路径到达模型（设定那轮的对话历史、续跑时的 `target_continuation` 提醒、状态变更提醒）。
- 一个任务挂在一个会话上（用户已确认），不引入独立任务实体。

## 设计决策

### D1：面板是会话目标的视图，不新增任务实体

面板的每一行就是一行 `session_target`，其宿主是会话。**不**新建 `task` 表或 `TaskPanelStore` 的持久化副本。

理由：goal 已有唯一的权威所有者（`session_target` 表 + `sessionStore` 端口）。再造一份任务实体必然产生双写与漂移；`AGENTS.md` 要求「避免重复状态和多条写入路径」。

### D2：面板落点 = workspace 主视图 `"goals"`

复用定时任务（Automations）已经走过的形态：它是 workspace 主视图而不是设置分区（`packages/ui/src/lib/settingsNavigation.ts:37-47` 明确注释「定时任务是 workspace 主视图，不能再作为设置页分区出现」）。

需要改：

1. `packages/ui/src/app-shell/types.ts`：`WorkspaceMainView` 增加 `"goals"`。
2. `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`：增加 `workspaceMainView === "goals"` 的渲染分支，复用 `ScopedErrorBoundary` 与面包屑框架（仿 `AutomationsMainBreadcrumbFrame`）。
3. `packages/ui/src/app-shell/WorkspaceShellLayout.tsx`：`shouldRenderMainViewHeader` 把 `"goals"` 与 automations/plugin-store 一样排除（主视图自带顶栏）。
4. `packages/ui/src/WorkspaceSidebar.tsx`：在 Automations 按钮同区加「任务」入口。
5. `packages/ui/src/App.tsx`、`packages/ui/src/app-shell/useWorkspaceTaskNavigation.ts`、`packages/ui/src/lib/taskNavigationHistory.ts`：加 `handleOpenGoals` 与 `taskNavPushGoals`（仿 automations，含浏览器式前进/后退历史）。
6. `packages/ui/src/store/goalManagementStore.ts`：新建面板 store（仿 `automationManagementStore.ts`），service 由 action 参数注入。

### D3：时间截止 = `endAtMs` + 两段式收尾（先收尾，后硬停）

新增 `endAtMs: number | null`（epoch ms，`null` 表示不设截止），以及 `deadlineGraceUsed: boolean`（「收尾轮是否已给过」），把它接进与 `tokenBudget` 完全对称的记账链路。

**裁决的唯一入口是纯函数** `decideGoalDeadline`（`apps/zcode-cli/packages/contracts/src/tools/target.ts`）：

```ts
decideGoalDeadline({ endAtMs, deadlineGraceUsed, nowMs }) → "continue" | "wrap-up" | "settle"
// endAtMs === null 或 nowMs < endAtMs            → "continue"
// 到点且 deadlineGraceUsed === false              → "wrap-up"（放行这一轮收尾）
// 到点且 deadlineGraceUsed === true               → "settle"（结算硬停）
```

**三个落点（缺一不可）**：

1. **续跑候选检查**（`apps/zcode-cli/packages/core/src/runtime/methods/target.ts` 的 `targetContinuationCandidateForCommand`）：`status !== "active"` 早退之后，若裁决为 `"settle"` 则先结算（`updateTargetStatus("deadline_reached")` + 一次性提醒）再返回 `null`；否则照旧返回候选。这保证每轮 turn 结束时（续跑必经此处）**到点必停**。
2. **收尾轮的放行**（同文件 `executeTargetContinuationCommand`）：裁决为 `"wrap-up"` 时，在**背景任务延后判定之后、完成校验器之前**调用 `markTargetDeadlineGraceUsed` 把标志落库，然后照常走校验器与续跑注入。放在延后之后是因为「被延后的续跑不该白白吃掉唯一一次收尾机会」；放在校验器之前是因为校验器自身失败（无 `nextAction` 的保守停止）时标志也已落地，下一轮检查会正常结算，不会永久停在 `active`。
3. **turn 记账 SQL**（`apps/zcode-cli/packages/adapters/src/storage/session-target.ts` 的 `finishSessionTargetRun` 与 `accountSessionTargetUsage`）：在 `case when` 里增加与预算同形的分支

   ```sql
   when status = 'active' and end_at_ms is not null and deadline_grace_used = 1 and ? >= end_at_ms then 'deadline_reached'
   ```

   **排在预算分支之后**，因此有预算的目标先触预算时翻 `budget_limited`，不会再翻 `deadline_reached`（A6）。账目结算与翻状态在一次 SQL 内完成，避免与候选检查竞态（例如收尾轮是一轮很长的 turn、期间进程重启）。

**收尾轮的提示内容不需要新通道**：`formatGoalContinuationPrompt` 在同一段 `Deadline:` 里判断「已过点」，过点时文案自动变成「这是最后一轮，请收尾」（见 D6）。顺序上先跑校验器，若它判定已达成则直接置 `complete`（A15），不会退化成 `deadline_reached`。

完全空闲（无 turn、无后台任务）的会话不会被任何一方结算状态——此时没有任何算力在消耗，任务事实上已停；面板按 D5 显示派生徽标，落库等下一次运行时活动。

### D4：新增 `deadline_reached` 状态，不复用 `budget_limited`

`status` 枚举扩为 `active | paused | complete | budget_limited | deadline_reached`。

理由：`status` 是**权威事实**，语义不该由 UI 从别的字段反推。把「到点停」记成 `budget_limited` 会在预算与截止同时存在的目标上产生不可区分的记录。新增枚举值的代价是一次 `session_target` 表重建（check 约束变更无法 `alter`），而 `0005_session_target_accounting` 已经做过同样的重建，照抄即可。

影响面（同一枚举的副本，全部已改；漏一处会在运行期被 zod 拒绝或类型报错）：

- `apps/zcode-cli/packages/contracts/src/tools/target.ts`：`GoalStatus`、`GoalStatusSchema`
- `packages/shared/src/zcode-task-types-core.ts`：`ZCodeTaskGoalStatus`（另加 `endAtMs` / `deadlineGraceUsed` 到 `ZCodeTaskGoal`）
- `packages/shared/src/validation.ts`：`zcodeTaskGoalStatusSchema`
- `packages/shared/src/zcode-protocol-legacy-types.ts`：`zcodeSessionGoalSchema.status`（另加两个字段，带 `.default(...)` 以兼容历史 snapshot）
- `apps/zcode-cli/packages/cli/src/command-center/types.ts`：`CommandCenterTargetStatus`（另加 `endAtMs` 到 `CommandCenterTarget` 并展示）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol/session-mapper.ts`：`mapSessionGoal`（协议投影，已导出给 goalList 复用）
- `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/projection-rows.ts`：`mapGoalStatus`（`default → paused` 已覆盖 `deadline_reached`，仅更新注释）
- `packages/services/src/zcode-agent/zcodeTaskServiceAdapter.ts` 与 `zcodeTaskIndexSyncer.ts`：`isZCodeTaskGoalStatus` / `fromZCodeGoal`
- `packages/ui/src/lib/zcodeSessionProjection.ts`：`isZCodeTaskGoalStatus` / `fromZCodeGoal`

状态文案不放 `chat.target.status.*`。设计稿曾要求给该键族补 `deadline_reached`，实现时核实：**该键族全仓无任何消费点**（会话状态面板 `ConversationStatusPanel` 用的是另一套派生状态 `ConversationGoalStatus`，值域是 `active|verifying|notSatisfied|paused|verified`，与 DB 的 `GoalStatus` 不是一回事），补进去只会多一个没人读的键。任务面板改用自己的一套 `goals.status.*`（`active / paused / deadlineReached / deadlinePending / stopped / complete`，其中后两者之外的状态由 D5 派生口径决定）。

### D5：面板的「已到截止」与「未启动 / 即将到点」显示

权威状态只认 DB。面板额外提供**派生显示**，全部只读不落库：

- 当 `status === "active" && endAtMs != null && now >= endAtMs` 时，按 `deadlineGraceUsed` 显示「已到截止时间 · 收尾中」（标志未用，收尾轮还没跑）或「已到截止时间 · 待结算」（标志已用，等下一次结算）。
- 当 `status === "paused" && tokensUsed === 0 && timeUsedSeconds === 0` 时显示「未启动」；行内主操作显示「运行」（= `resume`，恢复即运行）。语义上「已暂停但跑过」与「从未启动」在只读投影里可区分，存储层面不加新状态。
- 当 `status === "active" && deadlineWarningSent === true` 时显示「即将到点」（预警阈值在服务端，见 D7；UI 只读标志、不自己算阈值，避免阈值副本漂移）。

不变式：派生显示永不写库、不参与续跑判定；它只是让用户看到「这个任务目前的时间处境」。

### D6：不做每轮系统提示注入（用户决定）

任务内容**不**进入上下文前缀，因此不会每次请求都出现（上下文前缀每个 model step 都会由 `context/builder.ts` 重建，新增 section 就等于每请求注入）。模型侧可见的信息沿用既有三条路径，只做一处扩展：

- 续跑提醒 `formatGoalContinuationPrompt`（`apps/zcode-cli/packages/contracts/src/tools/target.ts`）已输出 `Time spent` / `Tokens used` / `Token budget`，在其中补一段 `Deadline:`：
  - 未到点（剩余 > 10 分钟）：`- Hard deadline: <本地时间> (in <剩余>). The runtime stops this goal at the deadline, after one final wrap-up turn.`
  - 预警窗口（0 < 剩余 ≤ 10 分钟）：段落标题改为 `Deadline approaching:`，追加 `Converge on the objective now: finish and verify what is already in progress, and do not start work that cannot finish before the deadline.` —— 让模型在硬停**之前**就开始收口。
  - 已到点：`- The deadline (<本地时间>) has passed. This is the final wrap-up turn. Summarize what is complete, what remains, and what the user should do next, then stop. ...`
  - `endAtMs === null` 时整段不输出。
- 完成校验提示 `formatGoalCompletionVerificationPrompt` 在 `Goal state:` 里加同一行（未到点给剩余时间，窗口内标 `approaching, start converging`，已到点标 `already passed`），使校验器在「目标达成」与「时间将尽」冲突时能给出正确判断。
- 到点结算提醒走 D7；预警一次性提醒也走 D7。
- `formatGoalStateForModel`（resume 附件注入）同样补 `Hard deadline:` 行，保证冷恢复会话也能看到截止处境。

这三处都只在「续跑 / 校验 / resume / 状态变更」这几个既有时刻发生，不新增频率。两个格式化函数都接受可选的 `nowMs`（默认 `Date.now()`）以便单测。

### D7：截止提醒与预警由 core 注入，文案放在 contracts

**到点结算提醒**：结算时注入一条 `model-only` 提醒（复用 `recordGoalStateChangeReminder`，`apps/zcode-cli/packages/core/src/runtime/methods/goal-state-reminder.ts`），文案是 contracts 里的 `GOAL_DEADLINE_REACHED_REMINDER_TEXT`。

**到点前预警（一次性）**：新增持久化标志 `deadline_warning_sent`（迁移 `0024_session_target_deadline_warning`，只加一列、不重建表）。跨过「剩余 10 分钟」窗口（`GOAL_DEADLINE_WARNING_LEAD_MS`，contracts 常量）时，turn 记账路径调用 `markTargetDeadlineWarningSent`（条件写入 `where ... deadline_warning_sent = 0`，并发下只有真正翻到 1 的那次返回带标志的目标）并注入 `GOAL_DEADLINE_APPROACHING_REMINDER_TEXT`。**只发一次**由落库标志保证，两条记账路径不会各发一条。

**为什么不扩 facade 私有的 `goalStateChangeReminderText`**：结算发生在 core，而那个函数是 `bootstrap/src/app/session-facade.ts` 的模块私有函数，core 取不到；把文案放 contracts 让两侧都能用，比在 facade 里加一个永不被调用的 `deadline_reached` 分支干净（避免死路径）。

**「只发一次」由跃迁判定保证**：候选检查结算与记账 SQL 兜底两处，都只在**读到 `previousTarget.status === "active"` 而结算结果为 `deadline_reached`** 时才发提醒。谁先翻状态谁发，另一处看到已是 `deadline_reached` 便不再发。

**阈值为什么放服务端**：`GOAL_DEADLINE_WARNING_LEAD_MS` 只定义在 contracts（服务端），UI 侧不 import contracts（跨 workspace 不可达），所以面板读 `deadlineWarningSent` 标志而不是自己算阈值——显示口径与服务端行为天然一致，没有阈值副本可漂移。`deadline_warning_sent` 与 `deadline_grace_used` 同规则重置（`set/replace` 与 `resume` 激活时归零）。

### D8：面板数据源 = 新增 workspace 级查询 `session/goalList`（可跨项目全局列出）

面板一次拿到「全部项目的目标」（与 automations 面板 `listAllAutomations` 的全局口径一致）。

被否的替代方案：扩展 v4 sessions index 投影携带完整 goal（`sessions-index-projection.ts` 目前只带 `goalStatus`）。否掉的理由是通用列表投影会被迫为每一个消费方多背一份 goal 对象，而真正需要完整 goal 的只有本面板。

采用方案（三层）：

1. **store 查询**：`sessionStore.listTargets({ directory?, includeArchived?, limit? })`，实现是

   ```sql
   select st.*, s.title, s.directory, s.path, s.workspace_id, s.time_archived
   from session_target st join session s on s.id = st.session_id
   where s.directory = ? and s.time_archived is null
   order by st.time_updated desc limit ?
   ```

   `directory` 缺省时不加 `where s.directory = ?` 过滤——同一个数据根的会话库本来就装着全部项目的会话，所以**省略 directory = 列出全部项目**（远端工作区则自然限定到那台机器的数据根）。
   返回 `SessionGoalListEntry`（contracts）：`{ goal, sessionID, sessionTitle, workspacePath, workspaceIdentity?, archived }`。
2. **协议**：新增 legacy 命令 `session/goalList`（`packages/shared/src/zcode-protocol/index.ts` 的 `zcodeProtocolMethods.sessionGoalList`），handler 在 `server-operations.ts` 的 `goalListSessions`，与 `session/goal` 同族、与 `listSessions` 同为 workspace 级只读查询。参数 `scope?: "workspace" | "all"`：缺省只列该工作区（`workspaceIdentity?.trim() || workspacePath` 隔离，与 `listSessions` 同一判据）；`scope: "all"` 时忽略目录/身份过滤，返回全量（面板跨项目视图）。`workspace` 字段仍必传作路由。
3. **services**：`zcodeAgentService.listSessionGoals(params)` 转发该命令；`scope` 原样下推。面板进入/切换项目时用 `scope: "all"` 加载。

### D9：面板命令走 legacy `session/goal` 命令族（含「保存不运行」）

面板的设定/编辑/暂停/恢复/清除全部经 services 层的 `goalSession`（`packages/services/src/zcode-agent/zcodeAgentService.ts`）下发，**不新增 v4 命令**。清除（`clear`）在 legacy handler 已实现，而 v4 命令表里没有 `clearGoal`——走 legacy 即可省掉一次协议扩展。

参数扩展（`zcodeSessionGoalParamsSchema` 均可选）：`endAtMs`、`tokenBudget`、**`start: boolean`**。

**`start` 语义（2026-10-13 追加，用户口径「保存 ≠ 保存并运行」）**：
- `start: false` = 「保存但运行」：建目标时落 `paused`；编辑已运行的目标时保持 `active`（不打断，也不触发新续跑）。由 handler 的纯函数 `resolveGoalStartStatus(start, existingStatus)` 统一裁决。
- 缺省（含 `/goal <text>` 文本命令）= 「保存并运行」：置 `active` 并立即续跑，保持既有行为不变。
- services 层：`start: false` 的 set/replace 走**只读客户端**（`getReadOnlyClient`）——保存不触发任何模型执行，**未配置模型供应商也能保存目标**（供应就绪后再「运行」即可）；其余动作仍走 `getClient`（要求供应商）。

## 行为

### 设定与编辑

- 面板「新建任务」= 新建会话 + 设定目标，或选定一个已有会话再设定目标。
- 必填：任务描述（即 `objective`）。选填：截止时间 `endAtMs`、token 预算 `tokenBudget`、目标任务项目（见 UI 规格）。
- **两个提交语义（2026-10-13 追加）**：
  - 「保存」→ `start: false`：新建落 `paused`（未启动），编辑保持当前运行状态，不触发续跑，未配供应商也能保存。
  - 「保存并运行」→ `start: true`（缺省）：置 `active` 并立即开始续跑。
- **截止时间校验（2026-10-13 修订，改掉「编辑过期目标必须先动时间」的摩擦）**：表单只校验**用户新填/改过**的截止时间——与进入编辑时的原值相同则放行；只有新值在过去才禁用提交。「保存并运行」始终要求截止时间为「空或未来」（运行一个已过期的目标会立刻被硬停），「保存」不受此限。
- 编辑已存在的目标沿用 `replace` 语义（同一目标对象换 objective/截止/预算），不新建目标；`set/replace` 一律把 `deadlineGraceUsed`、`deadlineWarningSent` 重置（新目标生命周期重新拥有收尾与预警机会）。
- 会话内 `/goal <文本>` 行为不变（不带截止时间，`endAtMs = null`，同时清掉旧截止；缺省即「保存并运行」）。

### 状态机（权威状态，所有者 = `sessionStore` / `session_target` 表）

```text
            set({objective, endAtMs?, tokenBudget?})
   (无) ─────────────────────────────────────────▶ active
                                                    │  ▲
                          pause ────────────────────┤  │ resume（重置 deadlineGraceUsed）
                          clear ──▶ (无目标)         │  │
                          verifier 判定达成 ─────────┤  │
                          到点、收尾轮已用完 ─────────┤  │
                          budget 耗尽 ───────────────┘  │
                                                       │
   deadline_reached / budget_limited ──── resume ──────┘
   （从 deadline_reached 恢复必须显式给新的 endAtMs 或传 null 表示不再设截止，否则拒绝）
```

- `deadline_reached` 与 `budget_limited` 都是**自动停止**：不再是续跑候选，不消耗算力。
- `complete` 是终态，面板不再提供恢复；`paused` 可由用户恢复。
- `deadlineGraceUsed` 的写者只有一个（`markTargetDeadlineGraceUsed`），重置只有两处（`setTarget` 的 upsert、`updateTargetStatus` 且目标状态为 `active`）。
- `deadlineWarningSent` 的写者只有一个（`markTargetDeadlineWarningSent`），重置与收尾标志同规则。

### 事件顺序（面板操作 → 权威落库 → UI 投影）

```text
面板「暂停」
  └─▶ services.zcodeAgentService.goalSession(action:"pause")
        └─▶ server: goalSession handler
              └─▶ record.app.updateTargetStatus("paused")   ← 唯一写者
                    ├─▶ session_target.status = paused       (权威)
                    ├─▶ recordGoalStateChangeReminder(...)   (model-only 提醒)
                    └─▶ recordTargetChanged(TargetChanged)   (事件)
                          └─▶ v4 session snapshot / task index 增量同步
                                └─▶ 面板 store 订阅刷新 → 行状态更新

到点收尾与硬停（无用户操作）
  每轮 turn 结束 ──▶ 续跑候选检查（decideGoalDeadline）
                      ├─ 未到期 ─▶ verifyBeforeContinue → 注入 target_continuation（含剩余时间）→ 下一轮
                      ├─ 到期、graceUsed=false ─▶（延后判定后）置 graceUsed=true → 放行收尾轮
                      │                          （该轮续跑提示自动变为「最后一轮，请收尾」）
                      └─ 到期、graceUsed=true ─▶ updateTargetStatus("deadline_reached")
                                               + 一次性截止提醒 ─▶ 停止续跑
  turn 记账结算 ──▶ finishSessionTargetRun 的 SQL case 兜底翻状态
                    （翻动的那一次由 core 补发提醒，跃迁保证只发一次）
```

### UI 规格（可照着施工）

**面板骨架**（沿用 automations 主视图形态：自带面包屑顶栏，不套 `WorkspaceHeader`）：

| 区域 | 内容 |
| --- | --- |
| 顶栏 | 标题「任务」+ 右上「新建任务」主按钮（`button` 的 primary 变体） |
| 筛选行 | 状态筛选：全部 / 进行中 / 已暂停 / 已停止（含 deadline_reached 与 budget_limited）/ 已完成；右侧一个「显示已归档会话的任务」开关，默认关 |
| 列表 | 每行一张卡片（`bg-card border-card-border rounded-xl`），自适应两列网格，窄屏单列（仿 `OffPeakTaskList` 的列表形态） |
| 空状态 | 虚线边框容器（复用 `PluginInstallEmptyState` 的样式语言）：标题「还没有任务」+ 说明「任务会在你设定的截止时间前持续自行推进」+ 主按钮「新建任务」 |
| 加载态 | 复用 `PluginLoadingState` 的骨架样式，列表区域显示 3 行占位卡片 |
| 失败态 | 行内错误条（语义错误色 + 文字），带「重试」按钮；不整页清空 |
| 远程未连接 | 整面板只读：操作按钮 `disabled` 并在顶栏显示「远端未连接」提示；列表保留上次缓存内容 |

**列表行内容**（从左到右）：

1. 标题：`summaryTitle?.trim() || objective` 单行截断，超出用 `title` 属性显示全文。
2. 状态徽标（`text-ui-xs`）：进行中（绿）/ 未启动（中性，`paused && tokensUsed === 0 && timeUsedSeconds === 0`，D5 派生态）/ 已暂停（中性）/ 已到截止时间 · 收尾中（警示色，D5 派生态）/ 已到截止时间 · 待结算（D5 派生态）/ 已停止（`deadline_reached`、`budget_limited`）/ 已完成。进行中且 `deadlineWarningSent === true` 时加「即将到点」标记。
3. 项目：`workspacePath` 的 basename 标签（`goalDisplay.ts` 内 `workspaceLabelFromPath` 纯函数），跨项目全局列表时用户据此辨认任务归属（2026-10-13 追加）。
4. 绑定会话：会话标题（灰字 `text-ui-sm`），点击整行或「打开会话」跳转到该会话主视图。
5. 进度：
   - 有 `endAtMs`：倒计时「剩余 3 小时 12 分」（每 30s 刷新一次）；过期显示「已到截止时间」。
   - 有 `tokenBudget`：`tokensUsed / tokenBudget`；无预算则显示已用 token。
6. 行尾操作（`dropdown-menu` 收纳次要动作，该组件自带 `[app-region:no-drag]`）：暂停/恢复（未启动显示「运行」= `resume`）、编辑、清除（`destructive`，走 `ConfirmDialog` 二次确认）、打开会话。**恢复一个 `deadline_reached` 的目标时先弹「重新设定截止时间」小表单**（含「不再设截止时间」= 传 `endAtMs: null`），因为服务端会拒绝不带新截止时间的恢复。

**新建 / 编辑表单**（整页表单，与 `AutomationEditView` 同形制）：

| 字段 | 控件 | 校验与说明 |
| --- | --- | --- |
| 任务描述 | 多行文本域 | 必填、非空；提示语「写清目标与验收条件，例如：到明早 10 点前持续发现 AI 产品设计缺陷并改进」 |
| 目标任务项目 | 下拉（`useAutomationProjectOptions`，仿 automations「目标项目」） | **仅新建时可改**，默认当前工作区（当前工作区不在选项里时并入）；编辑时锁定为该目标所属项目；选项的 `workspacePurpose === "conversation"` 显示为「无项目会话（default）」 |
| 截止时间 | 日期 + 时间选择（本地时间） | 可空；**只校验用户新填/改过的值**：与原值相同放行，新值在过去则禁用提交并显示错误；「保存并运行」额外要求空或未来 |
| Token 预算 | 数字输入 | 可空；正整数；辅助文案「到达上限会自动停止」 |
| 承载会话 | 单选：新建会话（默认）/ 选择一个已有会话 | 选已有会话时用会话搜索下拉（**限定在所选项目内**） |
| 时间预算提示 | 只读文案 | 「到点后任务会停止，可在面板中重新设定截止时间继续」 |

提交按钮两个（2026-10-13 追加，用户口径）：「保存」（`start: false`，不运行）与「保存并运行」（`start: true`）。新建默认聚焦「保存」。

提交成功后：关闭表单、回到面板；新行以对应状态出现（保存 → 未启动；保存并运行 → 进行中），并**自动跳转到承载会话**（用户能立刻看到模型开始干活；保存不运行则只是打开该会话，不触发任何模型执行）。

**动效与可达性**（遵循 `DESIGN.md`）：行状态变更用既有过渡时长，不做新动画；所有操作可键盘到达，焦点可见；状态不只用颜色表达，同时带文字徽标。

## 所有权与不变式

- **唯一所有者**：`session_target` 表（`sessionStore` 端口）。面板、协议、task index、v4 快照都只是它的投影或消费者。
- **唯一写者**：`record.app.setTarget` / `setTargetStatus` / `clearTarget`（`session-facade.ts`）。面板不得直接写状态，只能发命令。
- **到点的唯一裁决点**：`decideGoalDeadline`（contracts，纯函数）。任何新增状态都必须在续跑候选的 `status === "active"` 早退处自动出局，不得用额外分支各自判断。
- **收尾只给一次**：`deadlineGraceUsed` 在行上持久化，`markTargetDeadlineGraceUsed` 是唯一写点；重置只有 `setTarget`（set/replace）与「激活为 active」两处。标记必须在放行收尾轮**之前**落库（跨进程重启仍然只给一次）。
- **提醒只发一次**：只有「读到 active、结算为 deadline_reached」的那一次跃迁发提醒。
- **不引入每轮注入**：上下文前缀不新增 goal section；任务的持续可见性只依赖既有的会话历史与续跑提醒。
- **工作区隔离**：`scope: "workspace"` 的所有列表查询用 `workspaceIdentity?.trim() || workspacePath`；不使用路径近似替代。`scope: "all"` 是显式的跨项目读取（面板默认），不做隔离过滤。
- **远端语义**：面板的读取只读；`remote-waiting` 时禁用写操作，不回落到本地身份。
- `endAtMs` 与 `tokenBudget` 相互独立，可同时存在；任一触发即停，`status` 记录先触发者（预算优先判定）。
- **不再静默启动**：任何「保存不运行」（`start: false`）都不触发续跑、不消耗算力；只有「保存并运行」或恢复才进入续跑候选。

## 失败语义

| 情形 | 行为 |
| --- | --- |
| 提交过去的截止时间 | 表单层拒绝，不入库；不产生目标变更事件 |
| 到点时正有一个 turn 在跑 | 该轮结束时经候选检查：先置 `graceUsed` 并放行收尾轮；收尾轮结束后再结算 `deadline_reached`。记账 SQL 只做兜底 |
| 收尾轮被背景任务延后 | 放行顺序放在背景任务延后判定**之后**，因此延后不会吃掉唯一一次收尾机会 |
| 到点时会话完全空闲 | 无 write；面板显示派生的「已到截止时间（待结算/收尾中）」；下次任意运行时活动结算 |
| 校验器判定达成与到点同轮发生 | 校验器先跑，置 `complete`；不再翻 `deadline_reached`（A15） |
| 校验器失败（无 `nextAction`）与到点同轮发生 | 收尾标志已落库，下一轮检查结算 `deadline_reached`；不会永久停在 `active` |
| `goalList` 查询失败 | 面板保留上次缓存并显示失败条 + 重试，不清空列表 |
| 恢复一个已过期的 `deadline_reached` 目标 | legacy handler 必须收到新的 `endAtMs`（或显式 `null`），否则拒绝并提示 |
| 标记写库失败（DB 锁定等） | 记 `warn`（`target.deadline.wrap_up_mark_failed`），不放行该轮；下一轮检查重试，最坏多给一轮收尾，好过直接跳过硬停 |
| 结算写库失败 | 记 `warn`（`target.deadline.settle_failed`），不阻塞 turn 收尾；下次活动重试结算 |
| 预算与截止同时满足 | 预算分支在前，翻 `budget_limited`，不再翻 `deadline_reached` |
| 未配供应商时「保存」（`start: false`） | 走只读客户端，目标正常落库为未启动/保持原状；后续「保存并运行」才需要供应商 |
| 预警标志落库失败 | 记 `warn`（`target.deadline.warning_mark_failed`），不影响 turn 记账；下一轮重新判定 |
| `scope: "all"` 查询 | 与 workspace 查询同一条只读链路；数据量过万可加分页（当前 `limit` 默认 500，未做游标） |

## 迁移边界

1. **一个迁移 `0023_session_target_deadline`**：因为 `status` 有 check 约束，加 `deadline_reached` 必须重建表；`end_at_ms` 与 `deadline_grace_used` 两列随同一次重建落库（照抄 `0005` 的 `create new → insert select → drop → rename`），避免「alter 加列 + 再重建」的两次全表写。
2. **重建保留全部既有列与行**：老行 `end_at_ms` 取 `NULL`、`deadline_grace_used` 取 `0`。
3. **追加 `0024_session_target_deadline_warning`**（2026-10-13）：`alter table ... add column deadline_warning_sent integer not null default 0`。新列无 check 约束，不需要重建表；0023 已定型的历史迁移不可改动（sha256 校验）。
4. **向后兼容**：老行 `end_at_ms = NULL` ⇒ 无截止，行为与今天完全一致。协议层新增字段一律可选（`zcodeSessionGoalSchema` 的新字段带 `.default(...)`），旧客户端不受影响；`GoalStatus` 多了个值，旧客户端只在真遇到该值时才需要更新。
5. **不做数据回填**：不猜测历史目标的截止时间。
5. **不迁移到 v4 协议**：`goalList` 走 legacy 命令族；若将来 v4 需要跨会话目标查询，另立任务，不在本文扩散。

## 验收场景

| # | 场景 | 步骤 | 断言 | 证据要求 |
| --- | --- | --- | --- | --- |
| A1 | 面板新建任务（新建会话，保存并运行） | 面板 → 新建任务 → 填描述 + 截止时间 → 保存并运行 | 新会话创建；`session_target` 行 `objective` 与 `end_at_ms` 正确且 `status = active`；跳转到该会话并开始干活 | 面板截图 + DB 行 |
| A2 | 面板新建任务（挂已有会话） | 选择已有会话 → 保存并运行 | 目标写在所选会话上，不新建会话 | DB 行 `session_id` |
| A3 | 到点硬停 | 设 1 分钟后截止，让模型持续干活 | 到点后先有一轮收尾，之后不再出现新一轮续跑；`status = deadline_reached`；会话收到一次性截止提醒 | 事件流 + 状态值 + 提醒文本 |
| A4 | 到点时正在跑 | 在 turn 执行中到点 | 该轮结束后走两段式，状态只翻一次（幂等） | `TargetChanged` 事件仅一次状态变更 |
| A5 | 空闲会话过期 | 设短截止后不再交互 | 面板显示「已到截止时间（待结算）」，DB 仍为 `active` 直至下次活动 | 面板截图 + DB 值 |
| A6 | 预算与截止并存 | 同时设预算与截止，先触预算 | 翻 `budget_limited` 后不再翻 `deadline_reached` | 状态终值 |
| A7 | 结束条件达成 | 目标达成，校验器通过 | 置 `complete`，面板不再提供恢复 | 状态 + UI |
| A8 | 暂停/恢复/清除 | 面板行操作各执行一次 | `paused` / `active`（且 `deadline_grace_used` 归零）/ 行消失；清除走二次确认 | DB 状态序列 |
| A9 | 过期目标恢复 | 恢复一个 `deadline_reached` 且不填新截止 | 被拒绝并提示 | UI 错误文案 |
| A10 | 远程未连接 | 断连后打开面板 | 只读、按钮禁用、显示未连接提示、保留缓存 | 面板截图 |
| A11 | 跨项目全局列表 | 两个项目各有任务，面板以 `scope: "all"` 打开 | 两个项目的任务都在面板里，行上标出各自项目 | 面板截图 + 返回条目数 |
| A12 | 老数据兼容 | 用无 `end_at_ms` 的历史库启动 | 列表与续跑行为不变 | 迁移前后行数一致 |
| A13 | 收尾只给一轮 | 到点后连续观察多轮 | 只有第一轮带收尾文案；后续不再注入续跑 | 会话事件序列 |
| A14 | 恢复重置收尾 | 到点停止后重新设截止并恢复 | `deadline_grace_used = 0`，且能再收尾一次 | DB 值 + 事件 |
| A15 | 校验器通过优先 | 到点那一轮校验器判定达成 | 置 `complete`，不翻 `deadline_reached` | 状态终值 |
| A16 | 保存不运行 | 新建 → 只点「保存」（不选「保存并运行」） | `status = paused`；未配供应商也能保存成功；不出现任何续跑；面板行显示「未启动」 | DB 值 + 事件流 |
| A17 | 到点前预警 | 设 2 分钟内截止并保持活跃 | 进入剩余 10 分钟窗口后：续跑提示出现 `Deadline approaching`；会话收到一次预警提醒；面板行显示「即将到点」 | 事件流 + 提醒文本 + 面板截图 |
| A18 | 表单项目选择 | 新建时把目标任务项目选为另一个项目 | 新会话与目标落在所选项目；保存后跳转到该项目 | DB 行 `s.directory` |
| A19 | 编辑过期目标 | 编辑一个截止已过的目标，只改描述、不动截止时间 | 「保存」可用（只校验新改值）；「保存并运行」被禁用并要求先改/清空截止 | UI 状态 + DB 值 |

自动化覆盖现状：迁移与 SQL 行为由 `apps/zcode-cli/packages/adapters/test/session-target-deadline.test.ts` 覆盖（12 例：含 0024、预警标志 mark/重置）；到点裁决、预警判定与三处文案由 `apps/zcode-cli/packages/core/test/goal-deadline-decision.test.ts` 覆盖（11 例）；`goalList` 的工作区隔离、归档过滤与 `scope: "all"` 由 `apps/zcode-cli/packages/bootstrap/test/goal-list.test.ts` 覆盖（5 例）；`start` 参数语义由 `apps/zcode-cli/packages/bootstrap/test/goal-start.test.ts` 覆盖（4 例）；服务层 wire 形状（listSessionGoals 的 workspaceKey、scope、start）由 `packages/services/test/zcodeAgentService.goals.test.ts` 覆盖（4 例，真实 stdio 假 agent）；面板 store 由 `packages/ui/test/goalManagementStore.test.ts` 覆盖。A1–A19 里依赖真实模型/真实 UI 的场景需要人工或 E2E 验证（本轮未在真实浏览器里跑过面板渲染，见遗留 ⑥）。

## 实施顺序（已按此完成）

1. 迁移 `0023` + 状态枚举扩展（含表重建）+ `session-target.ts` 的 deadline SQL / 重置 / 列表查询。
2. `SessionGoal`/schema/投影/task index 加 `endAtMs` 与 `deadlineGraceUsed`（全枚举副本 + 两个纯函数 + 三处提示文案一起改）。
3. core 的到点两段式（候选结算 + 收尾放行 + 记账兜底提醒）与重置规则。
4. 协议 `session/goalList` + `set/replace`、`resume` 的 `endAtMs` 参数（shared → bootstrap → services 三层）。
5. services `listSessionGoals` + UI store。
6. UI 主视图面板 + shell 接线 + i18n。
7. `CONTEXT.md` 新增「会话目标（goal）」「任务面板」词条。

**2026-10-13 追加轮**（用户四项反馈）：① 表单截止校验只校验新改值；② 预警（contracts 阈值 + 迁移 0024 + core 一次性提醒 + 面板徽标）；③ 保存/保存并运行（协议 `start` + `resolveGoalStartStatus` + 只读客户端路由）；④ 面板改全局列表 + 表单项目选择器。修两项自修 bug：`listSessionGoals` workspace 手拼形状、编辑过期目标被禁提交。对应测试见「自动化覆盖现状」。

## 实现订正记录

本稿有三处**相对设计稿的偏离**，均为提高正确性或避免死路径：

1. **迁移合并为一条**：设计稿写「`alter table` 加两列 + 另做一次表重建扩枚举」，实现合成为一条 `0023`（重建时一并带上两列）。终态完全一致，少一次全表写。
2. **截止提醒的文案与发射点在 core，不扩 facade 的私有函数**：设计稿 D7 写「扩展 `goalStateChangeReminderText` 的 `deadline_reached` 分支」。但结算发生在 core，该函数是 facade 的模块私有函数，core 取不到；若只在 facade 加分支则永不执行。实现改为 contracts 里的 `GOAL_DEADLINE_REACHED_REMINDER_TEXT` + core 发射，并额外把「记账 SQL 兜底翻状态」也补发了提醒（设计稿漏了这一条路径的提醒）。

另外四处**对设计稿的细化**（不算偏离，记以备查）：

3. **`session/goalList` 的参数类型去掉必填 `sessionId`**：设计稿把 `ZCodeAgentGoalListParams` 写成继承 `ZCodeAgentSessionTarget`（`sessionId: string` 必填），但 list 查询是 workspace 级的、实现根本不读 `sessionId`。实现改为继承 `ZCodeAgentWorkspaceTarget`，避免调用方为了过类型检查编造一个不存在的会话 id。
4. 收尾轮的放行排在「背景任务延后」之后、「完成校验器」之前（理由见 D3 落点 2）。
5. `session/goal` 的 `set/replace` 顺带把已存在于 facade 类型里的 `tokenBudget` 也接进了协议参数（此前协议层没这个字段，预算只能由内部调用方设置）。
6. CLI 命令中心的 `CommandCenterTargetStatus` 也补了 `deadline_reached`（否则从 DB 读到的该状态会违反类型）并展示截止时间；但**从 CLI 文本命令创建带截止时间的目标**仍未做（见遗留 ①）。
7. 状态文案键族从设计稿的 `chat.target.status.*` 换成新面板自己的 `goals.status.*`（理由见 D4 末段）。

**2026-10-13 追加（用户四项反馈 + 两项自修 bug）**

8. **「保存」与「保存并运行」分开**（用户口径）：协议加 `start: boolean`，`start: false` 只落库不运行（新建落 `paused`、编辑保持原状），由纯函数 `resolveGoalStartStatus` 裁决；`/goal <text>` 缺省语义不变。同时发现并修掉一个连带问题——旧实现里 `set` 走 `getClient`（要求先配模型供应商），导致「保存一个不运行的目标」都被供应商卡住；`start: false` 改走 `getReadOnlyClient`。
9. **到点前预警**（用户口径）：阈值常量 `GOAL_DEADLINE_WARNING_LEAD_MS = 10 分钟` 只放 contracts；服务端在首次跨过窗口时翻转持久化标志 `deadline_warning_sent`（迁移 0024）并发一次性提醒，UI 只读该标志显示「即将到点」。阈值不做 UI 副本，避免漂移。续跑/校验/resume 三条提示词通道同步输出 approaching 状态。
10. **表单加「目标任务项目」选择器**（用户口径）：面板改为全局列表（`listSessionGoals` 加 `scope: "all"`），行上展示项目 basename；表单照 automations 先例用 `useAutomationProjectOptions`，仅新建可改、编辑锁定。
11. **表单截止校验改为「只校验新改值」**（用户口径，修掉遗留 ③）：与原值相同的截止放行，「保存并运行」始终要求空或未来。
12. **`listSessionGoals` 的 workspace 手拼 bug**（自修，用户报「点开就加载任务失败」）：服务层曾手拼 `{workspacePath, workspaceIdentity}`、漏掉 schema 必填的 `workspaceKey`，被服务端 parse reject。改为 `buildWorkspaceRef(params)` 统一构造，并新增真实 stdio 假 agent 回归测试钉死 wire 形状。

## 遗留（分类）

**需你后续拍板（不影响本轮施工）**

1. 是否要 CLI 文本命令中心也支持创建截止时间（例如 `/goal --until 10:00 ...`）。本轮只做面板入口；命令中心已能**展示**截止时间。
2. 面板固定 `includeArchived: true` 一次取全量（归档开关在客户端过滤，切换零延迟、不发新查询），代价是单次返回包含归档会话的目标。数据量大或需要分页时，可改为服务端过滤 + 分页（`limit` 默认 500，当前只取前 500 条，未做游标翻页）。
3. 编辑一个 `active` 目标点「保存」会保持 active 不打断运行——这是既定语义（保存 ≠ 暂停），但若用户想「改完就停」需要先暂停再编辑，流程多一步。是否要「保存时顺带暂停」的第三个按钮，请你定。
4. 「保存并运行」若持有**已过期**的截止时间会被表单禁用（必须先改/清空时间）——这是 ① 校验规则的直接结果，不是 bug。若觉得该字段可以更宽（例如允许带着旧过期值运行、让它立刻走收尾），请说。

**已知代价，接受即可**

5. 空闲会话的过期状态不即时落库（D5 的派生显示兜住）。要做到即时，需要常驻定时器，与仓库「不用超时掩盖」的取向冲突，成本不值当。派生态由面板本地时钟每 30 秒 tick 刷新，最多有 30 秒显示滞后。预警标志同理：目标在窗口内 idle 时要到下一次记账才翻。
6. 从 `deadline_reached` 恢复在**非面板入口**（v4 会话状态面板、CLI 命令中心）没有 A9 的友好拒绝：它们会恢复成功并立刻走一轮收尾再停。语义安全（不丢约束、不静默启动注定要停的任务），只是不如图板提示友好；要统一需要给 v4 resume 命令加参数，属协议扩展，不在本文范围。
7. 校验器本身失败（无 `nextAction`）时目标会停在 `active` 直到下一次活动结算 `deadline_reached`（写了收尾标志之后）。这是既有保守停止语义 + 新增结算的叠加结果，不是新引入的问题。
8. 面板的 React 渲染（下拉、恢复弹窗、i18n 取值、倒计时）本轮**未在真实浏览器里跑过**，只做到类型 / lint / store 单测这一层；仓库没有 goals 面板可用的组件渲染测试入口。人工验收路径见 A1–A19。
9. `scope: "all"` 在远端工作区只列出**那台远端机器**数据根里的项目（跨机器全局需要多连接 fan-out，不在本轮）。

**不属于本功能、另立任务**

10. 多目标任务（一个会话同时多个目标）：当前 `session_target` 以 `session_id` 为主键，天然单目标。面板按「一任务一会话」呈现，不触碰存储形状。
11. v4 侧跨会话目标查询：本轮走 legacy 命令族。
