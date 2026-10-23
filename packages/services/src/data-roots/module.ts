/**
 * data-roots 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const dataRootsModule = {
  id: "data-roots",
  requires: ["shared"],
  provides: ["data-roots"],
  // 与 policy 的 publicEntrypoints 一致；node 侧派生单源在 `@zcode/shared/identity-paths-node`，
  // 它同时是 `packages/shared` 的文件，因此按仓库相对路径列出。
  publicEntrypoints: [
    "packages/services/src/data-roots/contract.ts",
    "packages/services/src/data-roots/machineDataRoots.ts",
    "packages/shared/src/identity-paths-node.ts",
  ],
} as const;
