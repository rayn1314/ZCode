# 上下文压缩控制（Context Compaction Controls）

主责包：`apps/zcode-cli/packages/core`。

涉及的其他包：

- `apps/zcode-cli/packages/contracts`：`CompactTrigger` / `CompactPhase` 枚举、hook 输入契约。
- `apps/zcode-cli/packages/adapters`：CLI 配置文件 `compact` 段与 `ConfigKey.Compact`。
- `apps/zcode-cli/packages/bootstrap`：会话创建期注入、workspace 级热更新 RPC、策略映射。
- `packages/shared`：`zcode-protocol` 的偏好 schema 与广播载荷、`validationAppSettings` 的开关字段。
- `packages/services`：本地/远端 `resolveSessionRuntimePreferences` 应答、`zcodeAgentService` 的偏好同步分发。
- `packages/ui`：设置页「上下文压缩」分区。

---

## 1. 背景与问题

ZCode 的压缩链路本身是完整的：手动 `/compact`（`StandaloneTurn`）、自动压缩（`Auto`，覆盖 `PreRequest` 与 `MidTurn`）、溢出后的响应式压缩（`Reactive`），以及一套已写完但**从未运行过**的局部压缩（microcompact，清理旧工具结果）。

问题出在配置面上——今天这四条路径**没有任何配置入口**：

1. `AgentRuntimeConfig.compact`（`apps/zcode-cli/packages/core/src/runtime/types.ts:136`）全仓没有任何写入者，唯一来源是 `resolveAppRuntimeConfig` 里 `...options.runtimeConfig` 的透传（`bootstrap/src/app/runtime-config.ts:119`），而没有任何调用方设置 `options.runtimeConfig.compact`。
2. `AutoCompactPolicyConfig.thresholdPercentOverride`（`core/src/compact/policy.ts:23`）是死字段：只有声明，无人读写（`shouldAutoCompact` 里 `thresholdPercent` 恒为 100 且只用于回填决策日志）。
3. microcompact 的门是 `config.microcompact?.enabled === true`（`core/src/runtime/methods/microcompact.ts:105-116` 的 `resolveLocalMicrocompactConfig`），同样无人写入 → **microcompact 恒关**。
4. `ConfigKey.FeatureCompact`（`features.compact`）只有 `adapters` 自己读写，`features.compact:false` 不会关掉任何压缩路径（真正生效的是 `config.compact.enabled === false`）。

同时，最近的 hook 地基改造（P0–P4）把 `PreCompact`（可阻断）/`PostCompact`（可注入）/`PreModelSwitch` 接通到了运行时，暴露两个缺口：

- `PostCompactHookInput.outcome` 契约允许 `"completed" | "skipped" | "failed"`（`contracts/src/hooks/index.ts:168`），但运行时**从不发射 `"failed"`**：失败走 `compact-active.ts:691-739` 的 catch，直接落 timeline 失败事件后抛错。
- `PreCompactHookInput.compactTrigger` / `PostCompactHookInput.compactTrigger` 是硬编码联合 `"manual" | "auto" | "reactive"`，既无法表达新的触发来源，也拿不到 `phase`，用户写 hook 时无法区分"为什么压"。

行业对标（Codex 的轮末压缩与模型降档提前压、Gemini 的阈值 50%、Continue 的 ≈88.4%、SWE-agent 的"只保留最近 N 条观察"）说明：**阈值可调、轮末压缩、降档提前压、工具结果局部清理是低成本高收益的控制点**；而"独立摘要模型""外置记忆库""文件级分层"三项经评估收益低或与既有实现冲突，本轮及以后都不做（见 §7）。

## 2. 设计决策

### D1. 六个控件，默认全部"维持现状"

