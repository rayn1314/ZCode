/**
 * context-compaction 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 *
 * publicEntrypoints 与策略登记一致：契约即为对外唯一入口（没有 index.ts）。运行时侧策略合成与
 * 触发点执行位于 core 内部、只由 core 运行时调用；设置分区与摘要读端位于根 workspace 的 ui 包，
 * 都按策略里的既有边界引用，不在本清单里另开入口。
 */
export const contextCompactionModule = {
  id: "context-compaction",
  requires: ["services", "shared", "ui", "zcode-cli"],
  provides: ["context-compaction"],
  publicEntrypoints: ["contract.ts"],
} as const;
