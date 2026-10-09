# 上下文压缩控制（Context Compaction Controls）

主责包：`apps/zcode-cli/packages/core`。

涉及的其他包：

- `apps/zcode-cli/packages/contracts`：`CompactTrigger` / `CompactPhase` 枚举、hook 输入契约、`CompactConfig`。
- `apps/zcode-cli/packages/adapters`：CLI 配置文件 `compact` 段与 `ConfigKey.Compact`。
- `apps/zcode-cli/packages/bootstrap`：会话创建期注入、workspace 级热更新 RPC、策略映射。
- `packages/shared`：`zcode-protocol` 的偏好 schema 与广播载荷、`validationAppSettings` 的开关字段。
- `packages/services`：本地/远端 `resolveSessionRuntimePreferences` 应答、`zcodeAgentService` 的偏好同步分发、跨身份迁移白名单。
- `packages/ui`：设置页「上下文压缩」分区。

---

## 1. 背景与问题

ZCode 的压缩链路本身是完整的：手动 `/compact`（`StandaloneTurn`）、自动压缩（`Auto`，覆盖 `PreRequest` 与 `MidTurn`）、溢出后的响应式压缩（`Reactive`），以及一套已写完但**从未运行过**的局部压缩（microcompact，清理旧工具结果）。

问题出在配置面上——这些路径原本没有任何配置入口：

1. `AgentRuntimeConfig.compact` 全仓没有写入者，唯一来源是 `resolveAppRuntimeConfig` 里 `...options.runtimeConfig` 的透传，而没有任何调用方设置 `options.runtimeConfig.compact`。
2. microcompact 的门是 `config.microcompact?.enabled === true`，同样无人写入 → **microcompact 恒关**。
3. `ConfigKey.FeatureCompact`（`features.compact`）只有 `adapters` 自己读写，`features.compact:false` 不会关掉任何压缩路径（真正生效的是 `config.compact.enabled === false`）。

同时，最近的 hook 地基改造（P0–P4）把 `PreCompact`（可阻断）/`PostCompact`（可注入）/`PreModelSwitch` 接通到了运行时，暴露两个缺口：

- `PostCompactHookInput.outcome` 契约允许 `"completed" | "skipped" | "failed"`，但运行时**从不发射 `"failed"`**：失败直接落 timeline 失败事件后抛错。
- `PreCompactHookInput.compactTrigger` 是硬编码联合 `"manual" | "auto" | "reactive"`，既无法表达新的触发来源，也拿不到 `phase`。

行业对标（Codex 的轮末压缩与模型降档提前压、Gemini 的阈值 50%、Continue 的 ≈88.4%、SWE-agent 的"只保留最近 N 条观察"）说明：**阈值可调、轮末压缩、降档提前压、工具结果局部清理是低成本高收益的控制点**；而"独立摘要模型""外置记忆库""文件级分层"三项经评估收益低或与既有实现冲突，本轮及以后都不做（见 §7）。

### 1.1 阈值口径：为什么用户调的是"安全余量"而不是百分比

阈值本质是"离输入侧上限还留多少 token 的余量"。用百分比表达会产生两个真实缺陷：

1. **缓冲随窗口被按比例吃掉。** 同一 83% 在 200K 模型上是 166K（余量 13000），在 128K 模型上只剩约 0.8K 缓冲——小窗口上本该留出的绝对余量被比例缩没了，模型更容易在输出中途撞上限。
2. **界面显示的百分比照抄回填不能复现自动值。** 128K 窗口的自动阈值是 94K，反算显示 73%；用户填 73 得到 `floor(128000 × 73 / 100) = 93440 ≠ 94000`。用户会以为自己没改东西，实际改了。

因此本 spec 的定稿口径是：**用户调 `bufferTokens`（绝对余量，tokens），百分比只是反算出来的只读展示值**，没有任何写入路径。

## 2. 设计决策

### D1. 七个控件，默认全部"维持现状"

| # | 设置项 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- | --- |
| 1 | `compactionBufferTokens` | `number \| null` | `null`（不覆盖） | 自动压缩的安全余量（tokens）：阈值 = 输入侧上限 − 余量 |
| 2 | `compactionMicrocompactEnabled` | `boolean` | `false` | 局部压缩：清理旧工具结果正文 |
| 3 | `compactionMicrocompactKeepRecentToolResults` | `number` | `5` | 局部压缩保留最近多少组工具结果 |
| 4 | `compactionMicrocompactClearErrorResults` | `boolean` | `false` | 局部压缩是否连失败的（isError）工具结果一起清 |
| 5 | `compactionPostTurnEnabled` | `boolean` | `false` | 轮末压缩：一轮成功后主动压，而非等下一次请求前 |
| 6 | `compactionPostTurnThresholdOffsetTokens` | `number` | `0` | 轮末压缩的独立阈值提前量（tokens）：轮末阈值 = 自动阈值 − 提前量 |
| 7 | `compactionModelDownshiftEnabled` | `boolean` | `false` | 模型降档提前压：切到更小窗口模型前先压 |

"默认维持现状"是硬约束：不显式打开任何开关时，压缩行为必须与改造前逐位一致（见 §4 I1、I8）。

### D2. 开关是产品级，hook 是叠加层

- 设置项只表达"要不要启用某条产品路径"，**永不阻断**压缩。
- hook（`PreCompact`）是用户叠加的裁决层，**可以阻断**；但 hook **不能强制**触发压缩。
- 两者语义独立：设置项在 hook 之外决定"是否走到 hook"，hook 在设置项放行之后决定"是否放行"。

### D3. 即时生效

