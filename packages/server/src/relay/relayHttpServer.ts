import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS, formatLogPrefix } from "@zcode/shared";
import {
  WebRemoteControlRelayHub,
  type WebRemoteControlRelayLogger,
  type WebRemoteControlRelaySocket,
} from "./webRemoteControlRelayHub.js";
import { createRelayStaticAssetResponder } from "./relayStaticAssets.js";

/**
 * 自建 Web 远程控制 relay 的服务端引导：node:http + ws 的盲转发 broker，不引入 Hono。
 *
 * 这份实现被两处共用，保证独立部署与桌面进程内托管行为逐字节一致：
 * - packages/server/src/entry-relay.ts（命令行 / 独立进程，VPS 或自建常驻机器）
 * - packages/desktop/src/main/webRemoteControlRelayHost.ts（桌面进程内托管，局域网默认路径）
 *
 * 契约见 packages/server/spec/web-remote-control-relay.md。
 */

const RELAY_WS_PATH = "/ws";
export const RELAY_DEFAULT_MAX_DEVICES = 64;

export interface WebRemoteControlRelayHttpServerConfig {
  port: number;
  /** 不传则绑定 0.0.0.0（独立部署）；桌面进程内必须显式绑定局域网地址。 */
  host?: string;
  /** 指向 PWA 产物根目录时顺带托管静态资源（SPA fallback）。 */
  staticRoot?: string;
  maxDevices: number;
  debug: boolean;
  /** 日志接收方；不传则不输出。桌面进程内传 createServiceLogger 风格的宿主日志器。 */
  logger?: Partial<WebRemoteControlRelayLogger>;
}

export interface WebRemoteControlRelayHttpServerHandle {
  hub: WebRemoteControlRelayHub;
  /** 实际绑定端口。传 port=0 由内核分配时，调用方用它推导对外地址。 */
  readonly port: number;
  close(): Promise<void>;
}

export function createSilentRelayLogger(): WebRemoteControlRelayLogger {
  return { info: () => {}, warn: () => {}, error: () => {}, debug: undefined };
}

export function rawDataByteLength(raw: RawData): number {
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

export function rawDataToText(raw: RawData): string {
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

/**
 * 创建并监听 relay 服务。返回的 handle.port 是内核实际分配的端口（config.port 传 0 时
 * 由内核挑一个空闲口），调用方必须用它推导二维码里的地址，不能假设 config.port。
 */
export function createWebRemoteControlRelayHttpServer(
  config: WebRemoteControlRelayHttpServerConfig,
): Promise<WebRemoteControlRelayHttpServerHandle> {
  const logger: WebRemoteControlRelayLogger = {
    info: config.logger?.info ?? (() => {}),
    warn: config.logger?.warn ?? (() => {}),
    error: config.logger?.error ?? (() => {}),
    debug: config.logger?.debug,
  };

  const hub = new WebRemoteControlRelayHub({ maxDevices: config.maxDevices, logger });
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
    logger.info("relay client connected", { device_mid: deviceMidHint });

    socket.on("message", (raw: RawData) => {
      const bytes = rawDataByteLength(raw);
      if (bytes > WEB_REMOTE_CONTROL_RPC_TRANSPORT_LIMITS.maxPhysicalFrameBytes) {
        logger.warn("relay frame exceeds physical limit, closing", {
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
      logger.warn("relay client socket error", {
        message: error.message,
        device_mid: deviceMidHint,
      });
    });

    socket.on("close", () => {
      hub.handleDisconnect(relaySocket);
      logger.info("relay client disconnected", { device_mid: deviceMidHint });
    });
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.on("error", onError);
    server.listen(config.port, config.host, () => {
      server.off("error", onError);
      const address = server.address();
      const actualPort =
        typeof address === "object" && address !== null ? address.port : config.port;
      resolve({
        hub,
        port: actualPort,
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            for (const client of wss.clients) {
              client.terminate();
            }
            server.close((error) => (error ? rejectClose(error) : resolveClose()));
          }),
      });
    });
  });
}

export function createRelayConsoleLogger(pid: number): WebRemoteControlRelayLogger {
  const log = (...args: unknown[]) => console.log(formatLogPrefix("zcode-relay", pid), ...args);
  const logWarn = (...args: unknown[]) =>
    console.warn(formatLogPrefix("zcode-relay", pid), ...args);
  const logError = (...args: unknown[]) =>
    console.error(formatLogPrefix("zcode-relay", pid), ...args);
  return { info: log, warn: logWarn, error: logError, debug: undefined };
}
