import type {
  IMigrationService,
  MigrationDomainId,
  MigrationDomainResult,
  MigrationScanResult,
  MigrationSourceRoot,
} from "./migration.js";

/**
 * data-migration 对外契约：把本机**另一个身份数据根**里的数据按域搬进当前身份。
 *
 * 意图与规则来源：`packages/services/spec/identity-data-migration.md`。此处只列调用方必须知道的部分。
 *
 * 三个不变式：
 * 1. 目标已有数据永不被覆盖：`sessions` / `providerConfig` 整域跳过，其余逐项跳过；
 *    需要覆盖时用户先自行删除目标文件。冲突数由 `conflictCount` 如实上报。
 * 2. 单域独立事务：某域失败只返回 `status: "failed"` 与错误摘要，不抛错、不影响其它域；
 *    调用方（UI）逐域串行 await，因此「第 k/n 步」进度天然成立——RPC 不序列化函数，
 *    所以这里没有 onProgress 回调。
 * 3. 来源身份不可见性：`sourceRootPath` 必须落在本机探测结果集合内（服务内部重新探测后做集合校验），
 *    且探测结果排除当前身份，避免「自己迁自己」。凭据不走整文件复制，而是解密后经目标
 *    `ICredentialService.save` 重新加密（同机派生密钥不含产品身份，故源密文可解）。
 */

// 真实类型与工厂：接口/描述符 browser-safe，工厂与逐域文件系统实现只在 `@zcode/services/node` 暴露。
export { IMigrationService } from "./migration.js";
export { createMigrationService } from "./migrationService.js";
export type {
  MigrationDomainId,
  MigrationDomainResult,
  MigrationDomainSummary,
  MigrationScanResult,
  MigrationSourceRoot,
} from "./migration.js";
export type {
  MigrationDomainContext,
  MigrationDomainOps,
  MigrationServiceDeps,
} from "./domainSupport.js";
/** details 每条上限（服务层统一截断，避免 RPC payload 随来源条目数线性膨胀）。 */
export { MIGRATION_DETAILS_LIMIT } from "./domainSupport.js";

/** 单域迁移请求。 */
export interface MigrateDomainRequest {
  sourceRootPath: string;
  domain: MigrationDomainId;
}

/**
 * 迁移服务的对外契约。三个方法里只有两个写入口，且写入全部通过目标身份已注册的服务或
 * 目标身份数据根内的路径完成——不存在第二条写入通路。
 */
export interface DataMigrationContract {
  /**
   * 探测本机全部可用来源数据根（排除当前身份），官方根排首位。
   * 前置：无。后置：只读目录，结果稳定排序；不写任何文件。幂等。
   */
  discoverSources(): Promise<MigrationSourceRoot[]>;
  /**
   * 扫描单个来源：逐域算 `available` / `itemCount` / `bytes` / `conflictCount` / `defaultSelected`，
   * 并返回「不迁移的内容」说明。前置：`sourceRootPath` 来自 `discoverSources()`。
   * 后置：只读；单域扫描异常被折成 `available: false` + `skipReason`，不拖垮整份结果。
   * 来源不在探测集合内时 reject。
   */
  scanSource(request: { sourceRootPath: string }): Promise<MigrationScanResult>;
  /**
   * 迁移单个域：目标已有的一律跳过；写入在提交前不产生半截状态（`sessions` 失败回滚本次新建产物）。
   * 前置：`sourceRootPath` 来自 `discoverSources()`，`domain` 是六个可迁移域之一。
   * 后置：always resolve——失败折成 `status: "failed"` + `error`；`details` 截断到
   * `MIGRATION_DETAILS_LIMIT`。重复执行只会把新出现的条目补进来（已存在的照旧跳过），
   * 因此重跑是安全的，但**不可逆**：没有撤销入口。
   */
  migrateDomain(request: MigrateDomainRequest): Promise<MigrationDomainResult>;
}

/**
 * 编译期校验：真实服务接口必须满足对外契约（任一方法签名漂移即本文件编译失败）。
 * 纯类型断言，无运行时副作用，故恒为 `true`。
 */
type _AssertServiceMatchesContract = IMigrationService extends DataMigrationContract ? true : never;
export const _checkDataMigrationContract: _AssertServiceMatchesContract = true;
