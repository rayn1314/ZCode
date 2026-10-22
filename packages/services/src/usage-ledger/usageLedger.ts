import type {
  LedgerPriceAliasSetRequest,
  LedgerPriceDeleteRequest,
  LedgerPriceListRequest,
  LedgerPriceListResult,
  LedgerPriceMutationResult,
  LedgerPriceSetRequest,
  LedgerPriceSyncResult,
  LedgerSnapshot,
  LedgerSnapshotRequest,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 用量账本：多数据根只读聚合（官方版 + 自建版数据根、WSL 桥接）。
 * 只在桌面本地 host 注册；远端 workspace 不注册，调用会失败，UI 需优雅降级。
 * 读取层的不变式（只读短连接、逐模型计价、按调用数加权合并）见 spec/usage-ledger.md。
 * 价格写操作（set/delete/alias）只改用户覆盖层，同步层与内置基准不动。
 */
export interface IUsageLedgerService {
  getLedgerSnapshot(request: LedgerSnapshotRequest): Promise<LedgerSnapshot>;
  /** 手动同步价格基准（拉 models.dev 覆盖同步层；用户覆盖文件不被动，失败保留旧基准）。 */
  syncLedgerPrices(): Promise<LedgerPriceSyncResult>;
  /** 合并后的价格表（含来源层与别名），按模型 id 子串过滤后分页返回。 */
  listLedgerPrices(request: LedgerPriceListRequest): Promise<LedgerPriceListResult>;
  /** 写用户覆盖价；同名别名会被移除。 */
  setLedgerPrice(request: LedgerPriceSetRequest): Promise<LedgerPriceMutationResult>;
  /** 删除用户覆盖价 = 恢复默认。 */
  deleteLedgerPrice(request: LedgerPriceDeleteRequest): Promise<LedgerPriceMutationResult>;
  /** 设置或删除（target=null）模型别名。 */
  setLedgerPriceAlias(request: LedgerPriceAliasSetRequest): Promise<LedgerPriceMutationResult>;
}

export const IUsageLedgerService = createServiceDescriptor<IUsageLedgerService>(
  ServiceChannels.UsageLedger,
);
