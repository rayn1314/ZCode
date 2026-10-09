import { DEFAULT_ZCODE_MODEL_CONTEXT_BUDGET_STRATEGY as DEFAULT_BUDGET_STRATEGY } from "@zcode/shared";
import type { CompactModelMessage } from "./manual.js";
import { estimateMessageTokens, hasEnoughMessagesToCompact } from "./manual.js";
import type { LocalMicrocompactPolicyConfig } from "./microcompact.js";

export const DEFAULT_COMPACT_CONTEXT_WINDOW = 200_000;
// 正常请求默认输出已收敛到 32K，auto compact 必须预留同一目标；
// 否则请求预算和压缩窗口会继续按两套常量计算。
export const DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 32_000;
const PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS = 21_000;
export const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000;
export const AUTOCOMPACT_BUFFER_TOKENS = 13_000;
export const DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT = 100;
export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3;

export interface AutoCompactPolicyConfig {
  enabled?: boolean;
  contextWindow?: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy?: "legacy" | "preflight-v1";
  summaryReserveTokens?: number;
  /**
   * 自动压缩的安全余量（tokens）：阈值 = 输入侧上限 − 本值。
   * 用户调的就是这个绝对余量，而不是百分比——百分比会随模型窗口漂移（小窗口上按比例
   * 吃掉的缓冲只剩几百 token），且"显示值照抄回填"无法复现自动值。缺省 13000。
   */
  bufferTokens?: number;
  maxConsecutiveFailures?: number;
  microcompact?: LocalMicrocompactPolicyConfig;
  /** 轮末主动压缩：一轮成功后、下一次请求前就先把上下文压好。 */
  postTurnEnabled?: boolean;
  /**
   * 轮末压缩的独立阈值提前量（tokens，0–100000 整数）。
   * 轮末阈值 = max(1, 自动阈值 − 本值)；缺省/0 即与自动压缩阈值完全相同。
   * 因此改造后轮末**可以比自动压缩更早**触发——这是本字段存在的意义。
   */
  postTurnThresholdOffsetTokens?: number;
  /** 模型降档提前压：切到上下文窗口更小的模型前先压。 */
  modelDownshiftEnabled?: boolean;
}

export type AutoCompactTokenSource = "estimate" | "provider_usage";

export interface AutoCompactTokenOverride {
  baseTokenCount?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  contextUsageTokenCount?: number;
  incrementalTokenCount?: number;
  outputTokens?: number;
  source: Extract<AutoCompactTokenSource, "provider_usage">;
  tokenCount: number;
}

export interface AutoCompactDecision {
  shouldCompact: boolean;
  tokenCount: number;
  tokenSource: AutoCompactTokenSource;
  estimatedTokenCount: number;
  providerCacheReadTokens?: number;
  providerCacheWriteTokens?: number;
  providerBaseTokenCount?: number;
  providerContextUsageTokenCount?: number;
  providerIncrementalTokenCount?: number;
  providerOutputTokens?: number;
  threshold: number;
  contextWindow: number;
  effectiveContextWindow: number;
  maxOutputTokens?: number;
  modelContextBudgetStrategy: "legacy" | "preflight-v1";
  outputReserveTokens: number;
  thresholdPercent: number;
  reason:
    | "disabled"
    | "not_enough_messages"
    | "circuit_breaker"
    | "below_threshold"
    | "above_threshold";
}

export function getEffectiveContextWindowSize(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  // provider 的 context window 是 input + output 共享窗口；自动压缩只能让出输入侧，
  // 因此阈值分母必须先扣掉当前模型允许的 output token，而不是继续吃完整 contextWindow。
  const reserve = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  return Math.max(0, contextWindow - reserve);
}

export function getAutoCompactOutputReserveTokens(config: AutoCompactPolicyConfig = {}): number {
  const maxOutputTokens = positiveInt(config.maxOutputTokens);
  // 旧 legacy 分支为完整模型输出预留窗口，既过早压缩又要求远端选择；现在统一保留至多 21K。
  return Math.min(
    maxOutputTokens ?? DEFAULT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
    PREFLIGHT_AUTOCOMPACT_OUTPUT_RESERVE_TOKENS,
  );
}

export function getAutoCompactThreshold(config: AutoCompactPolicyConfig = {}): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const buffer = positiveInt(config.bufferTokens) ?? AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, effectiveContextWindow - buffer);
}

/**
 * 有效的阈值百分比（相对模型完整窗口）。
 *
 * 这是**只读展示值**：用户调的是安全余量（tokens），百分比由实际阈值反算而来，
 * 便于决策日志与设置页如实反映"当前约到窗口的几成"。
 */