压缩策略在每次 turn-loop 迭代被重新读取（`microcompactIfNeeded` / `autoCompactIfNeeded` 每次都从 `this.config.compact` 现算 `AutoCompactPolicyConfig`），因此**只要热更新 `runtime.config.compact`，下一次迭代即生效**，不需要重启会话。

新增 workspace 级协议方法 `workspace/updateCompactionPreferences`（载荷为七项设置），落点：

1. 写入进程级 `context.appRuntimePreferences.compaction`（供之后创建/恢复的会话使用）；
2. **逐个已存在 session 调用 `record.app.setCompactionPolicy(policy)`** 热更新。

模式完全对齐既有的 `workspace/updateModelIoPreferences`。

### D4. 创建期通道

`session/requestRuntimePreferences` 的结果新增 `compaction` 对象，`resolveSessionStartupPreferences` → `createRecord` 把它写进 `runtimeConfig.compact`。这样新会话与恢复会话在起始态就带上用户的设置。

### D5. CLI 文件通道

`ZCodeConfigFileSchema` 新增 `compact` 段（`adapters/src/config/schema.ts` 的 `compactSchema`），经 `RuntimeConfigPatch.compact` → `ConfigKey.Compact` → `RuntimeConfig.compact`，最后由 `resolveAppRuntimeConfig` 逐字段并入 `AgentRuntimeConfig.compact`。模式对齐 `modelAnomalyGuard`。

这条保证纯 CLI / headless 用户（没有设置页）也能配置。

adapters 侧共三处必须同时改，缺一处就是**静默失效**（schema 校验通过、不报错、配置不生效）：

1. `schema.ts`：段本身。
2. `config-merger.ts`：该文件**逐段手写**合并（`if (config.X) result.X = {...}`），漏一段会在多层配置合并时整段丢弃。
3. `index.ts`：写入 `ConfigKey.Compact`、读进 `resolveConfig()` 的返回对象、在 defaults 分支给默认值。

### D6. 两个映射函数，按"谁有权威"分工

协议层七项 → core 策略的映射只在 bootstrap 写一份，但**创建期与热更新期的语义不同，因此是两个函数**（`bootstrap/src/compaction-policy.ts`）：

- `compactionPreferencesToPolicy()`：**热更新用**。七项全量 present，语义是"用户当前选择"，因此能关掉刚打开的东西；`bufferTokens` 为 `number | null`，`null` 表示显式清除覆盖、回到文件值/默认余量（与旧 `thresholdPercent: null` 语义一致）。
- `compactionPreferencesToPolicyOverride()`：**创建期用**。只含偏离默认值的字段，语义是"用户表达过的偏好"，因此文件段里设置页没表达过的配置一律存活（D12）。必须靠**条件构造省略键**，不能写成 `{bufferTokens: x ?? undefined}`——后者键仍在，展开时会把文件值清成 `undefined`。`bufferTokens === null` 与 `postTurnThresholdOffsetTokens === 0` 都视为"未表达"，省略键。

两者都刻意为 `microcompact` 只产出设置页拥有的三个子键，且不产出 `enabled`（顶层）。

### D7. 阈值只有"安全余量"一个可调项（tokens），百分比是反算出来的只读展示

- 运行时阈值公式（唯一）：`threshold = max(0, (contextWindow − min(maxOutputTokens, 21000)) − buffer)`，`buffer` 默认 13000，可由 `bufferTokens` 覆盖。
- 用户可调项 = `bufferTokens`（tokens，1000–100000 整数；`null` = 不覆盖，回落默认余量）。
- 百分比仍由 `getAutoCompactThresholdPercent` 反算（`floor(threshold / contextWindow × 100)`），只用于决策日志/遥测与设置页只读展示，**没有写入路径**。
- `thresholdPercent`（1–100 整数或 `null`）与死字段 `thresholdPercentOverride` 一并**删除**：不再有"百分比覆盖"分支，`normalizeThresholdPercent` 删除。删除理由见 §1.1。
- 越界余量（<1000、>100000、非整数、非有限数）一律**按未配置处理并回落默认余量**（fail-safe：宁可沿用既有阈值，也不改成用户没要求过的值）。四个配置入口（协议 schema、AppSettings 校验、CLI 文件 schema、设置页解析器）都先做范围校验，故 `bufferTokens` 到不了 core；core 的 `positiveInt`（非有限数/负数回落默认）是最后一道防线——注意它**接受 0**，而 0 意味着"阈值 = 输入侧上限"，只能由上面四道校验拦住。

即：**未显式配置余量的用户阈值一分不动**（200K 窗口仍是 166K ≈ 83%），避免了"给所有模型钉一个固定百分比"带来的静默行为变更。

### D8. 轮末压缩：独立阈值（提前量，tokens）+ turn 成功后内联执行

位置：`turn.ts` 中 `TurnComplete` 事件与 usage 事实**已发射之后**、`return result` 之前。

- 触发条件（全部满足才执行）：`config.compact?.postTurnEnabled === true`、本轮 turn 成功、`evaluateRuntimeAutoCompactDecision(runtime, model, { forPostTurn: true })` 判定需要压、**当前 active turn 队列无排队输入**。
- **独立阈值**：`轮末阈值 = max(1, 自动阈值 − postTurnThresholdOffsetTokens)`。提前量缺省或为 0 ⟹ 与自动压缩阈值完全相同（I8）；用户设了提前量后，轮末**可以比自动压缩更早**触发——这正是本功能存在的意义。夹紧到 1：提前量再大也不会把阈值压成 0（那会变成每次轮末都压）。
- 实现：`applyPostTurnThresholdOffset(config, offset)`。提前量为 0/未配置时**原样返回入参 config 引用**，不做任何单位换算；非 0 时通过抬高 `bufferTokens`（阈值 = 输入侧上限 − 余量）表达，全程只有 tokens 加减，**不经过任何百分比换算**。
- 判定复用：`evaluateRuntimeAutoCompactDecision(runtime, model, options?)`。不传 `options`（自动压缩路径）时逐位保持既有判定；`forPostTurn: true` 才施加偏移。
- "队列无排队输入"这条短路是为了避免在用户马上要发下一轮时多做一次无谓压缩——那种情况下一轮的 `PreRequest` 会自动压，且用户能立刻看到新轮开始。
- 复用 `compactActiveConversation`，`trigger = PostTurn`、`phase = PostTurn`、`compactReason = ContextLimit`、`model = loopState.model`。
- 失败只记 `warn` 日志，**不改变已完成 turn 的结果**（turn 已经成功，压缩是后续维护动作）。

