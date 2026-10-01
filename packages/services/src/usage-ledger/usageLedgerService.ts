import type { LedgerSnapshot, LedgerSnapshotRequest } from "@zcode/shared";
import type { SpawnLike } from "./ledgerWsl.js";
import { LedgerPriceLoader } from "./ledgerPrices.js";
import { LedgerReader } from "./ledgerReader.js";
import type { IUsageLedgerService } from "./usageLedger.js";

export interface UsageLedgerServiceDependencies {
  /** host 自己的数据根（账本主源）。 */
  dataRootDir: string;
  /** 测试注入用；生产走 ledgerWsl 内部的默认 spawn。 */
  spawnImpl?: SpawnLike;
}

export function createUsageLedgerService(
  dependencies: UsageLedgerServiceDependencies,
): IUsageLedgerService {
  const reader = new LedgerReader({
    dataRootDir: dependencies.dataRootDir,
    ...(dependencies.spawnImpl ? { spawnImpl: dependencies.spawnImpl } : {}),
    priceLoader: new LedgerPriceLoader({ dataRootDir: dependencies.dataRootDir }),
  });

  return {
    async getLedgerSnapshot(request: LedgerSnapshotRequest): Promise<LedgerSnapshot> {
      return reader.getSnapshot(request);
    },
  };
}
