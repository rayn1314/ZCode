import type {
  LedgerPriceAliasSetRequest,
  LedgerPriceDeleteRequest,
  LedgerPriceEntry,
  LedgerPriceListRequest,
  LedgerPriceListResult,
  LedgerPriceMutationResult,
  LedgerPriceSetRequest,
  LedgerPriceSource,
  LedgerPriceSyncResult,
  LedgerSnapshot,
  LedgerSnapshotRequest,
} from "@zcode/shared";
import type { SpawnLike } from "./ledgerWsl.js";
import { syncLedgerPriceBaseline } from "./ledgerPriceSync.js";
import {
  deleteUserLedgerPrice,
  setUserLedgerAlias,
  setUserLedgerPrice,
} from "./ledgerPriceStore.js";
import { LedgerPriceLoader } from "./ledgerPrices.js";
import { LedgerReader } from "./ledgerReader.js";
import type { IUsageLedgerService } from "./usageLedger.js";

export interface UsageLedgerServiceDependencies {
  /** host 自己的数据根（账本主源）。 */
  dataRootDir: string;
  /** 测试注入用；生产走 ledgerWsl 内部的默认 spawn。 */
  spawnImpl?: SpawnLike;
}

/** 价格列表默认返回条数：3400+ 键全量回传没必要，搜索 + 截断足够界面用。 */
const DEFAULT_PRICE_LIST_LIMIT = 200;

export function createUsageLedgerService(
  dependencies: UsageLedgerServiceDependencies,
): IUsageLedgerService {
  const priceLoader = new LedgerPriceLoader({ dataRootDir: dependencies.dataRootDir });
  const reader = new LedgerReader({
    dataRootDir: dependencies.dataRootDir,
    ...(dependencies.spawnImpl ? { spawnImpl: dependencies.spawnImpl } : {}),
    priceLoader,
  });

  const invalidateAfter = async (
    result: LedgerPriceMutationResult,
  ): Promise<LedgerPriceMutationResult> => {
    if (result.ok) {
      priceLoader.invalidate();
    }
    return result;
  };

  return {
    async getLedgerSnapshot(request: LedgerSnapshotRequest): Promise<LedgerSnapshot> {
      return reader.getSnapshot(request);
    },
    async syncLedgerPrices(): Promise<LedgerPriceSyncResult> {
      const result = await syncLedgerPriceBaseline({ dataRootDir: dependencies.dataRootDir });
      if (result.ok) {
        priceLoader.invalidate();
      }
      return result;
    },
    async listLedgerPrices(request: LedgerPriceListRequest): Promise<LedgerPriceListResult> {
      const table = await priceLoader.load();
      const query = (request.query ?? "").trim().toLowerCase();
      const entries: LedgerPriceEntry[] = [];
      for (const [modelId, price] of table.prices) {
        if (query && !modelId.includes(query)) {
          continue;
        }
        const source: LedgerPriceSource = table.sources?.get(modelId) ?? "builtin";
        entries.push({
          modelId,
          input: price.input,
          output: price.output,
          cacheRead: price.cacheRead,
          source,
          aliasOf: table.aliasTargets?.get(modelId) ?? null,
        });
      }
      entries.sort((a, b) => a.modelId.localeCompare(b.modelId));
      const aliases = [...(table.aliases ?? new Map<string, string>())]
        .map(([alias, target]) => ({
          alias,
          target,
          // 别名键有价即已生效（显式定价或展开成功）；目标未定价时这里为 false。
          resolved: table.prices.has(alias),
        }))
        .sort((a, b) => a.alias.localeCompare(b.alias));
      return {
        entries: entries.slice(0, request.limit ?? DEFAULT_PRICE_LIST_LIMIT),
        total: entries.length,
        aliases,
        meta: table.meta,
      };
    },
    async setLedgerPrice(request: LedgerPriceSetRequest): Promise<LedgerPriceMutationResult> {
      return invalidateAfter(
        await setUserLedgerPrice({
          dataRootDir: dependencies.dataRootDir,
          modelId: request.modelId,
          price: { input: request.input, output: request.output, cacheRead: request.cacheRead },
        }),
      );
    },
    async deleteLedgerPrice(request: LedgerPriceDeleteRequest): Promise<LedgerPriceMutationResult> {
      return invalidateAfter(
        await deleteUserLedgerPrice({
          dataRootDir: dependencies.dataRootDir,
          modelId: request.modelId,
        }),
      );
    },
    async setLedgerPriceAlias(
      request: LedgerPriceAliasSetRequest,
    ): Promise<LedgerPriceMutationResult> {
      return invalidateAfter(
        await setUserLedgerAlias({
          dataRootDir: dependencies.dataRootDir,
          alias: request.alias,
          target: request.target ?? null,
        }),
      );
    },
  };
}
