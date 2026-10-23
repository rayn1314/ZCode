/**
 * api-key-preset 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 公开入口只有契约：切换行与管理弹窗由 provider 表单在本包内引用，跨模块调用方读 contract.ts。
 */
export const apiKeyPresetModule = {
  id: "api-key-preset",
  requires: ["provider", "ui"],
  provides: ["api-key-preset"],
  publicEntrypoints: ["contract.ts"],
} as const;
