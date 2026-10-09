import type { ModelSelectionView } from "@zcode/services";

/**
 * 「上下文压缩」设置分区的纯计算与输入解析。
 *
 * 与 `apps/zcode-cli/packages/core/src/compact/policy.ts` 的阈值公式保持一致：
 * 阈值 = (窗口 − output reserve) − 安全余量，其中 reserve = min(maxOutputTokens, 21000)、
 * 默认余量 = 13000。core 与 ui 分属两个 pnpm workspace，无法共享常量，因此这里按
 * preflight 的 reserve 上限（21000）估算——对 maxOutputTokens ≥ 21000 的模型是精确值，
 * 其余模型是略偏保守的近似值（设置页展示文案带「约」）。
 *
 * 用户调的是**安全余量**（tokens），百分比只是反算出来的只读展示值。
 */
const AUTOCOMPACT_OUTPUT_RESERVE_CAP_TOKENS = 21_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

export const COMPACTION_BUFFER_INPUT_K_MIN = 1;
export const COMPACTION_BUFFER_INPUT_K_MAX = 100;
export const COMPACTION_KEEP_RECENT_TOOL_RESULTS_MIN = 1;
export const COMPACTION_KEEP_RECENT_TOOL_RESULTS_MAX = 50;
export const COMPACTION_POST_TURN_OFFSET_INPUT_K_MIN = 0;
export const COMPACTION_POST_TURN_OFFSET_INPUT_K_MAX = 100;

export type BufferTokensInput =
  | { kind: "auto" }
  | { kind: "value"; value: number }
  | { kind: "invalid" };

/**
 * 安全余量输入解析（单位：千 tokens）：空串 = 「不覆盖」（写 null 让默认/文件值生效），
 * 1–100 整数 K = 显式余量（存 tokens，即 K×1000），其余（越界、小数、非数字）一律 invalid。
 */
export function parseBufferTokensInput(raw: string): BufferTokensInput {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "auto" };
  }
  if (!/^\d+$/u.test(trimmed)) {
    return { kind: "invalid" };
  }
  const thousands = Number(trimmed);
  if (
    !Number.isInteger(thousands) ||
    thousands < COMPACTION_BUFFER_INPUT_K_MIN ||
    thousands > COMPACTION_BUFFER_INPUT_K_MAX
  ) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: thousands * 1_000 };
}

export type KeepRecentToolResultsInput = { kind: "value"; value: number } | { kind: "invalid" };

export function parseKeepRecentToolResultsInput(raw: string): KeepRecentToolResultsInput {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return { kind: "invalid" };
  }
  const value = Number(trimmed);
  if (
    !Number.isInteger(value) ||
    value < COMPACTION_KEEP_RECENT_TOOL_RESULTS_MIN ||
    value > COMPACTION_KEEP_RECENT_TOOL_RESULTS_MAX
  ) {
    return { kind: "invalid" };
  }
  return { kind: "value", value };
}

export type PostTurnThresholdOffsetTokensInput =
  | { kind: "value"; value: number }
  | { kind: "invalid" };

/**
 * 轮末提前量输入解析（单位：千 tokens）：0–100 整数 K 为有效值（存 tokens = K×1000）。
 * 空串按 invalid 处理（与 `parseKeepRecentToolResultsInput` 一致）：提前量没有"自动"态，
 * 0 即等价于默认，用户清空输入框属于没表达清楚，不静默当成 0。
 */
export function parsePostTurnThresholdOffsetTokensInput(
  raw: string,
): PostTurnThresholdOffsetTokensInput {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) {
    return { kind: "invalid" };
  }
  const thousands = Number(trimmed);
  if (
    !Number.isInteger(thousands) ||
    thousands < COMPACTION_POST_TURN_OFFSET_INPUT_K_MIN ||
    thousands > COMPACTION_POST_TURN_OFFSET_INPUT_K_MAX
  ) {
    return { kind: "invalid" };
  }
  return { kind: "value", value: thousands * 1_000 };
}

/**
 * 当前生效的压缩阈值（tokens）：(窗口 − output reserve) − 安全余量。
 * 余量为 null 时用默认 13000；取不到模型窗口时返回 null，UI 只显示「自动」而不是编一个数字。
 */
export function resolveAutoThresholdTokens(
  contextWindow: number | undefined,
  bufferTokens: number | null,
): number | null {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  const reserve = Math.min(AUTOCOMPACT_OUTPUT_RESERVE_CAP_TOKENS, contextWindow);
  const effectiveContextWindow = Math.max(0, contextWindow - reserve);
  const buffer =
    bufferTokens !== null && Number.isFinite(bufferTokens) && bufferTokens > 0
      ? bufferTokens
      : AUTOCOMPACT_BUFFER_TOKENS;
  return Math.max(0, effectiveContextWindow - buffer);
}

/** 数值控件的草稿：null/空表示「不覆盖」，否则显示为千 tokens 整数。 */
export function formatTokensAsThousandsDraft(value: number | null): string {
  return value === null ? "" : String(Math.round(value / 1_000));
}

/** 阈值占模型完整窗口的百分比（四舍五入到整数），只读展示用。 */
export function resolveThresholdPercent(
  contextWindow: number | undefined,
  thresholdTokens: number | null,
): number | null {
  if (
    contextWindow === undefined ||
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    thresholdTokens === null
  ) {
    return null;
  }
  return Math.round((thresholdTokens / contextWindow) * 100);
}

/**
 * 取当前生效模型的上下文窗口：优先用 View 解析出的 effectiveSelection，
 * 再回落到 View 自己声明的首个模型（无选中模型时也能给出量级）。
 */
export function readEffectiveModelContextWindow(
  view: ModelSelectionView | null | undefined,
): number | undefined {
  if (!view) {
    return undefined;
  }
  const selection = view.effectiveSelection ?? view.preferredSelection ?? null;
  const providers = selection
    ? view.providers.filter((provider) => provider.providerId === selection.providerId)
    : view.providers;
  const models = providers.flatMap((provider) => provider.models);
  const model = selection ? models.find((entry) => entry.modelId === selection.modelId) : models[0];
  const contextWindow = model?.config.properties?.contextWindow;
  return typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
}
