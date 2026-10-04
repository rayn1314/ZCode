// 极简 MCP stdio 客户端：只覆盖 open-computer-use MCP server 需要的协议面
// （initialize / notifications/initialized / tools/list / tools/call）。
// 刻意不引入 @modelcontextprotocol 依赖，保持本包零依赖、无构建步骤。
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

export function createMcpStdioClient(options = {}) {
  const {
    command = "cmd",
    args = ["/c", "open-computer-use", "mcp"],
    clientName = "zcode-cua-bridge",
    clientVersion = "0.1.0",
  } = options;

  let child;
  let rl;
  let nextId = 1;
  let initialized = false;
  let closed = false;
  const pending = new Map();

  function ensureSpawned() {
    if (child) return;
    child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let msg;
      try {
        msg = JSON.parse(trimmed);
      } catch {
        return;
      }
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) {
          entry.reject(
            new Error(typeof msg.error === "string" ? msg.error : JSON.stringify(msg.error)),
          );
        } else {
          entry.resolve(msg.result);
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      process.stderr.write(`[cua-bridge] ${chunk}`);
    });
    child.on("error", (error) => {
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    });
    child.on("exit", (code) => {
      const error = new Error(`open-computer-use MCP server exited (code=${code})`);
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    });
  }

  function sendRequest(method, params) {
    if (closed) {
      return Promise.reject(new Error("CUA bridge client is closed"));
    }
    ensureSpawned();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method,
          ...(params !== undefined ? { params } : {}),
        })}\n`,
      );
    });
  }

  function sendNotification(method, params) {
    if (closed || !child) return;
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
      })}\n`,
    );
  }

  async function ensureInitialized() {
    if (initialized) return;
    await sendRequest("initialize", {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: clientVersion },
    });
    initialized = true;
    sendNotification("notifications/initialized");
  }

  async function listTools() {
    await ensureInitialized();
    const result = await sendRequest("tools/list");
    return result.tools;
  }

  async function callTool(name, args) {
    await ensureInitialized();
    return await sendRequest("tools/call", { name, arguments: args ?? {} });
  }

  async function close() {
    if (closed) return;
    closed = true;
    try {
      child?.stdin.end();
    } catch {}
    child?.kill();
    rl?.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return { listTools, callTool, close };
}