| # | 设置项 | 类型 | 默认 | 语义 |
| --- | --- | --- | --- | --- |
| 1 | `compactionThresholdPercent` | `number \| null` | `null`（自动） | 自动压缩阈值占模型上下文窗口的百分比 |
| 2 | `compactionMicrocompactEnabled` | `boolean` | `false` | 局部压缩：清理旧工具结果正文 |
| 3 | `compactionMicrocompactKeepRecentToolResults` | `number` | `5` | 局部压缩保留最近多少组工具结果 |
| 4 | `compactionMicrocompactClearErrorResults` | `boolean` | `false` | 局部压缩是否连失败的（isError）工具结果一起清 |
| 5 | `compactionPostTurnEnabled` | `boolean` | `false` | 轮末压缩：一轮成功后主动压，而非等下一次请求前 |
| 6 | `compactionModelDownshiftEnabled` | `boolean` | `false` | 模型降档提前压：切到更小窗口模型前先压 |

"默认维持现状"是硬约束：不显式打开任何开关时，压缩行为必须与改造前逐位一致（见 §4 I1）。

### D2. 开关是产品级，hook 是叠加层

- 设置项只表达"要不要启用某条产品路径"，**永不阻断**压缩。
- hook（`PreCompact`）是用户叠加的裁决层，**可以阻断**；但 hook **不能强制**触发压缩。
- 两者语义独立：设置项在 hook 之外决定"是否走到 hook"，hook 在设置项放行之后决定"是否放行"。

### D3. 即时生效

压缩策略在每次 turn-loop 迭代被重新读取（`microcompactIfNeeded` / `autoCompactIfNeeded` 每次都从 `this.config.compact` 现算 `AutoCompactPolicyConfig`），因此**只要热更新 `runtime.config.compact`，下一次迭代即生效**，不需要重启会话。

新增 workspace 级协议方法 `workspace/updateCompactionPreferences`（载荷为六项设置），落点：

1. 写入进程级 `context.appRuntimePreferences.compaction`（供之后创建/恢复的会话使用）；
2. **逐个已存在 session 调用 `record.app.setCompactionPolicy(policy)`** 热更新。

模式完全对齐既有的 `workspace/updateModelIoPreferences`（`bootstrap/src/zcode-protocol/model-io-preferences.ts:14-21`）。

### D4. 创建期通道

`session/requestRuntimePreferences` 的结果新增 `compaction` 对象，`resolveSessionStartupPreferences` → `createRecord` 把它写进 `runtimeConfig.compact`。这样新会话与恢复会话在起始态就带上用户的设置。

### D5. CLI 文件通道

`ZCodeConfigFileSchema` 新增 `compact` 段，经 `RuntimeConfigPatch.compact` → `ConfigKey.Compact` → `RuntimeConfig.compact`，最后由 `resolveAppRuntimeConfig` 显式合并进 `AgentRuntimeConfig.compact`。合并顺序：`configResult.config.compact` 在前、`options.runtimeConfig?.compact` 在后（会话级覆盖文件级）。模式对齐 `modelAnomalyGuard`。

这一条保证纯 CLI / headless 用户（没有设置页）也能配置。

### D6. 单一映射函数

`ZCodeCompactionPreferences`（协议层六项）→ `AutoCompactPolicyConfig`（core 层）的映射只在 bootstrap 写一份 `compactionPreferencesToPolicy()`，创建期与热更新期共用，避免两套语义漂移。

### D7. 阈值采用"可选覆盖"，不改默认

- 不设 `thresholdPercent`：沿用现有公式 `threshold = (contextWindow − outputReserve) − buffer`，`outputReserve = min(maxOutputTokens, 21000)`、`buffer = 13000`。
- 设了 `thresholdPercent = p`：`threshold = clamp(floor(contextWindow × p / 100), 1, effectiveContextWindow)`。

即：**未显式配置的用户阈值一分不动**（200K 窗口仍是 166K ≈ 83%），避免了"给所有模型钉一个固定百分比"带来的静默行为变更（128K 窗口按公式是 94K ≈ 73%，按 83% 会变成 106K，属于静默提前压缩）。

