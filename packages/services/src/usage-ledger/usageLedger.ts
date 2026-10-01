import type { LedgerSnapshot, LedgerSnapshotRequest } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 用量账本：多数据根只读聚合（官方版 + 自建版数据根、WSL 桥接）。
 * 只在桌面本地 host 注册；远端 workspace 不注册，调用会失败，UI 需优雅降级。
 * 读取层的不变式（只读短连接、逐模型计价、按调用数加权合并）见 spec/usage-ledger.md。
 */
export interface IUsageLedgerService {
  getLedgerSnapshot(request: LedgerSnapshotRequest): Promise<LedgerSnapshot>;
}

export const IUsageLedgerService = createServiceDescriptor<IUsageLedgerService>(
  ServiceChannels.UsageLedger,
);
