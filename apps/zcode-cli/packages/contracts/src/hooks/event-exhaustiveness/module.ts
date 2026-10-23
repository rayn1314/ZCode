/**
 * event-exhaustiveness 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const eventExhaustivenessModule = {
  id: "event-exhaustiveness",
  requires: ["shared", "zcode-cli"],
  provides: ["event-exhaustiveness"],
  // 与 policy 的 publicEntrypoints 一致：守卫本身不对外暴露实现，只暴露契约入口。
  publicEntrypoints: ["contract.ts"],
} as const;