**可达窗口分析（重要，解释为什么需要提前量）**：turn-loop 在每个迭代**开头**（发请求前）各检查一次阈值——首次是 `PreRequest`，其后是 `MidTurn`；循环在拿到**纯文本回答**时立刻 `break`（`turn-stop.ts`），而该回答在 break 之前已经 commit 进 `messageHistory`（`turn-stop.ts` 入口处）。因此轮末这次检查只比上一次（MidTurn / PreRequest）多看到"本轮最后那次增量"。在提前量 = 0 时，**只有这一次增量正好顶过自动阈值线，轮末才会触发**——窗口很窄。提前量的作用就是让用户主动把轮末阈值压低，使这个窄窗口里的增量也足以触发。

另有一条不常见的 break 路径：工具主动请求结束本轮（`turn-tools.ts`），那条路上该批工具结果不再被检查，逃逸增量更大。

**有意为之的语义**：压低阈值后，轮末**可能**在下一轮 `PreRequest` 并不会触发的情况下也压缩。这不是缺陷：这份工作本来也要在不远处做，时机前移后用户感知的等待更短，也消除了下一轮在 `MidTurn` 阶段被压缩打断的风险；代价是这段时间 runtime 仍持有 active turn，新输入会先排队。

### D9. 降档压缩：在 PreModelSwitch 注入之前

位置：`turn-model.ts` 的 `applySubmissionExecutionState` 内，`setSessionModelSelection` + `persistRuntimeModelSelection` 之后、`emitModelSelected` **之前**。

顺序理由：`PreModelSwitch` hook 的注入上下文会写进 messageHistory 末尾，而压缩会整体替换 messageHistory 并只保留 context prefix + summary + 最后一组轮次。如果压缩发生在注入之后，注入内容会被吞掉。所以顺序必须是：

```
解析新模型 → setSessionModelSelection → 【降档检测 → 压缩】 → PreModelSwitch（注入） → ModelSelected 事件 → PostModelSwitch
```

触发条件：`config.compact?.modelDownshiftEnabled === true`，且新旧模型 `contextWindow` 相比**变小**（严格 `<`），且 `shouldAutoCompact` 判定需要压。

失败不阻断切换（记 `warn` 后退化到"切换后由 Reactive 压缩兜底"）。

### D10. 契约扩展

- `CompactTrigger` 新增 `PostTurn: "post_turn"`、`ModelDownshift: "model_downshift"`。
- `CompactPhase` 新增 `PostTurn: "post_turn"`。
- `PreCompactHookInput` / `PostCompactHookInput` 的 `compactTrigger` 改为 `CompactTrigger` 类型，并新增可选 `phase?: CompactPhase`、`trigger?: CompactTrigger`（`compactTrigger` 保留为兼容别名，与 `trigger` 同值）。
- `PostCompact` 在失败路径发射 `outcome: "failed"`。

以上枚举都进 `contracts/src/compact/index.ts` 的 zod enum（`compactTimelinePayload` 与 `compactBoundaryPayload` 两处），漏改会被既有 schema 拒绝并冒泡成事件落库失败。

### D11. 保持"零重复写入路径"

一个值只有一个写入者：

- workspace 级事实源：`context.appRuntimePreferences.compaction`（bootstrap preferences handler 唯一写）。
- 会话级运行态：`AgentRuntimeConfig.compact`，只由 `runtime.updateCompactionPolicy()` 与创建期初始化写。
- 持久化的用户偏好：`AppSettings`（`settingService` 唯一写），是 UI 的事实源；它通过 preferences RPC 单向下发，不回读运行态。

### D12. 设置层与文件层的叠加是"逐字段覆盖"，不是"整份替换"

`AgentRuntimeConfig.compact` 有两个来源：CLI 文件段（headless/TUI 用户）与设置页（桌面/Web/移动）。二者**共同**拥有其中一部分字段、**各自**独占另一部分，所以叠加必须逐字段进行：

| 字段 | 文件段 | 设置页 |
| --- | --- | --- |
| `enabled`（压缩总开关） | ✅ 独占 | ❌ 不写（设置页不得关掉自动压缩） |
| `bufferTokens` | ✅ | ✅（`null` = 不覆盖） |
| `postTurnEnabled` / `postTurnThresholdOffsetTokens` / `modelDownshiftEnabled` | ✅ | ✅ |
| `microcompact.enabled` / `keepRecentToolResults` / `clearErrorResults` | ✅ | ✅ |
| `microcompact.thresholdTokens` / `idleThresholdMinutes` / `compactableToolNames` / `minTokenSavings` | ✅ 独占 | ❌ 不写 |
| `summaryReserveTokens` / `maxConsecutiveFailures` | ✅ 独占 | ❌ 不写 |

三条规则：

