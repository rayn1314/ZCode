/**
 * usage-ledger 公开入口：跨模块只从这里访问本模块（策略 publicEntrypoints 同时登记了 contract.ts）。
 *
 * 契约（服务描述符、方法与不变量）在 `./contract.js`；host 侧实现工厂在 `./usageLedgerService.js`，
 * 仅供 `packages/services/src/node.ts` 注册使用——远端 workspace / Web 不注册该服务。
 */
export { IUsageLedgerService } from "./contract.js";
export {
  createUsageLedgerService,
  type UsageLedgerServiceDependencies,
} from "./usageLedgerService.js";
