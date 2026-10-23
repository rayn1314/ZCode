/**
 * provider-request-policy 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 *
 * publicEntrypoints 与策略登记一致：契约即为对外唯一入口（没有 index.ts）；实现文件由同一
 * bootstrap 内的装配点直接引用，属于策略里的既有边界，不在本清单里另开入口。
 */
export const providerRequestPolicyModule = {
  id: "provider-request-policy",
  requires: ["provider", "zcode-cli"],
  provides: ["provider-request-policy"],
  publicEntrypoints: ["contract.ts"],
} as const;