1. **设置页只写属于自己的字段，且永不整体替换 `microcompact`**（`LocalMicrocompactPolicyConfig` 字段全 optional，逐键覆盖在类型上本就可行）。整体替换会在用户只切换「轮末压缩」时静默抹掉文件里独占的四个键。
2. **"未表达"与"显式关闭"必须区分**。设置页七项都是布尔/数值，没有三态（`bufferTokens` 的 `null` 是唯一例外，语义是"不覆盖"），所以：
   - **热更新路径**（`workspace/updateCompactionPreferences`）总是整份下发七项，语义是"用户当前选择"，因此能关掉刚打开的东西；`bufferTokens: null` 显式清除覆盖、回到默认余量。
   - **创建期路径**只下发**偏离默认值**的字段（靠条件构造省略键，而不是 `x ?? undefined`），语义是"用户表达过的偏好"，因此文件里设置页没表达过的东西一律存活。
3. 因此"设置页能打开文件里关着的开关、但关不掉文件里打开的开关"这条性质**只成立于创建期**。**热更新期的语义不同且有意如此**：用户在设置页的操作就是当前意图，因此七项全量下发，用户能把文件里打开的 `microcompact` 关掉，也能把文件里的余量覆盖清掉。二者合起来的规则是：

   > 用户没表达过的偏好一律让位给文件；用户当下表达的偏好覆盖文件（但对同一会话，只有在设置页真的操作过一次之后）。

   这里存在一条**有意的、非静默的不对称**：`AppSettings` 没有三态，"没打开"与"用户点了关"不可区分，所以创建期只能选择"不表达"，代价是设置页无法在**新建会话**时关掉文件里打开的开关。取这个方向是因为它不会静默撤销文件里明确写下的配置；而热更新路径由用户显式动作触发，能完整表达"关掉"。

`resolveAppRuntimeConfig` 与 `updateCompactionPolicy` 都必须按此语义逐字段合并；`microcompact` 那一层要深合并。`config-merger.ts` 也逐段手写，漏一段会让文件段在多层配置合并时被静默丢弃。

## 3. 行为

### 3.1 七个设置的生效点

| 设置项 | 生效点 | 生效时机 |
| --- | --- | --- |
| `compactionBufferTokens` | `getAutoCompactThreshold`（`compact/policy.ts`） | 下一次 turn-loop 迭代 |
| `compactionMicrocompactEnabled` | `resolveLocalMicrocompactConfig`（`runtime/methods/microcompact.ts`） | 下一次 turn-loop 迭代 |
| `compactionMicrocompactKeepRecentToolResults` | `maybeLocalMicrocompactMessages` 的 `keepCount`（`compact/microcompact.ts`） | 下一次局部压缩 |
| `compactionMicrocompactClearErrorResults` | `collectCompactableToolResultGroups`（`compact/microcompact.ts`） | 下一次局部压缩 |
| `compactionPostTurnEnabled` | `turn.ts` 轮末钩子 → `maybeCompactAfterTurn` | 本轮 turn 结束后 |
| `compactionPostTurnThresholdOffsetTokens` | `applyPostTurnThresholdOffset`（`compact/policy.ts`），经 `evaluateRuntimeAutoCompactDecision(..., { forPostTurn: true })` | 本轮 turn 结束后 |
| `compactionModelDownshiftEnabled` | `applySubmissionExecutionState` | 下一次切模型 |

### 3.2 局部压缩（microcompact）打开后的行为

- 触发：`estimatedTokenCount >= thresholdTokens`（默认 `min(0.9 × autoCompactThreshold, autoCompactThreshold − 2000)`），或距上次 assistant 完成超过 `idleThresholdMinutes`（默认 60，不暴露到 UI）。
- 动作：按 "assistant 起始轮" 分组工具结果，保留最近 `keepRecentToolResults` 组，其余正文替换为 `[Old tool result content cleared]`。
- 保护：含媒体（image / video / file）的工具结果永不清；已被清理过的幂等跳过；`clearErrorResults=false` 时 `isError` 结果不清。
- 最小收益：清理后节省不足 `minTokenSavings`（默认 256）时整体放弃，不改历史。
- 落事件：`MicrocompactBoundary`（`trigger` / `strategy` / `tokensSaved` / `clearedToolCallIds` 等），已在 contract 中定义。

### 3.3 轮末压缩打开后的行为

成功 turn 结束时按 §2 D8 执行；落 `CompactStarted` / `CompactBoundary` / `CompactCompleted` 时间线事件，`trigger = post_turn`、`phase = post_turn`。UI 上的表现与用户手动 `/compact` 一致（一条压缩横线 + 压缩后的会话继续），但**不产生 user bubble**（压缩由运行时发起，不是用户 query）。

### 3.4 降档提前压打开后的行为

切到更小窗口模型前压一次；落事件 `trigger = model_downshift`、`compactReason = model_downshift`。宏观看：用户从 200K 模型切到 128K 模型时，不再在切换后第一次请求就撞上 `ProviderOverflow` 响应式压缩，而是切换前把上下文收敛到新窗口内。

生效范围：只在**普通 Submission 的起始点**（`turn.ts` 调 `applySubmissionExecutionState` 时传入 `compactionContext`）执行。

不覆盖链路（有意为之，不是漏接）：mid-turn 被提升为 guide 的排队输入若自带 `modelSelection`，走 `turn-guide-drain.ts` 的 `applySubmissionExecutionState`，那里不传 `compactionContext`，因此不做降档压缩。原因是那条路径的 `state.turnRequestState.entries` 已是 loop 自己的工作副本，压缩替换 history 后必须同步刷新它并重建 context prefix，改动面覆盖 turn-loop 主干；收益仅限"轮中途换模型"这一罕见形态，其安全性由下一轮的 PreRequest 自动压缩兜底。若日后要接，必须同时解决 loop entries 同步问题，不能只传 `compactionContext`。

