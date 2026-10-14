import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS, formatLogPrefix } from "@zcode/shared";
import {
  WebRemoteControlRelayHub,
  type WebRemoteControlRelayLogger,
  type WebRemoteControlRelaySocket,
} from "./relay/webRemoteControlRelayHub.js";
import { createRelayStaticAssetResponder } from "./relay/relayStaticAssets.js";

/**
 * 自建 Web 远程控制 relay 入口：node:http + ws 的盲转发 broker，不引入 Hono。
 *
 * 契约见 packages/server/spec/web-remote-control-relay.md。环境变量：
 * - PORT（默认 3030）、ZCODE_RELAY_HOST / HOST
 * - ZCODE_WEB_STATIC_ROOT：指向 packages/web/dist 时顺带托管 PWA（SPA fallback）
 * - ZCODE_RELAY_MAX_DEVICES：设备数上限，默认 64
 * - ZCODE_RELAY_DEBUG=1：输出 data 帧的高频调试日志（只含安全元数据）
 */

const RELAY_WS_PATH = "/ws";
const DEFAULT_MAX_DEVICES = 64;

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-relay", process.pid), ...args);
const logWarn = (...args: unknown[]) =>
  console.warn(formatLogPrefix("zcode-relay", process.pid), ...args);
const logError = (...args: unknown[]) =>
  console.error(formatLogPrefix("zcode-relay", process.pid), ...args);

interface RelayServerConfig {
  port: number;
  host?: string;
  staticRoot?: string;
  maxDevices: number;
  debug: boolean;
}

function readTrimmedEnv(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function readRelayConfig(): RelayServerConfig {
  const rawMaxDevices = Number(readTrimmedEnv("ZCODE_RELAY_MAX_DEVICES"));
  const maxDevices =
    Number.isFinite(rawMaxDevices) && rawMaxDevices > 0
      ? Math.floor(rawMaxDevices)
      : DEFAULT_MAX_DEVICES;
  return {
    port: Number(process.env["PORT"]) || 3030,
    host: readTrimmedEnv("ZCODE_RELAY_HOST") ?? readTrimmedEnv("HOST"),
    staticRoot: readTrimmedEnv("ZCODE_WEB_STATIC_ROOT"),
    maxDevices,
    debug: readTrimmedEnv("ZCODE_RELAY_DEBUG") === "1",
  };
}

function createHubLogger(debug: boolean): WebRemoteControlRelayLogger {
  return {
    info: (message, fields) => log(message, fields),
    warn: (message, fields) => logWarn(message, fields),
    error: (message, fields) => logError(message, fields),
    // data 帧按消息流频率产生，默认关闭，避免高频日志淹没排障信息。
    debug: debug
      ? (message, fields) =>
          console.debug(formatLogPrefix("zcode-relay", process.pid), message, fields)
      : undefined,
  };
}

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + part.byteLength, 0);
  }
  if (typeof raw === "string") {
    return Buffer.byteLength(raw, "utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return raw.byteLength;
  }
  if (ArrayBuffer.isView(raw)) {
    return raw.byteLength;
  }
  return Buffer.byteLength(String(raw), "utf8");
}

function rawDataToText(raw: RawData): string {
  if (typeof raw === "string") {
    return raw;
  }
  if (Array.isArray(raw)) {
    return Buffer.concat(raw).toString("utf8");
  }
  if (raw instanceof ArrayBuffer) {
    return Buffer.from(raw).toString("utf8");
  }
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
  }
  return String(raw);
}

/** routing hint 只用于同 device 的槽位对齐与排障，不作为鉴权依据。 */
function readDeviceMidHint(request: IncomingMessage, url: URL): string | undefined {
  const queryMid = url.searchParams.get("mid")?.trim();
  if (queryMid) {
    return queryMid;
  }
  const headerMid = request.headers["x-device-id"];
  const value = Array.isArray(headerMid) ? headerMid[0] : headerMid;
  return value?.trim() || undefined;
}

function toRelaySocket(socket: WebSocket): WebRemoteControlRelaySocket {
  return {
    send: (data) => {
      socket.send(data);
    },
    close: () => {
      socket.close();
    },
  };
}

async function handleHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  serveStaticAsset: ReturnType<typeof createRelayStaticAssetResponder> | undefined,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  const method = request.method ?? "GET";

  if (url.pathname === "/healthz") {
    const body = JSON.stringify({ status: "ok" });
    response.statusCode = 200;
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.setHeader("content-length", String(Buffer.byteLength(body, "utf8")));
    response.end(method === "HEAD" ? undefined : body);
    return;
  }

  if (method !== "GET" && method !== "HEAD") {
    response.statusCode = 405;
    response.setHeader("allow", "GET, HEAD");
    response.end();
    return;
  }

  if (serveStaticAsset && (await serveStaticAsset(response, url.pathname, method))) {
    return;
  }

  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end("Not Found");
}

function startRelayServer(config: RelayServerConfig): void {
  const hub = new WebRemoteControlRelayHub({
    maxDevices: config.maxDevices,
    logger: createHubLogger(config.debug),
  });
  const serveStaticAsset = config.staticRoot
    ? createRelayStaticAssetResponder({ staticRoot: config.staticRoot, spaFallback: true })
    : undefined;

  const server = createServer((request, response) => {
    void handleHttpRequest(request, response, serveStaticAsset);
  });

  // maxPayload 让 ws 在传输层直接拒绝超限帧；下面的逐条校验是同一约束的应用层兜底。
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
  });

  server.on("upgrade", (request, socket, head) => {
    let pathname = "";
    try {
      pathname = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`)
        .pathname;
    } catch {
      socket.destroy();
      return;
    }
    if (pathname !== RELAY_WS_PATH) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  });

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
    const deviceMidHint = readDeviceMidHint(request, url);
    const relaySocket = toRelaySocket(socket);
    hub.handleConnection(relaySocket);
    log("relay client connected", { device_mid: deviceMidHint });

    socket.on("message", (raw: RawData) => {
      const bytes = rawDataByteLength(raw);
      if (bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
        logWarn("relay frame exceeds physical limit, closing", {
          bytes,
          max_bytes: WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes,
          device_mid: deviceMidHint,
        });
        // 超限属于协议违规，不做关闭握手，直接销毁连接。
        socket.terminate();
        return;
      }
      hub.handleMessage(relaySocket, rawDataToText(raw));
    });

    socket.on("error", (error: Error) => {
      logWarn("relay client socket error", { message: error.message, device_mid: deviceMidHint });
    });

    socket.on("close", () => {
      hub.handleDisconnect(relaySocket);
      log("relay client disconnected", { device_mid: deviceMidHint });
    });
  });

  server.on("error", (error: Error) => {
    logError("relay server error", { message: error.message });
    process.exitCode = 1;
  });

  server.listen(config.port, config.host, () => {
    log("relay listening", {
      url: `ws://${config.host ?? "0.0.0.0"}:${config.port}${RELAY_WS_PATH}`,
      healthz: `http://${config.host ?? "0.0.0.0"}:${config.port}/healthz`,
      max_devices: config.maxDevices,
      static_root: config.staticRoot ?? null,
      debug: config.debug,
    });
  });
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry as string).href;
}

// 只在作为 Node 入口直接执行时启动；被动态 import（如构建产物自检）时不产生副作用。
if (isMainModule()) {
  startRelayServer(readRelayConfig());
}
