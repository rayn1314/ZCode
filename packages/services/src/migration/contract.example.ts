/**
 * data-migration 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import {
  createMigrationService,
  type DataMigrationContract,
  type MigrationDomainId,
  type MigrationServiceDeps,
} from "./contract.js";

/** 契约对象就是真实工厂的返回值，没有包装层。 */
export function exampleDataMigration(deps: MigrationServiceDeps): DataMigrationContract {
  return createMigrationService(deps);
}

/** 单域迁移的结果计数（UI 的汇总行就是这么累加的）。 */
export interface MigrationTotals {
  imported: number;
  skipped: number;
  failed: number;
}

/**
 * 最常见的一次完整调用，与 `packages/ui/src/hooks/useIdentityDataMigration.ts` 的顺序一致：
 * 探测来源 → 扫描该来源 → 逐域**串行**迁移（单域失败只记状态，不中断后续域）→ 汇总计数。
 *
 * 返回 `null` 表示本机没有其它身份数据根（不是错误，UI 显示空态）。
 */
export async function runIdentityDataMigration(
  deps: MigrationServiceDeps,
): Promise<MigrationTotals | null> {
  const migration = exampleDataMigration(deps);
  const [source] = await migration.discoverSources();
  if (!source) {
    return null;
  }

  const scan = await migration.scanSource({ sourceRootPath: source.rootPath });
  const selected: MigrationDomainId[] = scan.domains
    .filter((domain) => domain.available && domain.defaultSelected)
    .map((domain) => domain.id);

  const totals: MigrationTotals = { imported: 0, skipped: 0, failed: 0 };
  for (const domain of selected) {
    const result = await migration.migrateDomain({
      sourceRootPath: source.rootPath,
      domain,
    });
    totals.imported += result.imported;
    totals.skipped += result.skipped;
    totals.failed += result.failed;
  }
  return totals;
}