`thresholdPercentOverride` 死字段删除，正式命名 `thresholdPercent`。

### D8. 轮末压缩：turn 成功后内联执行，不新建调度器

位置：`turn.ts` 中 `TurnComplete` 事件与 usage 事实**已发射之后**、`return result` 之前。

- 触发条件（全部满足才执行）：`config.compact?.postTurnEnabled === true`、本轮 turn 成功、`shouldAutoCompact` 判定需要压、**当前 active turn 队列无排队输入**。
- "队列无排队输入"这条短路是为了避免在用户马上要发下一轮时多做一次无谓压缩——那种情况下一轮的 `PreRequest` 会自动压，且用户能立刻看到新轮开始。
- 复用 `compactActiveConversation`，`trigger = PostTurn`、`phase = PostTurn`、`compactReason = ContextLimit`、`model = loopState.model`。
- 失败只记 `warn` 日志，**不改变已完成 turn 的结果**（turn 已经成功，压缩是后续维护动作）。

代价与收益说明（写在这里以免日后误判为缺陷）：它只在阈值**已经达到**时才跑，也就是说这份工作在下一轮 `PreRequest` 阶段本来也要做；把时机从"用户发出下一条消息之后"挪到"用户正在读上一条回答时"，用户感知的等待更短，同时消除了下一轮在 `MidTurn` 阶段被压缩打断的风险。代价是这段时间 runtime 仍持有 active turn，新输入会先排队。

### D9. 降档压缩：在 PreModelSwitch 注入之前

位置：`turn-model.ts` 的 `applySubmissionExecutionState` 内，`setSessionModelSelection` + `persistRuntimeModelSelection` 之后、`emitModelSelected` **之前**。

顺序理由：`PreModelSwitch` hook 的注入上下文会写进 messageHistory 末尾（`hooks.ts:425`），而压缩会整体替换 messageHistory 并只保留 context prefix + summary + 最后一组轮次（`helpers/compact.ts:72-88`）。如果压缩发生在注入之后，注入内容会被吞掉。所以顺序必须是：

```
解析新模型 → setSessionModelSelection → 【降档检测 → 压缩】 → PreModelSwitch（注入） → ModelSelected 事件 → PostModelSwitch
```

触发条件：`config.compact?.modelDownshiftEnabled === true`，且新旧模型 `contextWindow` 相比**变小**（严格 `<`），且 `shouldAutoCompact` 判定需要压。

失败不阻断切换（记 `warn` 后退化到"切换后由 Reactive 压缩兜底"）。

### D10. 契约扩展

- `CompactTrigger` 新增 `PostTurn: "post_turn"`、`ModelDownshift: "model_downshift"`。
- `CompactPhase` 新增 `PostTurn: "post_turn"`。
- `PreCompactHookInput` / `PostCompactHookInput` 的 `compactTrigger` 改为 `CompactTrigger` 类型（不再硬编码三元联合），并新增可选 `phase?: CompactPhase`、`trigger?: CompactTrigger`（`compactTrigger` 保留为兼容别名，与 `trigger` 同值）。
- `PostCompact` 在失败路径发射 `outcome: "failed"`。

以上枚举都进 `contracts/src/compact/index.ts` 的 zod enum（`compactTimelinePayload` 与 `compactBoundaryPayload` 两处），漏改会被既有 schema 拒绝并冒泡成事件落库失败。

### D11. 保持"零重复写入路径"

一个值只有一个写入者：

- workspace 级事实源：`context.appRuntimePreferences.compaction`（bootstrap preferences handler 唯一写）。
- 会话级运行态：`AgentRuntimeConfig.compact`，只由 `runtime.updateCompactionPolicy()` 与创建期初始化写。
- 持久化的用户偏好：`AppSettings`（`settingService` 唯一写），是 UI 的事实源；它通过 preferences RPC 单向下发，不回读运行态。