export function getAutoCompactThresholdPercent(config: AutoCompactPolicyConfig = {}): number {
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  if (contextWindow <= 0) return DEFAULT_AUTOCOMPACT_THRESHOLD_PERCENT;
  return Math.min(
    100,
    Math.max(0, Math.floor((getAutoCompactThreshold(config) / contextWindow) * 100)),
  );
}

/**
 * 归一化轮末压缩的提前量：只接受 0–100000 的整数。
 * 越界（负数、>100000、非有限数）、非整数一律按"未配置"处理（返回 undefined）。
 * 与 `resolveCompactionPreferencesFromSettings` 同向的 fail-safe：宁可沿用自动压缩阈值，
 * 也不把阈值改成用户没要求过的值（不夹紧、不报错）。
 */
function normalizePostTurnThresholdOffsetTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || !Number.isInteger(value)) return undefined;
  if (value < 0 || value > 100_000) return undefined;
  return value;
}

/**
 * 轮末压缩阈值的偏移合成：轮末阈值 = max(1, 自动阈值 − offsetTokens)。
 *
 * offset 为 0 / 未配置时**原样返回入参对象**（引用相等）——这一步是硬不变式，必须保留：
 * 只要重算一次阈值就会产生与改造前的数值差（且会改写 config），破坏"offset 缺省时轮末判定
 * 逐位相同"的保证。真的要偏移时才通过抬高 `bufferTokens` 表达（阈值 = 输入侧上限 − buffer），
 * 全程只有 tokens 加减，不经过任何百分比换算。
 *
 * 夹紧到 1：提前量再大也不能把阈值压成 0 或负数（那会变成每次轮末都压）。
 */
export function applyPostTurnThresholdOffset(
  config: AutoCompactPolicyConfig,
  offsetTokens: number | undefined,
): AutoCompactPolicyConfig {
  const offset = normalizePostTurnThresholdOffsetTokens(offsetTokens);
  if (offset === undefined || offset === 0) return config; // ← 硬不变式，别省
  const targetThreshold = Math.max(1, getAutoCompactThreshold(config) - offset);
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  return { ...config, bufferTokens: Math.max(0, effectiveContextWindow - targetThreshold) };
}

export function shouldAutoCompact(input: {
  messages: readonly CompactModelMessage[];
  config?: AutoCompactPolicyConfig;
  consecutiveFailures?: number;
  tokenOverride?: AutoCompactTokenOverride;
}): AutoCompactDecision {
  const config = input.config ?? {};
  const contextWindow = positiveInt(config.contextWindow) ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const effectiveContextWindow = getEffectiveContextWindowSize(config);
  const outputReserveTokens = Math.min(getAutoCompactOutputReserveTokens(config), contextWindow);
  const threshold = getAutoCompactThreshold(config);
  const thresholdPercent = getAutoCompactThresholdPercent(config);
  const estimatedTokenCount = estimateMessageTokens(input.messages);
  const tokenCount = input.tokenOverride?.tokenCount ?? estimatedTokenCount;
  const tokenSource = input.tokenOverride?.source ?? "estimate";
  const common = {
    contextWindow,
    effectiveContextWindow,
    estimatedTokenCount,
    providerCacheReadTokens: input.tokenOverride?.cacheReadTokens,
    providerCacheWriteTokens: input.tokenOverride?.cacheWriteTokens,
    maxOutputTokens: positiveInt(config.maxOutputTokens),
    modelContextBudgetStrategy: DEFAULT_BUDGET_STRATEGY,
    outputReserveTokens,
    providerBaseTokenCount: input.tokenOverride?.baseTokenCount,
    providerContextUsageTokenCount: input.tokenOverride?.contextUsageTokenCount,
    providerIncrementalTokenCount: input.tokenOverride?.incrementalTokenCount,
    providerOutputTokens: input.tokenOverride?.outputTokens,
    threshold,
    thresholdPercent,
    tokenCount,
    tokenSource,
  } satisfies Omit<AutoCompactDecision, "reason" | "shouldCompact">;

  if (config.enabled === false) {
    return { ...common, shouldCompact: false, reason: "disabled" };
  }

  if (!hasEnoughMessagesToCompact(input.messages)) {
    return {
      ...common,
      shouldCompact: false,
      reason: "not_enough_messages",
    };
  }

  const maxFailures =
    positiveInt(config.maxConsecutiveFailures) ?? MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES;
  if ((input.consecutiveFailures ?? 0) >= maxFailures) {
    return {
      ...common,
      shouldCompact: false,
      reason: "circuit_breaker",
    };
  }

  if (tokenCount < threshold) {
    return {
      ...common,
      shouldCompact: false,
      reason: "below_threshold",
    };
  }

  return { ...common, shouldCompact: true, reason: "above_threshold" };
}

function positiveInt(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.floor(value);
}