### 3.5 hook 面的行为变化

- `PreCompact` / `PostCompact` 的 matcher 现在可以写 `manual` / `auto` / `reactive` / `post_turn` / `model_downshift`；payload 新增 `phase` 与 `trigger`。
- `PostCompact` 失败时发射 `outcome:"failed"`（此前只有 `completed` / `skipped`）。失败路径不注入上下文（与"仅观察 + 注入"语义一致）。
- `PreCompact` 阻断时：不改历史、落 `CompactCompleted` status=`skipped`、返回 `outcome:"skipped"`、displayText 为 `Compaction blocked by PreCompact hook`（既有行为，不变）。

### 3.6 设置页（UI 规格，可直接照此施工）

新分区「上下文压缩」，位于侧栏「Agent 能力」组，排在「记忆」之后、`subagents` 之前。

- 分区 id：`contextCompaction`；图标：`Layers`；标题 i18n key：`settings.contextCompaction.title`（zh: `上下文压缩`，en: `Context compaction`）。
- 页面结构（上到下）：

1. **说明段**：一行灰色说明文案 `settings.contextCompaction.description`（zh: `控制会话上下文如何自动压缩。默认全部关闭，保持当前行为。`）。
2. **唯一一张卡片**（`SettingsGroupCard`），内部按下面的顺序放行（`SettingsRow` + 分割线）。**不再拆成多张单行卡片**：这些控件同属"上下文压缩"一个话题，多张卡片只会多出容器边框，属于无谓的视觉噪音（Steve Krug：不要让用户费脑子）。
   1. **安全余量**（`data-testid="compaction-buffer-tokens-input"`）
      - 标题 `安全余量`（key `settings.contextCompaction.buffer.label`）。
      - 控件：数字输入（`Input`，`type="number"`，`inputMode="numeric"`，`min=1`，`max=100`，`step=1`，右对齐、宽 `w-20`）+ 后缀 `K`；右侧附「恢复默认」文字按钮（key `...buffer.reset`，已在默认态时禁用），点击写 `null`。输入为空 = `null`（不覆盖）。
      - 输入单位是**千 tokens**，落库是 tokens（K × 1000）：`1` → 1000，`100` → 100000。
      - 行内只读信息（key `...buffer.info`）：`当前模型：窗口 {window}K → 阈值 {threshold}K（约 {percent}%）`——窗口与阈值按 core 同款公式算出（`窗口 − min(maxOutputTokens, 21000) − 余量`），百分比是反算值。取不到模型窗口时只显示 `自动`（key `...buffer.infoUnknown`），不编数字。
      - 交互：失焦或回车提交；非法值（<1 / >100 / 非整数）不提交并在行内显示 key `settings.contextCompaction.bufferInvalid`（zh:「请输入 1–100 之间的整数（单位：千 tokens）。」）。
   2. **局部压缩**
      - `Switch`：`局部压缩`，副标题 `清理较早的工具结果正文，只保留最近若干条，降低上下文占用。`
      - 展开区（`Collapsible`，仅 `compactionMicrocompactEnabled === true` 时可见）：
        - 若余量为 `null`（阈值为自动），先显示一条提示 `局部压缩的触发点跟随自动压缩阈值。`
        - 数字输入：`保留最近工具结果组数`（`data-testid="compaction-keep-recent-input"`），`min=1`，`max=50`，默认 `5`；非法值行内报错 `settings.contextCompaction.keepRecentInvalid`。
        - `Switch`：`同时清理失败的工具结果`，默认关。
   3. **轮末压缩**
      - `Switch`：`轮末压缩`（`data-testid="compaction-post-turn-switch"`），副标题 key `settings.contextCompaction.postTurn.description`（zh:「达到轮末压缩阈值时，在本轮回答结束后立刻压好，不必等下一次提问前才压。阈值默认与自动压缩相同，可在下方提前。」）。
      - 展开区（`Collapsible`，仅 `compactionPostTurnEnabled === true` 时可见），展开后是**一行**：
        - 标题 `提前量`（key `settings.contextCompaction.postTurn.offsetLabel`，en: `Advance by`）；说明 key `...offsetDescription`（zh:「以千 tokens 为单位。0 表示与自动压缩阈值相同；填 3 表示比自动阈值早 3000 tokens 触发。」）。
        - 控件：数字输入（`data-testid="compaction-post-turn-offset-input"`，`type="number"`，`inputMode="numeric"`，`min=0`，`max=100`，`step=1`，右对齐、宽 `w-20`）+ 后缀 `K`。失焦或回车提交。
        - 提前量 > 0 且拿得到模型窗口时，额外显示生效值（key `...offsetEffective`）：`轮末阈值约为 {threshold}K（窗口的 {percent}%）`，其中 `threshold = max(1, 自动阈值 − 提前量)`。窗口未知则不显示这行。
        - 非法值行内报错 key `settings.contextCompaction.postTurnOffsetInvalid`（zh:「请输入 0–100 之间的整数（单位：千 tokens）。」）。空串按非法处理（提前量没有"自动"态，0 即默认）。
   4. **模型降档提前压**：`Switch`，副标题 `切换到上下文窗口更小的模型前先压缩，避免切换后首次请求超窗。`
3. **写入中**（`saving`）时卡片内所有控件禁用（含两个数字输入），避免并发提交互相覆盖。
4. 开关切换后立即生效（无需重启），不出现"需重启"提示。