## 3. 行为

### 3.1 六个设置的生效点

| 设置项 | 生效点 | 生效时机 |
| --- | --- | --- |
| `compactionThresholdPercent` | `getAutoCompactThreshold`（`compact/policy.ts:84`） | 下一次 turn-loop 迭代 |
| `compactionMicrocompactEnabled` | `resolveLocalMicrocompactConfig`（`runtime/methods/microcompact.ts:105`） | 下一次 turn-loop 迭代 |
| `compactionMicrocompactKeepRecentToolResults` | `maybeLocalMicrocompactMessages` 的 `keepCount`（`compact/microcompact.ts:123`） | 下一次局部压缩 |
| `compactionMicrocompactClearErrorResults` | `collectCompactableToolResultGroups`（`compact/microcompact.ts:205`） | 下一次局部压缩 |
| `compactionPostTurnEnabled` | `turn.ts` 轮末钩子 | 本轮 turn 结束后 |
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

### 3.5 hook 面的行为变化

- `PreCompact` / `PostCompact` 的 matcher 现在可以写 `manual` / `auto` / `reactive` / `post_turn` / `model_downshift`；payload 新增 `phase` 与 `trigger`。
- `PostCompact` 失败时发射 `outcome:"failed"`（此前只有 `completed` / `skipped`）。失败路径不注入上下文（与"仅观察 + 注入"语义一致：需要在失败时也能注入的 hook 会拿到 `outcome:"failed"`，此时仍走注入分支）。
- `PreCompact` 阻断时：不改历史、落 `CompactCompleted` status=`skipped`、返回 `outcome:"skipped"`、displayText 为 `Compaction blocked by PreCompact hook`（既有行为，不变）。

### 3.6 设置页（UI 规格，可直接照此施工）

新分区「上下文压缩」，位于侧栏「Agent 能力」组，排在「记忆」之后、`subagents` 之前。

- 分区 id：`contextCompaction`；图标：`Layers`；标题 i18n key：`settings.contextCompaction.title`（zh: `上下文压缩`，en: `Context compaction`）。
- 页面结构（上到下）：

1. **说明段**：一行灰色说明文案 `settings.contextCompaction.description`（zh: `控制会话上下文如何自动压缩。默认全部关闭，保持当前行为。`）。
2. **卡片「自动压缩阈值」**（`SettingsGroupCard`）
   - `SettingsRow`：标题 `自动压缩阈值`，副标题展示当前生效值：当阈值为自动时显示 `自动（当前模型约 XX%）`，XX 由当前模型的真实窗口算出；显式设置时显示 `窗口的 XX%`。
   - 控件：数字输入（`Input`，`type="number"`，`min=1`，`max=100`，`step=1`）+ 后缀 `%`；右侧附「恢复自动」文字按钮，点击写 `null`。输入为空视为 `null`。
   - 交互：失焦或回车提交；非法值（<1 或 >100 或非整数）不提交并在行内显示错误文案 `settings.contextCompaction.thresholdInvalid`。
   - 禁用态：无（该值对任何模型都适用）。
3. **卡片「局部压缩」**
   - `SettingsRow` + `Switch`：`局部压缩`，副标题 `清理较早的工具结果正文，只保留最近若干条，降低上下文占用。`
   - 展开区（仅 `compactionMicrocompactEnabled === true` 时可见，用主题化的可折叠区域）：
     - `SettingsRow` + 数字输入：`保留最近工具结果组数`，`min=1`，`max=50`，默认 `5`。
     - `SettingsRow` + `Switch`：`同时清理失败的工具结果`，默认关。
4. **卡片「轮末压缩」**
   - `SettingsRow` + `Switch`：`轮末压缩`，副标题 `一轮回答结束后就主动压缩，而不是等下一次提问前才压。`
