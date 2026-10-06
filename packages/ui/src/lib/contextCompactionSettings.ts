import type { ModelSelectionView } from "@zcode/services";

/**
 * 「上下文压缩」设置分区的纯计算与输入解析。
 *
 * 与 `apps/zcode-cli/packages/core/src/compact/policy.ts` 的阈值公式保持一致：
 * 自动阈值 = (窗口 − output reserve) − buffer，其中 reserve = min(maxOutputTokens, 21000)、
 * buffer = 13000。core 与 ui 分属两个 pnpm workspace，无法共享常量，因此这里按
 * preflight 的 reserve 上限（21000）估算——对 maxOutputTokens ≥ 21000 的模型是精确值，
 * 其余模型是略偏保守的近似值（设置页展示文案带「约」）。
 */
const AUTOCOMPACT_OUTPUT_RESERVE_CAP_TOKENS = 21_000;
const AUTOCOMPACT_BUFFER_TOKENS = 13_000;

export const COMPACTION_THRESHOLD_PERCENT_MIN = 1;
export const COMPACTION_THRESHOLD_PERCENT_MAX = 100;
export const COMPACTION_KEEP_RECENT_TOOL_RESULTS_MIN = 1;
export const COMPACTION_KEEP_RECENT_TOOL_RESULTS_MAX = 50;

export type CompactionThresholdInput =
  | { kind: "auto" }
  | { kind: "percent"; value: number }
  | { kind: "invalid" };

/**
 * 阈值输入解析：空串 = 「自动」（写 null 清除覆盖），1–100 整数 = 显式百分比，
 * 其余（含小数、越界、非数字）一律 invalid，由调用方做行内报错且不提交。
 */
export function parseCompactionThresholdPercentInput(raw: string): CompactionThresholdInput {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { kind: "auto" };
  }
  if (!/^\d+$/u.test(trimmed)) {
    return { kind: "invalid" };
  }
  const value = Number(trimmed);
  if (
    !Number.isInteger(value) ||
    value < COMPACTION_THRESHOLD_PERCENT_MIN ||
    value > COMPACTION_THRESHOLD_PERCENT_MAX
  ) {
    return { kind: "invalid" };
  }
  return { kind: "percent", value };
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

/**
 * 自动模式在该窗口下实际生效的阈值百分比（四舍五入到整数）。
 * 取不到模型窗口时返回 null，UI 只显示「自动」而不是编一个数字。
 */
export function resolveAutoThresholdPercent(contextWindow: number | undefined): number | null {
  if (contextWindow === undefined || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return null;
  }
  const reserve = Math.min(AUTOCOMPACT_OUTPUT_RESERVE_CAP_TOKENS, contextWindow);
  const effectiveContextWindow = Math.max(0, contextWindow - reserve);
  const threshold = Math.max(0, effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS);
  return Math.round((threshold / contextWindow) * 100);
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