- 三个开关默认关；余量默认 `null`；提前量默认 `0`；保留组数默认 `5`；`clearErrorResults` 默认关。
- 空 / 加载 / 失败态：沿用设置页既有骨架（`settings.loading` 时该分区显示骨架行；写失败时用设置页既有错误提示通道，文案 `settings.contextCompaction.saveFailed`）。
- i18n：所有 key 同时落 `packages/ui/src/i18n/locales/zh-CN.ts` 与 `en-US.ts`。
- 验收路径（手动）：打开设置 → 上下文压缩 → 依次操作七个控件 → 关闭设置 → 新建会话发一轮 → 观察 `compact.*` 日志与时间线横线符合预期。

## 4. 所有权与不变式

**所有权**

| 事实 | 唯一所有者 | 存储 |
| --- | --- | --- |
| 用户偏好（设置页） | `ISettingService` | `{dataRoot}/v2/setting.json` |
| workspace 级生效偏好 | bootstrap `context.appRuntimePreferences.compaction` | 进程内存 |
| 会话运行态策略 | `AgentRuntime.updateCompactionPolicy()` | `runtime.config.compact` |
| CLI 文件级默认 | `adapters` ConfigStore（`ConfigKey.Compact`） | `{dataRoot}/cli/config.json` |

事件顺序（即时生效）：

```
UI 切换 → settingService.update → useSettingService 同步门 → zcodeAgentService/botsService
        → client.request workspace/updateCompactionPreferences
        → bootstrap handler: 写 appRuntimePreferences.compaction
                            + 刷新 record.compaction（inherit 子会话据此继承）
                            + 遍历 session 调 app.setCompactionPolicy(policy)
                            → runtime.updateCompactionPolicy → 逐字段并入 this.config.compact
        → 下一次 turn-loop 迭代读到新策略
```

三处"枚举副本"必须与协议层字段一一对应，漏一处不会编译失败、只会**静默失效**：

- `packages/ui/src/hooks/useSettingService.ts` 的 `COMPACTION_SETTING_KEYS`（漏了就不同步热更新）；
- `packages/ui/src/Root.tsx` 的压缩偏好依赖数组（漏了广播不触发）；
- `packages/services/src/migration/domains/appSettings.ts` 的 `MIGRATABLE_SETTING_KEYS`（漏了跨身份迁移丢偏好）。

`record.compaction` 必须与 `setCompactionPolicy` 在同一个循环里刷新：`record.compaction` 是 `inherit` 分支继承子会话时读的唯一来源，只改 runtime 不改快照会让"用户改完设置后新建的子会话"拿到改之前的语义。

**不变式**

- **I1**：七个设置全部取默认值时，`AutoCompactPolicyConfig` 与改造前等价（无 `bufferTokens`、无 `postTurnThresholdOffsetTokens`、`microcompact.enabled` 非 true、无 postTurn/downshift），压缩触发点、消息切分、事件序列逐位不变。
- **I2**：设置项永不阻断压缩；只有 `PreCompact` hook 能阻断。
- **I3**：`resolveRuntimeCompactPolicyConfig` 是三个入口唯一的策略合成点，且把由模型推导的 `contextWindow` / `maxOutputTokens` / `modelContextBudgetStrategy` 放在 `...config.compact` **之后**强制覆盖。因此策略对象即使误带 `contextWindow`，也不会把模型真实窗口覆盖成配置值（协议层同样不接受该字段）。任何入口都不得自行拼装 `AutoCompactPolicyConfig`。
- **I4**：压缩对 messageHistory 的替换是原子的——所有模型调用成功后才执行 `replaceMessages`；中断/失败路径不改历史。
- **I5**：`CompactTrigger` / `CompactPhase` 的新取值必须在**所有消费端枚举副本**里同时可见。契约层（`contracts/src/compact/index.ts`）是唯一生产端，但取值会被复制成字符串枚举，共四处：legacy 时间线 zod、v4 遥测 zod（`compaction.terminal`）、services 的手写 guard（`zcodeTaskServiceAdapter.ts` 的 `timelineTriggerValue`）、以及 bootstrap 的投影映射。

  **不要指望编译器或类型穷尽守卫兜住这里**：副本是字符串字面量联合，漏改既不会编译失败，也不会在类型层面报错；`zod` 的 `.parse()` 只在**运行时**遇到新取值才抛错，表现为"该触发器的时间线/遥测整条丢失"。因此这条不变式由 `contracts/test/compact-trigger-parity.test.ts` 钉住：对每个取值逐个跑真实 schema，漏改即红。

  另外 `mapCompactMarkerOrigin` 之类的映射必须写成**总函数**（`manual` 之外一律归 `auto`），这样新取值不需要改映射也不会落进未定义分支。
- **I6**：`Auto` / `Reactive` / `PostTurn` / `ModelDownshift` 压缩后，保留段必须是 history 的后缀，且**从最后一条 assistant 回答开始**（切分按「assistant 起始轮」分组，最近一组即"最后一条回答及其之后的消息"）。这条形态保证"正在被回答的用户输入"不会被摘要掉：Auto / Reactive 在请求前压缩时 history 末尾已是本轮用户输入；降档压缩发生在追加本轮输入之前，输入尚未进 history。`Manual`（`StandaloneTurn`）与 `SessionMemory` 有意摘要全部——手动 `/compact` 若保留那条悬空用户消息，下一轮模型会把它再答一遍，与 `suppressFollowup` 冲突。这条不变式用测试钉住（`core/test/compact-selection-preservation.test.ts`），不写防御性分支。
- **I7**：设置层对 `config.compact` 的贡献**只覆盖它拥有的字段，且永不整体替换 `microcompact`**。设置页任何一次操作之后，文件段里设置页不拥有的键（`enabled`、`microcompact.thresholdTokens` / `idleThresholdMinutes` / `compactableToolNames` / `minTokenSavings`、`summaryReserveTokens` / `maxConsecutiveFailures`）必须逐位不变；`compact.enabled: false` 尤其必须活过任意次热更新。这条同时由类型（patch 类型不含 `enabled`）与合并实现（逐字段 + `microcompact` 深合并）保证，并用测试钉住（`core/test/compaction-policy-merge.test.ts`）。
- **I8**：`postTurnThresholdOffsetTokens` 缺省或为 0 时，轮末判定与改造前**逐位相同**：`applyPostTurnThresholdOffset` 必须返回**同一个 config 引用**，不得经由任何单位换算往返（百分比往返会因 `floor` 舍入差改变阈值）。由 `core/test/compaction-policy-offset.test.ts` 用引用相等（`assert.equal(result, config)`）钉住，并由 `core/test/compact-trigger-paths.test.ts` 用真实判定证明"偏移确实接进了轮末判定"（token 落在 `(自动阈值 − 提前量, 自动阈值)` 之间时，`forPostTurn: true` 会压、不传不会）。