5. **卡片「模型降档提前压」**
   - `SettingsRow` + `Switch`：`模型降档提前压`，副标题 `切换到上下文窗口更小的模型前先压缩，避免切换后首次请求超窗。`
6. **依赖与提示**：
   - 若 `compactionMicrocompactEnabled === true` 而「自动压缩阈值」为自动，在局部压缩卡片内显示一条 info 提示：`局部压缩的触发点跟随自动压缩阈值。`
   - 开关卡片的开关切换后立即生效（无需重启），不出现"需重启"提示。

- 三个开关默认关；数字默认 `null` / `5`；`clearErrorResults` 默认关。
- 空 / 加载 / 失败态：沿用设置页既有骨架（`settings.loading` 时该分区显示骨架行；写失败时用设置页既有错误提示通道，文案 `settings.contextCompaction.saveFailed`）。
- i18n：所有 key 同时落 `packages/ui/src/i18n/locales/zh-CN.ts` 与 `en-US.ts`。
- 验收路径（手动）：打开设置 → 上下文压缩 → 依次切换四个主控件 → 关闭设置 → 新建会话发一轮 → 观察 `compact.*` 日志与时间线横线符合预期。

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
                            + 遍历 session 调 app.setCompactionPolicy(policy)
                            → runtime.updateCompactionPolicy → this.config.compact = policy
        → 下一次 turn-loop 迭代读到新策略
