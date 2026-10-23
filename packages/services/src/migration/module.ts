/**
 * data-migration 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataMigrationModule = {
  id: "data-migration",
  requires: ["data-roots", "provider-node", "services", "shared", "ui"],
  provides: ["data-migration"],
  // 与 policy 的 publicEntrypoints 一致：跨模块只经契约入口拿接口与工厂。
  publicEntrypoints: ["contract.ts"],
} as const;
