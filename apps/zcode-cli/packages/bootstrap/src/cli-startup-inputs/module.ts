/**
 * cli-startup-inputs 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 *
 * publicEntrypoints 与策略登记一致：`create-app.ts` 直接调用 `startup-inputs.ts` 的解析函数，
 * `subagent-child-scope.ts` 只引用它的快照类型；没有 index.ts，契约入口是本目录的 contract.ts。
 */
export const cliStartupInputsModule = {
  id: "cli-startup-inputs",
  requires: ["shared", "zcode-cli"],
  provides: ["cli-startup-inputs"],
  publicEntrypoints: ["../app/startup-inputs.ts", "contract.ts"],
} as const;
