/**
 * provider-model-fetch 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 *
 * publicEntrypoints 与策略登记一致：契约即为对外唯一入口（没有 index.ts）。端口的服务端装配在
 * `services/src/node.ts`，UI 侧弹窗在根 workspace 的 ui 包，都按策略里的既有边界引用。
 */
export const providerModelFetchModule = {
  id: "provider-model-fetch",
  requires: ["provider", "services", "shared", "ui"],
  provides: ["provider-model-fetch"],
  publicEntrypoints: ["contract.ts"],
} as const;
