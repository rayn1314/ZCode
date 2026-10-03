import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 身份数据迁移。
 *
 * 把本机另一个身份数据根（官方版 `{home}/.zcode` 或自建版 `{home}/.zcode-<身份>`）里的数据
 * 按域搬进当前身份。规则见 `packages/services/spec/identity-data-migration.md`：
 * - 目标已有数据永不被覆盖（逐项跳过或整域跳过）；
 * - 单域独立事务，失败不影响其它域；
 * - UI 逐域串行调用 `migrateDomain`，「第 k/n 步」进度天然成立（RPC 不序列化函数，故不做 onProgress）。
 */
export type MigrationDomainId =
  | "appSettings"
  | "providerConfig"
  | "credentials"
  | "sessions"
  | "workflows"
  | "hookDeclarations";

export interface MigrationSourceRoot {
  rootPath: string;
  variant: "official" | "self";
  /** 自建版身份后缀；官方版为空串。 */
  identity: string;
  label: string;
}

export interface MigrationDomainSummary {
  id: MigrationDomainId;
  available: boolean;
  itemCount: number;
  bytes: number;
  /** 目标已存在的条目数（appSettings 为目标值不一致的键数），UI 据此提示「n 项已存在」。 */
  conflictCount: number;
  defaultSelected: boolean;
  note?: string;
  /** available=false 时的原因（如「来源没有这项数据」），不是错误。 */
  skipReason?: string;
}

export interface MigrationScanResult {
  source: MigrationSourceRoot;
  domains: MigrationDomainSummary[];
  /** 本产品不提供迁移的内容（界面折叠说明，不是灰掉的勾选项）。 */
  notMigratable: Array<{ id: string; label: string; reason: string }>;
}

export interface MigrationDomainResult {
  id: MigrationDomainId;
  status: "done" | "skipped" | "failed";
  imported: number;
  skipped: number;
  failed: number;
  /** 逐条明细，服务层统一截断到 50 条，避免 RPC payload 爆炸。 */
  details: string[];
  error?: string;
}

export interface IMigrationService {
  discoverSources(): Promise<MigrationSourceRoot[]>;
  scanSource(request: { sourceRootPath: string }): Promise<MigrationScanResult>;
  migrateDomain(request: {
    sourceRootPath: string;
    domain: MigrationDomainId;
  }): Promise<MigrationDomainResult>;
}

export const IMigrationService = createServiceDescriptor<IMigrationService>(
  ServiceChannels.Migration,
);
