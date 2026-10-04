import { createBridgeComputerUseRuntime } from "./bridge-runtime.js";

const UNAVAILABLE_TEXT = "Computer Use is not available in this build.";

// 桥接模式开关：显式 options.bridge 或环境变量 ZCODE_CUA_BRIDGE_ENABLE。
function isBridgeEnabled(env = process.env) {
  const explicit = env.ZCODE_CUA_BRIDGE_ENABLE?.trim().toLowerCase();
  return explicit === "1" || explicit === "true" || explicit === "on";
}

export function createComputerUseRuntime(options) {
  if (options?.bridge === true || isBridgeEnabled()) {
    return createBridgeComputerUseRuntime(options);
  }
  return {
    async execute() {
      return {
        content: [{ type: "text", text: UNAVAILABLE_TEXT }],
        isError: true,
      };
    },
    async closeSession() {},
    async dispose() {},
  };
}
