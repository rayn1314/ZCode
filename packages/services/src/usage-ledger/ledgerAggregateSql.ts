import type { LedgerPriceTable } from "./ledgerPrices.js";

export interface AggregateContext {
  fromMs: number | null;
  toMs: number;
  scoped: boolean;
  /** 分桶偏移（毫秒）：跨环境统一由 host 下发，两侧同一条时间轴。 */
  tzOffsetMs: number;
  today0: number;
  month0: number;
  nowMs: number;
  providerLabelFilter: string | null;
  modelId: string | null;
  priceTable: LedgerPriceTable;
}

export function buildFilters(
  scoped: boolean,
  fromMs: number | null,
  toMs: number,
  providerIds: string[] | null,
  modelId: string | null,
  alias = "",
): { conds: string[]; args: (string | number)[] } {
  // 时间范围与供应商/模型是正交筛选，统一在这里拼条件；alias 供 join 查询加表前缀。
  // 条件文本全是静态列名，值一律走 ? 占位符。
  const col = alias ? `${alias}.` : "";
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (scoped && fromMs !== null) {
    conds.push(`${col}started_at >= ? AND ${col}started_at <= ?`);
    args.push(fromMs, toMs);
  }
  if (providerIds && providerIds.length > 0) {
    conds.push(`${col}provider_id IN (${providerIds.map(() => "?").join(",")})`);
    args.push(...providerIds);
  }
  if (modelId) {
    conds.push(`${col}model_id = ?`);
    args.push(modelId);
  }
  return { conds, args };
}

export function whereSql(conds: string[], extra: string[] = []): string {
  const all = [...conds, ...extra];
  return all.length ? `WHERE ${all.join(" AND ")}` : "";
}

export interface AccRow {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  durSum: number;
  durWeight: number;
  cost: number | null;
}

export function newAcc(): AccRow {
  return {
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    durSum: 0,
    durWeight: 0,
    cost: null,
  };
}

export function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
