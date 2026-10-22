import type { LedgerPriceMeta, LedgerPriceSource } from "@zcode/shared";
import { readFile } from "node:fs/promises";
import path from "node:path";

// 单价表 = 内置公开基准 + 同步基准 + 用户覆盖文件（后写覆盖前者）。
// 基准来自 models.dev 快照（单位：每百万 token），只用于估算；
// 同步基准 <数据根>/v2/usage-prices-baseline.json 由界面「同步价格」按钮手动写入；
// 用户覆盖文件位于 <数据根>/v2/usage-prices.json，键为小写模型名，永远优先。
// `_` 开头的键是元信息，不算模型价格；文件缺失或损坏一律视为空，不影响出数。
// 用户覆盖文件可用 `_aliases` 声明「别名 → 目标模型」，合并后统一在这里展开：
// WSL dump 用的就是展开后的扁平表，费用公式与 Python 对拍无需感知别名。

export interface ModelPrice {
  input: number;
  output: number;
  cacheRead: number;
}

export interface LedgerPriceTable {
  prices: Map<string, ModelPrice>;
  meta: LedgerPriceMeta | null;
  /** 每个键的最终来源层；loader 产出必带，裸表（只喂 calcLedgerCost）可省略。 */
  sources?: Map<string, LedgerPriceSource>;
  /** 用户声明的别名映射（未展开）。 */
  aliases?: Map<string, string>;
  /** 别名 → 展开后最终命中的目标键。 */
  aliasTargets?: Map<string, string>;
}

export const LEDGER_USER_PRICES_FILE_NAME = "usage-prices.json";
export const LEDGER_SYNCED_PRICES_FILE_NAME = "usage-prices-baseline.json";

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
  // 连字符别名：中转站（xin 等）上报的模型命名，models.dev 上该键只有劣质报价
  // （cacheRead=输入价），内置同价保证价格表回退到本层时仍是官方口径。
  "deepseek-v4-1-flash": { input: 0.15, output: 0.6, cacheRead: 0.003 },
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

interface ParsedPriceLayer {
  prices: Map<string, ModelPrice>;
  meta: LedgerPriceMeta | null;
  aliases: Map<string, string>;
}

function parsePriceJson(raw: string): ParsedPriceLayer {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) {
    return { prices: new Map(), meta: null, aliases: new Map() };
  }
  const prices = new Map<string, ModelPrice>();
  const aliases = new Map<string, string>();
  let meta: LedgerPriceMeta | null = null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (key.startsWith("_")) {
      if (key === "_aliases" && typeof value === "object" && value !== null) {
        for (const [alias, target] of Object.entries(value as Record<string, unknown>)) {
          if (typeof target === "string" && target.trim().length > 0) {
            aliases.set(alias.toLowerCase(), target.trim().toLowerCase());
          }
        }
      }
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
  return { prices, meta, aliases };
}

/** 别名链最多跟 8 层；成环即中断，别名保持未定价，不抛错。 */
const MAX_ALIAS_DEPTH = 8;

/**
 * 展开别名：把目标键的最终价复制到别名键。
 * 显式定价优先——别名键自己有任何一层的价格时不动它（否则「先补价、后配别名」会丢价）。
 */
export function expandLedgerPriceAliases(
  prices: Map<string, ModelPrice>,
  aliases: Map<string, string>,
): { prices: Map<string, ModelPrice>; aliasTargets: Map<string, string> } {
  const expanded = new Map(prices);
  const aliasTargets = new Map<string, string>();
  for (const alias of aliases.keys()) {
    if (expanded.has(alias)) {
      continue;
    }
    const seen = new Set<string>([alias]);
    let current = alias;
    for (let depth = 0; depth < MAX_ALIAS_DEPTH; depth += 1) {
      const next = aliases.get(current);
      if (!next || seen.has(next)) {
        break;
      }
      seen.add(next);
      const price = expanded.get(next);
      if (price) {
        expanded.set(alias, price);
        aliasTargets.set(alias, aliasTargets.get(next) ?? next);
        break;
      }
      current = next;
    }
  }
  return { prices: expanded, aliasTargets };
}

/**
 * 按单价表算一次调用的费用；模型没定价返回 null（不计入、也不静默按 0 算）。
 * input_tokens 本就含 cacheRead（AI SDK 归一化为 total，spec 口径 cacheRead ⊂ input），
 * 命中部分必须先从输入扣掉再乘输入价——否则命中 token 按未命中价计一遍、再按缓存价
 * 计一遍，双重计费（2026-10-09 修复：98% 命中率下预估费用虚高数十倍，$104 曾显示 $7,069）。
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
  const missInputTokens = Math.max(0, inputTokens - cacheReadTokens);
  return (
    (missInputTokens / 1e6) * price.input +
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

  /** 读价格表（带 30s 缓存）：内置基准 < 同步基准 < 用户覆盖，逐层覆盖。 */
  async load(): Promise<LedgerPriceTable> {
    const now = (this.options.now ?? Date.now)();
    if (this.cache && now - this.cache.at < LedgerPriceLoader.TTL_MS) {
      return this.cache.table;
    }
    const readFileFn = this.options.readFile ?? readFile;
    const readLayer = async (fileName: string): Promise<ParsedPriceLayer> => {
      try {
        return parsePriceJson(
          await readFileFn(path.join(this.options.dataRootDir, "v2", fileName), "utf8"),
        );
      } catch {
        // 层文件缺失或损坏视为空，不影响出数
        return { prices: new Map<string, ModelPrice>(), meta: null, aliases: new Map() };
      }
    };
    let baseline: ParsedPriceLayer;
    try {
      baseline = parsePriceJson(JSON.stringify(BASELINE_LEDGER_PRICES));
    } catch {
      baseline = { prices: new Map(), meta: null, aliases: new Map() };
    }
    const synced = await readLayer(LEDGER_SYNCED_PRICES_FILE_NAME);
    const user = await readLayer(LEDGER_USER_PRICES_FILE_NAME);
    const merged = new Map<string, ModelPrice>();
    const sources = new Map<string, LedgerPriceSource>();
    const applyLayer = (layer: ParsedPriceLayer, source: LedgerPriceSource) => {
      for (const [key, price] of layer.prices) {
        merged.set(key, price);
        sources.set(key, source);
      }
    };
    applyLayer(baseline, "builtin");
    applyLayer(synced, "synced");
    applyLayer(user, "user");
    const aliases = new Map([...baseline.aliases, ...synced.aliases, ...user.aliases]);
    const { prices, aliasTargets } = expandLedgerPriceAliases(merged, aliases);
    // 别名展开出来的键由用户声明决定其存在，来源统一记 user（价格本身可能来自内置层）。
    for (const alias of aliasTargets.keys()) {
      sources.set(alias, "user");
    }
    const table: LedgerPriceTable = {
      prices,
      meta: user.meta ?? synced.meta ?? baseline.meta,
      sources,
      aliases,
      aliasTargets,
    };
    this.cache = { at: now, table };
    return table;
  }

  /** 同步写入新基准后立即失效缓存，下一次快照即用新价。 */
  invalidate(): void {
    this.cache = null;
  }
}
