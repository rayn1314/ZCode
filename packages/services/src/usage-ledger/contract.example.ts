/**
 * usage-ledger 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 四段真实用法：
 * 1. 面板默认请求：最近 30 天、全部来源。
 * 2. 读一次快照；失败源只在 `sources` 里灰显，主源失败才 reject。
 * 3. 给未定价模型补价 / 配别名：写用户覆盖层后重新读快照，费用口径跟着变。
 * 4. 会话层级推导：纯函数 `rollupSubtrees` + `selectLedgerSessionRows`（单源配额 200）。
 */
import type { LedgerSnapshot, LedgerSnapshotRequest } from "@zcode/shared";
import type { IUsageLedgerService } from "./contract.js";
import { calcLedgerCost, type LedgerPriceTable } from "./ledgerPrices.js";
import {
  rollupSubtrees,
  selectLedgerSessionRows,
  type LedgerSessionFact,
} from "./ledgerSessionTree.js";

/** 面板默认请求：最近 30 天、全部来源、不按供应商/模型过滤。 */
export const DEFAULT_LEDGER_REQUEST: LedgerSnapshotRequest = {
  range: "30d",
  providerLabel: null,
  modelId: null,
  sourceKeys: null,
};

/** 读一次快照：`ok=false` 的来源继续出现在列表里灰显，不整页失败。 */
export async function readLedgerSnapshot(
  service: IUsageLedgerService,
  request: LedgerSnapshotRequest = DEFAULT_LEDGER_REQUEST,
): Promise<LedgerSnapshot> {
  return service.getLedgerSnapshot(request);
}

/**
 * 给未定价模型补价 + 把中转站模型名指向官方模型。
 * 写入只动用户覆盖层；成功后重新读快照，`overview.cost` 与 `unpricedCalls` 随之更新。
 */
export async function priceUnpricedModels(service: IUsageLedgerService): Promise<LedgerSnapshot> {
  const listed = await service.listLedgerPrices({ query: "flash", limit: 50 });
  for (const entry of listed.entries) {
    // 已有价（显式或别名展开）的键不动，避免覆盖用户手写的价。
    if (entry.input > 0 || entry.output > 0) continue;
    await service.setLedgerPrice({
      modelId: entry.modelId,
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
    });
  }
  // 目标未定价时别名不产生计价效果，列表里该条 resolved 为 false。
  await service.setLedgerPriceAlias({ alias: "xin/deepseek-flash", target: "deepseek-flash" });
  return service.getLedgerSnapshot(DEFAULT_LEDGER_REQUEST);
}

/** 单源聚合内的会话层级推导：先 rollup 子树，再按顶层配额截断（保父链完整）。 */
export function buildSessionRowsExample(facts: LedgerSessionFact[]) {
  return selectLedgerSessionRows(rollupSubtrees(facts), 200);
}

/** 逐模型计价：价格表为 null（未加载）或模型未定价时返回 null，不计入合计。 */
export function calcCostExample(table: LedgerPriceTable | null): number | null {
  return calcLedgerCost(table, "deepseek-v4-1-flash", 1_000_000, 2_000, 400_000);
}
