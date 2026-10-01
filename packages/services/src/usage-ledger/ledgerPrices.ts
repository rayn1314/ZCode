import type { LedgerPriceMeta } from "@zcode/shared";
import { readFile } from "node:fs/promises";
import path from "node:path";

// 单价表 = 内置公开基准 + 用户覆盖文件（同名模型用户赢）。
// 基准来自 models.dev 快照（单位：每百万 token），只用于估算；
// 用户覆盖文件位于 <数据根>/v2/usage-prices.json，键为小写模型名。
// `_` 开头的键是元信息，不算模型价格；文件缺失或损坏一律视为空，不影响出数。

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export interface LedgerPriceTable {
  prices: Map<string, ModelPrice>;
  meta: LedgerPriceMeta | null;
}

export const LEDGER_USER_PRICES_FILE_NAME = "usage-prices.json";

// 内置公开定价基准（models.dev 快照 2026-09-21），用户覆盖文件可逐模型改写。
const BASELINE_LEDGER_PRICES: Record<string, unknown> = {
  _meta: {
    source:
      "models.dev 公开模型目录（api.json），优先取厂商官方源：deepseek / zai / alibaba / moonshotai / openai / stepfun",
    date: "2026-09-21",
    currency: "USD",
    unit: "每百万 token",
    note: "公开定价基准，仅用于估算，中转商与订阅实际以账单为准。DeepSeek 官方分高峰/低谷，这里取低谷价（高峰时段为两倍）。",
  },
  "qwen3.8-flash": { input: 0.15, output: 0.47, cacheRead: 0.016 },
  "deepseek-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "deepseek-v4.1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "deepseek-v4-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
  "deepseek-v4-flash-free": { input: 0, output: 0, cacheRead: 0 },
  "deepseek-v4-pro": { input: 0.66, output: 1.98, cacheRead: 0.022 },
  "glm-5.3": { input: 1.4, output: 4.4, cacheRead: 0.26 },
  "glm-5.3-flash": { input: 0.15, output: 0.5, cacheRead: 0.03 },
  "kimi-k3": { input: 3, output: 15, cacheRead: 0.3 },
  "gpt-5.6-luna": { input: 0.2, output: 1.2, cacheRead: 0.02 },
  "step-5-preview": { input: 1, output: 2.7, cacheRead: 0.05 },
  "step-3.7-flash": { input: 0.185, output: 1.11, cacheRead: 0.037 },
  "step-3.5-flash": { input: 0.1, output: 0.3, cacheRead: 0.02 },
};

function toPrice(value: unknown): ModelPrice | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const raw = value as Record<string, unknown>;
  return {
    input: Number(raw.input) || 0,
    output: Number(raw.output) || 0,
    cacheRead: Number(raw.cacheRead) || 0,
  };
}

function parsePriceJson(raw: string): {
  prices: Map<string, ModelPrice>;
  meta: LedgerPriceMeta | null;
} {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return { prices: new Map(), meta: null };
  }
  const prices = new Map<string, ModelPrice>();
  let meta: LedgerPriceMeta | null = null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith("_")) {
      if (key === "_meta" && typeof value === "object" && value !== null) {
        const m = value as Record<string, unknown>;
        meta = {
          date: typeof m.date === "string" ? m.date : undefined,
          currency: typeof m.currency === "string" ? m.currency : undefined,
          source: typeof m.source === "string" ? m.source : undefined,
          note: typeof m.note === "string" ? m.note : undefined,
        };
      }
      continue;
    }
    const price = toPrice(value);
    if (price) {
      prices.set(key.toLowerCase(), price);
    }
  }
  return { prices, meta };
}

/**
 * 按单价表算一次调用的费用；模型没定价返回 null（不计入、也不静默按 0 算）。
 * 缓存读是输入的子集，按缓存价单独计，不能再按输入价计一遍。
 */
export function calcLedgerCost(
  table: LedgerPriceTable | null,
  modelId: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
  cacheReadTokens: number,
): number | null {
  if (!table || table.prices.size === 0 || !modelId) {
    return null;
  }
  const price = table.prices.get(modelId.toLowerCase());
  if (!price) {
    return null;
  }
  return (
    (inputTokens / 1e6) * price.input +
    (outputTokens / 1e6) * price.output +
    (cacheReadTokens / 1e6) * price.cacheRead
  );
}

export class LedgerPriceLoader {
  private static readonly TTL_MS = 30_000;
  private cache: { at: number; table: LedgerPriceTable } | null = null;

  constructor(
    private readonly options: {
      dataRootDir: string;
      readFile?: typeof readFile;
      now?: () => number;
    },
  ) {}

  /** 读价格表（带 30s 缓存）：内置基准 + <数据根>/v2/usage-prices.json 用户覆盖。 */
  async load(): Promise<LedgerPriceTable> {
    const now = (this.options.now ?? Date.now)();
    if (this.cache && now - this.cache.at < LedgerPriceLoader.TTL_MS) {
      return this.cache.table;
    }
    const readFileFn = this.options.readFile ?? readFile;
    let baseline: { prices: Map<string, ModelPrice>; meta: LedgerPriceMeta | null };
    let user: { prices: Map<string, ModelPrice>; meta: LedgerPriceMeta | null } = {
      prices: new Map(),
      meta: null,
    };
    try {
      baseline = parsePriceJson(JSON.stringify(BASELINE_LEDGER_PRICES));
    } catch {
      baseline = { prices: new Map(), meta: null };
    }
    try {
      user = parsePriceJson(
        await readFileFn(
          path.join(this.options.dataRootDir, "v2", LEDGER_USER_PRICES_FILE_NAME),
          "utf8",
        ),
      );
    } catch {
      // 用户文件缺失或损坏视为空，不影响出数
    }
    const prices = new Map([...baseline.prices, ...user.prices]);
    const table: LedgerPriceTable = { prices, meta: user.meta ?? baseline.meta };
    this.cache = { at: now, table };
    return table;
  }
}
