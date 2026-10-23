// ============================================================
// context-compaction 对外契约：上下文压缩控制的完整链路（设置 → 协议偏好 → 运行态策略 → 触发点）
// ============================================================
// 意图：给压缩链路一套**可配置的控制面**——安全余量、局部压缩（microcompact）、轮末压缩、模型降档
// 提前压，以及压缩摘要正文的只读读端。链路是单向的：设置页是用户偏好的事实源，偏好经协议下发到
// workspace 级与每个 session 的运行态策略，运行态的判定与执行全部在 core 内完成。
//
// 调用方必须知道的不变量（完整设计见 `core/spec/context-compaction-controls.md`）：
//
// 1. **I1 默认即等价**：七项设置全部取默认值时，运行态策略与改造前逐位等价，压缩触发点、消息切分、
//    事件序列都不变。
// 2. **I2 设置项永不阻断压缩**：只有 `PreCompact` hook 能阻断；任何新路径的失败都不得让主流程
//    （turn、模型切换、会话创建）失败——压缩是维护动作，不是业务动作。
// 3. **I3 合成的唯一入口**：`resolveRuntimeCompactPolicyConfig`（`core/src/runtime/methods/`）是
//    局部压缩 / 自动压缩 / 降档提前压三个入口唯一的策略合成点，且把由模型推导的 `contextWindow` /
//    `maxOutputTokens` / `modelContextBudgetStrategy` 放在 `...config.compact` **之后**强制覆盖。
// 4. **I7 逐字段覆盖而非整份替换**：设置层只写自己拥有的字段，永不整体替换 `microcompact`；
//    `compact.enabled: false` 必须活过任意次热更新。
// 5. **I8 偏移缺省即逐位相同**：`postTurnThresholdOffsetTokens` 缺省或为 0 时，轮末判定与改造前
//    完全相同（`applyPostTurnThresholdOffset` 必须返回**同一个 config 引用**，不得经任何单位换算）。
// 6. **读写分离**：摘要正文按 `sessionId + messageId` 懒加载，授权在 CLI 宿主侧（只认
//    `compact_summary` 消息）；UI 缓存只收成功结果，失败不缓存、重试就是重读。
//
// 所有权：用户偏好 `AppSettings`（`ISettingService` 唯一写）；workspace 级生效偏好
// `context.appRuntimePreferences.compaction`（bootstrap preferences handler 唯一写）；会话运行态
// `runtime.config.compact`（`updateCompactionPolicy` 与创建期唯一写）；文件级默认由 CLI 配置段拥有。

// ---- 1. 偏好归一：设置七项 → 协议偏好（越界/非法一律回落「维持现状」） ----
export { resolveCompactionPreferencesFromSettings } from "@zcode/shared";
export type { AppCompactionSettings } from "@zcode/shared";
export {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  zcodeCompactionPreferencesSchema,
} from "@zcode/shared";
export type { ZCodeCompactionPreferences } from "@zcode/shared";

// ---- 2. 协议偏好 → 运行态策略：两个语义不同的产物，禁止互相替代 ----
// 创建期（稀疏，只表达偏离默认的字段）与热更新期（七项全量）必须分开：创建期靠**省略键**让 CLI
// 文件段存活，热更新期靠全量下发让用户能「关掉刚打开的东西」。
export {
  compactionPreferencesToPolicy,
  compactionPreferencesToPolicyOverride,
} from "../compaction-policy.js";
export type { AgentRuntimeCompactionPolicyOverride } from "../compaction-policy.js";
export type { AgentRuntimeCompactionPolicyPatch } from "@zcode/core";

// ---- 3. 热更新下发：workspace 偏好 + session 快照 + 逐个会话热更新 ----
// 快照必须与热更新在同一循环里刷新：`record.compaction` 是 `inherit` 子会话继承偏好的唯一来源。
export { updateCompactionPreferences } from "../zcode-protocol/compaction-preferences.js";

// ---- 4. 阈值与判定：公式只有一份，偏移缺省时逐位不变 ----
// 运行时侧的策略合成（`resolveRuntimeCompactPolicyConfig` / `resolveLocalMicrocompactConfig`）、
// 判定（`evaluateRuntimeAutoCompactDecision`）与触发点执行（`maybeCompactAfterTurn` /
// `maybeCompactForModelDownshift`）位于 `core/src/runtime/methods/`，只由 core 运行时内部调用，
// 不跨包 import；这里只固定它们共用的公开公式与偏移语义。
export {
  applyPostTurnThresholdOffset,
  getAutoCompactThreshold,
  shouldAutoCompact,
} from "@zcode/core";
export type {
  AutoCompactDecision,
  AutoCompactPolicyConfig,
  LocalMicrocompactPolicyConfig,
} from "@zcode/core";

// ---- 5. 摘要正文读端：按 ref 懒加载，空串是合法结果 ----
export {
  v4ConversationCompactionSummaryParamsSchema,
  v4ConversationCompactionSummaryResultSchema,
} from "@zcode/shared/zcode-protocol-v4";
export type {
  V4ConversationCompactionSummaryParams,
  V4ConversationCompactionSummaryResult,
} from "@zcode/shared/zcode-protocol-v4";