## 5. 失败语义

| 场景 | 行为 |
| --- | --- |
| 热更新 RPC 找不到 session | 跳过该 session，其余照常；整体仍返回成功 |
| 热更新 RPC 载荷非法 | 返回 `-32602`，不改任何状态 |
| 轮末压缩失败 | `warn` 日志 `compact.post_turn.failed`，不影响已完成的 turn |
| 轮末压缩被取消（会话关闭） | 落 `CompactCompleted`/`CompactStarted` status=`interrupted`，不计入连续失败 |
| 降档压缩失败 | `warn` 日志 `compact.model_downshift.failed`，切换照常进行 |
| `PostCompact` hook 在失败时抛错 | 记 `warn`，不掩盖原始压缩错误（hook fail-open 默认） |
| 创建期偏好请求失败 | 沿用既有兼容回落，`compaction` 缺省 = 全部默认值 |

关键约束：**任何一条新路径失败都不得让主流程（turn、模型切换、会话创建）失败**。压缩是维护动作，不是业务动作。

## 6. 迁移边界

- **存量用户**：`AppSettings` 缺 `compactionBufferTokens` → 解析为 `undefined`/`null` → 默认余量 13000，行为与升级前完全一致。缺 `compactionPostTurnThresholdOffsetTokens` → schema 默认 `0` → 轮末与自动压缩阈值相同。
- **旧键 `compactionThresholdPercent` 的处置（已查证，无需迁移步骤）**：
  - `packages/shared/src/validationAppSettings.ts` 全文**没有任何 `.strict()` / `.passthrough()`**；`appSettingsObjectSchema`（约 427 行起）与 `appSettingsPatchSchema`（约 510 行起）都是裸 `z.object({...})`。zod 裸 object 对未知键的默认行为是**静默剥掉**而不是报错，因此旧持久化设置里残留的 `compactionThresholdPercent` 解析不报错、被丢弃。
  - `apps/zcode-cli/packages/adapters/src/config/schema.ts` 的 `compactSchema`（约 235 行）同样是裸 `z.object`（该文件其它对象有 `.strict()`，但 `compact` 这个子对象没有；父对象 strict 不递归管子对象的未知键）。旧 `config.json` 里 `compact.thresholdPercent` 同样被静默剥掉。
  - `resolveCompactionPreferencesFromSettings` 是**白名单映射**，旧键不可能从原始 AppSettings 泄漏进 runtime。
  - 因此**不新增迁移步骤**（那会是没人需要的死路径）。由测试把这件事钉住：`packages/shared/test/app-compaction-preferences.test.ts` 断言带旧键的输入能正常解析、键被剥掉。
  - **策略语义词**：旧的非 null `thresholdPercent` 一律**丢弃、回落自动阈值**。不尝试换算成 `bufferTokens`——换算需要"写入当时的模型窗口"，而配置里没有记录那一刻的窗口，任何换算都会编出一个用户没要求过的余量。
- **存量 CLI 配置**：无 `compact` 段 → `RuntimeConfig.compact` 为空对象 → 行为不变；有旧 `thresholdPercent` → 静默剥掉。
- `thresholdPercentOverride` 死字段删除：无任何读取者，删除不影响行为。
- `ConfigKey.FeatureCompact` / `features.compact` 保持原样（本轮不碰，避免扩大改动面），但 spec 记录它仍不控制压缩，避免后人误用。
- 跨身份迁移：`compaction*` 七个键加入 `packages/services/src/migration/domains/appSettings.ts` 的 `MIGRATABLE_SETTING_KEYS`，让"按域从另一个身份迁移数据"能带上压缩偏好。注意拆分 key 不匹配的部分（旧身份只有 `compactionThresholdPercent`）在迁移后会被 schema 静默剥掉，不影响。

## 7. 本轮不做（及理由）

| 项 | 理由 |
| --- | --- |
| 独立摘要模型 | 压缩请求走 `applyCacheControl: true, skipCacheWrite: true`，输入命中 prompt cache；换模型反而丢缓存、成本更高。用户已明确"整个以后都不做"。 |
| 外置记忆库（mem0/MemGPT 式） | ZCode 的 markdown 记忆 + 索引注入已够用，用户已定不做。 |
| 文件级分层（Gemini 的 FULL/PARTIAL/SUMMARY/EXCLUDED） | 与现有"按 assistant 轮分组"模型冲突，改动面覆盖消息切分主干，收益未验证；本轮不做，若做需先立独立 spec。 |
| 事件溯源式会话存储 | 会话存储是 message/part 可覆盖表 + 视图切片，非 append-only；改造属于存储层重构，与本方案无关。 |
| 恢复"百分比阈值"入口 | 已按 §1.1 删除：百分比在窗口变化上不可靠，且"显示值回填"不能复现自动值。若要再次引入，必须同时给出小窗口上的余量下限策略与回填一致性证明。 |
| 把 microcompact 的 `idleThresholdMinutes` 暴露到 UI | 时间触发的局部压缩难以向用户解释收益，保留内部默认。 |
| `summaryReserveTokens` / `maxConsecutiveFailures` 暴露到 UI | 前者与安全余量语义相邻、后者是失败兜底阈值，都属工程内部参数；暴露只会增加用户选择负担（Steve Krug：不要让用户费脑子）。 |

