/**
 * goal-task-panel 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 * 公开入口只有契约：面板组件与 store 由本模块内文件互相引用，跨模块调用方读 contract.ts。
 */
export const goalTaskPanelModule = {
  id: "goal-task-panel",
  requires: ["services", "shared", "ui"],
  provides: ["goal-task-panel"],
  publicEntrypoints: ["contract.ts"],
} as const;
