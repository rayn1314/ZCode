/**
 * session-messaging 模块清单（architecture-governance managed 模块）。
 * 层：app。修改 requires 时同步更新 architecture-policy.yaml（检查器会校验两者一致）。
 */
export const sessionMessagingModule = {
  id: "session-messaging",
  requires: ["data-roots", "services", "session", "shared", "ui", "zcode-cli"],
  provides: ["session-messaging"],
  publicEntrypoints: ["contract.ts"],
} as const;
