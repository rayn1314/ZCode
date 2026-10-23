/**
 * model-replay-diagnostics 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const modelReplayDiagnosticsModule = {
  id: "model-replay-diagnostics",
  requires: ["zcode-cli"],
  provides: ["model-replay-diagnostics"],
  // 与 policy 的 publicEntrypoints 一致：跨模块只应读契约，实现文件不对外。
  publicEntrypoints: ["contract.ts"],
} as const;
