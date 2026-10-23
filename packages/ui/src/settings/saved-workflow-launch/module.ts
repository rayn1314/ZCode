/**
 * saved-workflow-launch 模块清单（architecture-governance managed 模块）。
 * 层：ui。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const savedWorkflowLaunchModule = {
  id: "saved-workflow-launch",
  requires: ["provider", "shared", "ui"],
  provides: ["saved-workflow-launch"],
  publicEntrypoints: ["contract.ts"],
} as const;
