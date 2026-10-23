/**
 * usage-ledger 模块清单（architecture-governance managed 模块）。
 * 层：adapters。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const usageLedgerModule = {
  id: "usage-ledger",
  requires: ["data-roots", "services", "shared", "ui"],
  provides: ["usage-ledger"],
  publicEntrypoints: ["index.ts", "contract.ts"],
} as const;
