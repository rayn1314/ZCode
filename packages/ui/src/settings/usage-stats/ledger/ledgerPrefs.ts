import type { LedgerRange } from "@zcode/shared";

// 账本面板的偏好记忆：localStorage 版本化键，全部 try/catch 容错（隐私模式下退化为不记忆）。
// 「全部来源」存 null——新增数据根时自动纳入，不需要用户重新勾选。

export const LEDGER_PREFS_KEY = "zcode.ledger.prefs.v1";

export const LEDGER_RANGES_UI: LedgerRange[] = ["today", "7d", "30d", "custom", "all"];

export const LEDGER_REFRESH_OPTIONS = [0, 10_000, 30_000, 60_000, 300_000] as const;

export type LedgerDailyMetric = "tokens" | "calls" | "cost";
export type LedgerDonutMetric = "calls" | "tokens" | "cost";

export interface LedgerPrefs {
  range: LedgerRange;
  customStart: string;
  customEnd: string;
  /** 空串 = 不过滤。 */
  providerLabel: string;
  modelId: string;
  /** null = 全部来源（跟随新增数据源）；数组 = 选中的来源 key。 */
  sourceKeys: string[] | null;
  refreshIntervalMs: number;
  dailyMetric: LedgerDailyMetric;
  donutMetric: LedgerDonutMetric;
}

export const DEFAULT_LEDGER_PREFS: LedgerPrefs = {
  range: "30d",
  customStart: "",
  customEnd: "",
  providerLabel: "",
  modelId: "",
  sourceKeys: null,
  refreshIntervalMs: 30_000,
  dailyMetric: "tokens",
  donutMetric: "calls",
};

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

export function loadLedgerPrefs(): LedgerPrefs {
  try {
    const raw = localStorage.getItem(LEDGER_PREFS_KEY);
    if (!raw) {
      return { ...DEFAULT_LEDGER_PREFS };
    }
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const interval = Number(parsed.refreshIntervalMs);
    return {
      range: oneOf(parsed.range, LEDGER_RANGES_UI, DEFAULT_LEDGER_PREFS.range),
      customStart: typeof parsed.customStart === "string" ? parsed.customStart : "",
      customEnd: typeof parsed.customEnd === "string" ? parsed.customEnd : "",
      providerLabel: typeof parsed.providerLabel === "string" ? parsed.providerLabel : "",
      modelId: typeof parsed.modelId === "string" ? parsed.modelId : "",
      sourceKeys: Array.isArray(parsed.sourceKeys)
        ? parsed.sourceKeys.filter((k): k is string => typeof k === "string")
        : null,
      refreshIntervalMs: (LEDGER_REFRESH_OPTIONS as readonly number[]).includes(interval)
        ? interval
        : DEFAULT_LEDGER_PREFS.refreshIntervalMs,
      dailyMetric: oneOf(parsed.dailyMetric, ["tokens", "calls", "cost"] as const, "tokens"),
      donutMetric: oneOf(parsed.donutMetric, ["calls", "tokens", "cost"] as const, "calls"),
    };
  } catch {
    return { ...DEFAULT_LEDGER_PREFS };
  }
}

export function saveLedgerPrefs(patch: Partial<LedgerPrefs>): void {
  try {
    const current = loadLedgerPrefs();
    localStorage.setItem(LEDGER_PREFS_KEY, JSON.stringify({ ...current, ...patch }));
  } catch {
    // 存储不可用时静默降级
  }
}

/** 今天在本地时区的 YYYY-MM-DD，供自定义范围日期输入默认值。 */
export function todayLocalDateString(nowMs = Date.now()): string {
  const now = new Date(nowMs);
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}
