// Computer Use 桥接运行时：把官方 CUA 工具面（get_app_state/type/list_apps 等）转发到
// 开源引擎 open-computer-use 的 MCP server。仅当显式开启桥接模式时由 index.js 使用。
import { createMcpStdioClient } from "./bridge-mcp-client.js";

// 官方工具名 → open-computer-use 工具名。
const TOOL_ALIASES = {
  list_apps: "list_apps",
  get_app_state: "get_app_state",
  type: "type_text",
  type_text: "type_text",
  click: "click",
  key: "press_key",
  hold_key: "press_key",
  press_key: "press_key",
  scroll: "scroll",
  drag: "drag",
  set_value: "set_value",
  perform_secondary_action: "perform_secondary_action",
};

// 官方参数里常见的 app 标识字段 → 开源统一的 `app` 字段。
const APP_FIELD_ALIASES = ["app_id", "application", "application_id", "bundle_id", "appId"];

function normalizeArguments(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args ?? {};
  const out = { ...args };
  if (out.app === undefined || out.app === null) {
    for (const key of APP_FIELD_ALIASES) {
      if (out[key] !== undefined && out[key] !== null) {
        out.app = out[key];
        break;
      }
    }
  }
  return out;
}

function textResult(text, { isError = false } = {}) {
  return { content: [{ type: "text", text }], isError };
}

function jsonResult(value, options) {
  return textResult(JSON.stringify(value), options);
}

// 官方有、开源引擎没有的工具：在桥接层做语义化本地处理。
function handleSpecialTool(toolName) {
  switch (toolName) {
    case "request_access":
      // Windows 上 open-computer-use 不需要辅助功能/屏幕录制授权；not_required 让
      // UI 的权限详情渲染为"已满足"（见 ui cuaAccessDetails statusAfterToBoolean）。
      return jsonResult({
        accessibility: { status_after: "not_required" },
        screen_recording: { status_after: "not_required" },
        permission_request: { status_after: "not_required" },
      });
    case "stop_computer_control":
      return jsonResult({ ok: true });
    case "status":
      return jsonResult({
        ok: true,
        engine: "open-computer-use",
        bridge: "zcode-cua-bridge",
        platform: process.platform,
      });
    case "open_application":
      return textResult(
        "open_application is not supported by the open-source CUA bridge yet. " +
          "Use get_app_state on the target app instead.",
        { isError: true },
      );
    default:
      return null;
  }
}

export function createBridgeComputerUseRuntime(options = {}) {
  const client = createMcpStdioClient({
    command: options.command,
    args: options.args,
  });
  let disposed = false;

  return {
    async execute({ toolName, arguments: args }) {
      if (disposed) {
        return textResult("Computer Use bridge runtime is disposed.", { isError: true });
      }
      const name = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
      const special = handleSpecialTool(name);
      if (special) return special;
      const targetTool = TOOL_ALIASES[name] ?? name;
      try {
        return await client.callTool(targetTool, normalizeArguments(args));
      } catch (error) {
        return textResult(
          `Computer Use bridge call failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
          { isError: true },
        );
      }
    },
    async closeSession() {
      // 桥接 runtime 无会话态；执行间共享同一个开源 MCP server 连接。
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await client.close();
    },
  };
}