```

**不变式**

- **I1**：六个设置全部取默认值时，`AutoCompactPolicyConfig` 与改造前等价（无 `thresholdPercent`、`microcompact.enabled` 非 true、无 postTurn/downshift），压缩触发点、消息切分、事件序列逐位不变。
- **I2**：设置项永不阻断压缩；只有 `PreCompact` hook 能阻断。
- **I3**：`resolveRuntimeCompactPolicyConfig` 是三个入口唯一的策略合成点，且把由模型推导的 `contextWindow` / `maxOutputTokens` / `modelContextBudgetStrategy` 放在 `...config.compact` **之后**强制覆盖。因此策略对象即使误带 `contextWindow`，也不会把模型真实窗口覆盖成配置值（协议层同样不接受该字段）。任何入口都不得自行拼装 `AutoCompactPolicyConfig`。
- **I4**：压缩对 messageHistory 的替换是原子的——所有模型调用成功后才执行 `replaceMessages`（`compact-active.ts:676`）；中断/失败路径不改历史。
- **I5**：`CompactTrigger` 的新取值必须在 contract zod enum、hook 输入类型、matcher 匹配值三处同时可见；任一处漏改会被类型穷尽守卫或 schema 拒绝捕获。
- **I6**：`Auto` / `Reactive` / `PostTurn` / `ModelDownshift` 压缩后，**最后一条真实用户消息仍须留在 `preservedEntries` 后缀里**（`metadata.source === "real_user"`）。它由 `shouldPreserveRecent`（`runtime/helpers/compact-selection.ts`）保证：这些触发器下至少保留最近一组轮次。`Manual`（`StandaloneTurn`）与 `SessionMemory` 有意摘要全部——手动 `/compact` 若保留那条悬空用户消息，下一轮模型会把它再答一遍，与 `suppressFollowup` 语义冲突。这条不变式用测试钉住，不写防御性分支。

## 5. 失败语义

| 场景 | 行为 |
| --- | --- |
| 热更新 RPC 找不到 session | 跳过该 session，其余照常；整体仍返回成功 |
| 热更新 RPC 载荷非法 | 返回 `-32602`，不改任何状态 |
| 轮末压缩失败 | `warn` 日志 `compact.post_turn.failed`，不影响已完成的 turn |
| 轮末压缩被取消（会话关闭） | 落 `CompactCompleted`/`CompactStarted` status=`interrupted`，不计入连续失败 |
| 降档压缩失败 | `warn` 日志 `compact.model_downshift.failed`，切换照常进行 |
| `PostCompact` hook 在失败时抛错 | 记 `warn`，不掩盖原始压缩错误（hook fail-open 默认） |
| 创建期偏好请求失败 | 沿用既有兼容回落（`server-operations.ts:3216-3228`），`compaction` 缺省 = 全部默认值 |

关键约束：**任何一条新路径失败都不得让主流程（turn、模型切换、会话创建）失败**。压缩是维护动作，不是业务动作。

## 6. 迁移边界

- 存量用户：`AppSettings` 缺字段 → 走 schema 默认（阈值 `null`、microcompact 关、轮末关、降档关），行为与升级前完全一致。
- 存量 CLI 配置：无 `compact` 段 → `RuntimeConfig.compact` 为空对象 → `this.config.compact` 仅含 `enabled` 缺省，行为不变。
- `thresholdPercentOverride` 死字段删除：无任何读取者，删除不影响行为。
- `ConfigKey.FeatureCompact` / `features.compact` 保持原样（本轮不碰，避免扩大改动面），但 spec 记录它仍不控制压缩，避免后人误用。
- 跨身份迁移：`compaction*` 六个键加入 `packages/services/src/migration/domains/appSettings.ts` 的 `MIGRATABLE_SETTING_KEYS`，让"按域从另一个身份迁移数据"能带上压缩偏好。

## 7. 本轮不做（及理由）

| 项 | 理由 |
| --- | --- |
| 独立摘要模型 | 压缩请求走 `applyCacheControl: true, skipCacheWrite: true`（`compact-active-helpers.ts:80-91`），输入命中 prompt cache；换模型反而丢缓存、成本更高。用户已明确"整个以后都不做"。 |
| 外置记忆库（mem0/MemGPT 式） | ZCode 的 markdown 记忆 + 索引注入已够用，用户已定不做。 |
| 文件级分层（Gemini 的 FULL/PARTIAL/SUMMARY/EXCLUDED） | 与现有"按 assistant 轮分组"模型冲突，改动面覆盖消息切分主干，收益未验证；本轮不做，若做需先立独立 spec。 |
| 事件溯源式会话存储 | 会话存储是 message/part 可覆盖表 + 视图切片，非 append-only；改造属于存储层重构，与本方案无关。 |
| `bufferTokens` / `outputReserve` 暴露到设置页 | 与阈值百分比语义重叠；多一个旋钮只会让用户困惑（Steve Krug：不要让用户费脑子）。 |
| 把 microcompact 的 `idleThresholdMinutes` 暴露到 UI | 时间触发的局部压缩难以向用户解释收益，保留内部默认。 |

## 8. 验收

- 单元测试（`apps/zcode-cli/packages/core/test/`）：
  - `thresholdPercent`：`null` 时阈值等于公式值；设为 `80` 时 `floor(window × 0.8)`；越界夹紧。
  - `shouldAutoCompact`：`post_turn` / `model_downshift` trigger 不影响阈值判定。
  - microcompact：`keepRecentToolResults`、`clearErrorResults` 生效且媒体结果受保护。
  - `defaultCompactPhaseForTrigger` / `defaultCompactReasonForTrigger` 对新触发器穷尽。
  - 用户消息保真（I6）：`Auto` / `Reactive` / `PostTurn` / `ModelDownshift` 的 `selectCompactEntries` 结果中，最后一条真实用户消息落在 `preservedEntries` 内。
- 契约测试：`compactTimelinePayload` / `compactBoundaryPayload` 接受新 `trigger` / `phase`；hook 输入接受新 `compactTrigger`。
- 门禁：`pnpm typecheck`、`pnpm lint`、`pnpm typecheck:cli`、两处 `node --import tsx --test` 全绿。
- 端到端（手工，需真机验证并记录证据）：设置页切换 → 新会话 → 观察 `compact.micro.applied` / `compact.auto.skipped` / `compact.post_turn.*` 日志与压缩时间线横线。