## 8. 验收

- 单元测试（`apps/zcode-cli/packages/core/test/`）：
  - `compact-policy.test.ts`：未配置余量时阈值 = `(窗口 − 输出预留) − 13000`（200K → 166000 ≈ 83%）；配置余量时阈值 = 输入侧上限 − 余量；余量大于输入侧上限时夹到 0；`shouldAutoCompact` 阈值随余量变化；`enabled:false` 优先；策略合成用模型真实窗口覆盖误带的 `contextWindow`。
  - `compaction-policy-offset.test.ts`（I8）：提前量 `undefined`/`0` → `assert.equal(result, config)`（**引用相等**）；200K 窗口自动阈值 166000 + 提前量 6000 → 160000；显式余量 20000（自动 159000）+ 提前量 6000 → 153000；越界/非法（100001、-1、2.5、NaN、±Infinity）等同未配置；提前量 100000 且自动阈值 1000 时夹到 1。
  - `compact-trigger-paths.test.ts`：开关打开且条件满足时，`maybeCompactForModelDownshift` / `maybeCompactAfterTurn` 必须以 `trigger = model_downshift` / `post_turn` 真的调用 `compactActiveConversation`；窗口未变小、有排队输入、开关为 false 时不得调用；轮末压缩抛错不冒泡。**偏移真的接进判定**：token 落在 `(94000−6000, 94000)` 时 `forPostTurn:true` 压、不传不压；低于 88000 时传了也不压；提前量 0 时两种判定阈位相同。
  - microcompact：`keepRecentToolResults`、`clearErrorResults` 生效且媒体结果受保护。
  - `defaultCompactPhaseForTrigger` / `defaultCompactReasonForTrigger` 对新触发器穷尽。
  - 保留段（I6）：`Auto` / `Reactive` / `PostTurn` / `ModelDownshift` 的 `selectCompactEntries` 结果是非空后缀且首条为 assistant；收尾为用户输入的 history 里，最后一条用户输入必在保留段内；`Manual` / `SessionMemory` 保留段为空。
  - 叠加语义（I7，`compaction-policy-merge.test.ts`）：文件段 `microcompact = {enabled:true, thresholdTokens:1234}` + 会话级 patch 只含 `postTurnEnabled`（或只含 `microcompact.keepRecentToolResults`）→ 合并后 `thresholdTokens` 仍是 1234、`enabled` 仍是 true；`bufferTokens: null` 显式清除；`bufferTokens`/`postTurnThresholdOffsetTokens` 的 `undefined` = 不修改；`compact.enabled:false` 活过任意次热更新。
  - 两个 mapper 的稀疏性（`bootstrap/test/compaction-policy.test.ts`）：全默认偏好 → `compactionPreferencesToPolicyOverride()` 返回 `{}`；`bufferTokens: null` 与提前量 0 时 override 结果**不含该键**（而不是含 `undefined`）；热更新用的全量 mapper 反之始终七项 present；两者都不产出 `contextWindow` / `maxOutputTokens`。
- 契约测试：`compactTimelinePayload` / `compactBoundaryPayload` 接受新 `trigger` / `phase`；hook 输入接受新 `compactTrigger`。
- shared 契约（`packages/shared/test/app-compaction-preferences.test.ts`）：`AppSettings` 七项默认值为「维持现状」（含 `compactionBufferTokens ?? null === null`、提前量 0）；余量只接受 1000–100000 整数或 `null`；提前量只接受 0–100000 整数；patch 里 `null` 表示"恢复默认余量"、缺席表示"不修改"；协议 schema `.strict()` 拒绝 `contextWindow` 且缺项即失败；旧键 `compactionThresholdPercent` 能正常解析且被静默剥掉（迁移结论的钉子）。
- 文件通道可达性（**不能只断言 schema 能解析**，`adapters/test/config-compact-channel.test.ts`）：含 `compact.bufferTokens` / `compact.postTurnThresholdOffsetTokens` / `compact.microcompact.thresholdTokens` 的配置文件经 schema → `ConfigStore.getAll()` 真实路径后，`RuntimeConfig.compact` 里这些值必须还在——通道断在 `config-merger.ts` 或 `index.ts` 上时 schema 照样绿。越界的余量/提前量必须被 schema 拒绝。
- UI 解析契约（`packages/ui/test/contextCompactionSettings.test.ts`）：安全余量输入空串 = 不覆盖、1–100 整数 K = 显式余量、越界/小数/非数字非法；提前量 0–100 整数 K 有效、空串非法；`resolveAutoThresholdTokens(200_000, null) === 166_000`、`resolveThresholdPercent(200_000, 166_000) === 83`；窗口未知返回 `null`。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm typecheck:cli`、受影响的 `node --import tsx --test` 套件全绿。
- 端到端（手工，需真机验证并记录证据）：设置页操作 → 新会话 → 观察 `compact.micro.applied` / `compact.auto.skipped` / `compact.post_turn.*` 日志与压缩时间线横线；把提前量设为 6 后，轮末压缩应在自动阈值 − 6000 处提前触发。
