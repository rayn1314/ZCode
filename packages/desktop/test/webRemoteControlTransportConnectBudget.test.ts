import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  WEB_REMOTE_CONTROL_MAX_INITIAL_CONNECT_ATTEMPTS,
  type WebRemoteControlAppPayload,
} from "@zcode/shared";
import {
  WebRemoteControlDeviceTransport,
  type WebRemoteControlDeviceTransportState,
} from "../src/main/webRemoteControlTransport.js";

const servers: WebSocketServer[] = [];

function waitUntil(assertion: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const tick = () => {
      if (assertion()) {
        resolve();
        return;
      }
      if (Date.now() - startedAt > timeoutMs) {
        reject(new Error("Timed out waiting for assertion"));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function createAuthProvider() {
  return {
    createPassword: () => "password",
    createPassHash: () => "hash-1",
    calculateProof: () => "proof",
  };
}

function createTransport(options: {
  relayUrl: string;
  states: WebRemoteControlDeviceTransportState[];
  errors: Error[];
  reconnectDelayMs: number;
}) {
  const logger = createLogger();
  return {
    logger,
    transport: new WebRemoteControlDeviceTransport({
      relayWsUrl: options.relayUrl,
      deviceMid: "mid-1",
      auth: { mode: "persisted", deviceSid: "sid-1", passHash: "hash-1" },
      meta: { platform: "win32", version: "1.0.0", name: "PC" },
      authProvider: createAuthProvider(),
      logger,
      reconnectDelayMs: options.reconnectDelayMs,
      reconnectJitterMs: 0,
      onRegisteredAuth: () => {},
      onStateChange: (state) => options.states.push(state),
      onPayload: (payload: WebRemoteControlAppPayload) => payload.consumed,
      onError: (error) => options.errors.push(error),
      onInvalidPersistedAuth: async () => {},
    }),
  };
}

/** 数实际发起的连接次数：重试期间 state 一直是 connecting，只按 state 计数会漏计。 */
function countConnectAttempts(logger: { info: ReturnType<typeof vi.fn> }): number {
  return logger.info.mock.calls.filter((call) =>
    call.some((arg) => String(arg).includes("external relay device connecting")),
  ).length;
}

/** 起一个监听端口的 relay，再把端口释放出来，得到“一定没人监听”的地址。 */
async function reserveClosedRelayPort(): Promise<string> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `ws://127.0.0.1:${port}/ws`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (server.clients.size > 0) {
            for (const client of server.clients) {
              client.terminate();
            }
          }
          server.close(() => resolve());
        }),
    ),
  );
});

describe("WebRemoteControlDeviceTransport 连接预算", () => {
  it("relay 从未可达时重试有上限，耗尽后停在 error 并说明该如何处置", async () => {
    const relayUrl = await reserveClosedRelayPort();
    const states: WebRemoteControlDeviceTransportState[] = [];
    const errors: Error[] = [];
    const transport = createTransport({ relayUrl, states, errors, reconnectDelayMs: 5 }).transport;

    transport.start();

    await waitUntil(() => states.includes("error"));

    const message = errors.at(-1)?.message ?? "";
    expect(message).toContain(relayUrl);
    // 文案必须能自助处置：指出外部中转的配置入口，而不是只报“无法启动”。
    expect(message).toContain("ZCODE_WEB_REMOTE_CONTROL_RELAY_WS_URL");

    const connectAttempts = states.filter((state) => state === "connecting").length;
    expect(connectAttempts).toBeLessThanOrEqual(WEB_REMOTE_CONTROL_MAX_INITIAL_CONNECT_ATTEMPTS);

    // 停在 error 后不再自我重启：这是“错误可见”与“一直启动中”的分界。
    const settledCount = states.length;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(states.length).toBe(settledCount);

    transport.dispose();
  });

  it("relay 启动慢于桌面时不会因预算耗尽被误判成失败", async () => {
    const relayUrl = await reserveClosedRelayPort();
    const states: WebRemoteControlDeviceTransportState[] = [];
    const errors: Error[] = [];
    // 拉大重连间隔，确保预算耗尽前 relay 有机会起来，验证预算只拦“真的连不上”。
    const transport = createTransport({
      relayUrl,
      states,
      errors,
      reconnectDelayMs: 120,
    }).transport;

    transport.start();
    await waitUntil(() => states.includes("connecting") && errors.length >= 1);

    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const livePort = (server.address() as { port: number }).port;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string };
        if (message.type === "auth_init") {
          socket.send(
            JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
          );
        }
      });
    });

    const live = createTransport({
      relayUrl: `ws://127.0.0.1:${livePort}/ws`,
      states,
      errors,
      reconnectDelayMs: 120,
    });
    live.transport.start();

    await waitUntil(() => states.includes("paired"));
    expect(states).not.toContain("error");

    live.transport.dispose();
  });

  it("连上过 relay 之后不再受预算限制，短抖动仍可无限重连", async () => {
    const server = new WebSocketServer({ port: 0 });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as { port: number }).port;
    server.on("connection", (socket) => {
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { type: string };
        if (message.type === "auth_init") {
          socket.send(
            JSON.stringify({ type: "auth_ack", device_sid: "sid-1", pair_status: "matched" }),
          );
        }
      });
    });

    const states: WebRemoteControlDeviceTransportState[] = [];
    const errors: Error[] = [];
    const { logger, transport } = createTransport({
      relayUrl: `ws://127.0.0.1:${port}/ws`,
      states,
      errors,
      reconnectDelayMs: 5,
    });
    transport.start();
    await waitUntil(() => states.includes("paired"));

    // relay 消失：已配对会话靠无限重连等手机拿旧二维码回来，不能被预算拦成永久失败。
    await new Promise<void>((resolve) => {
      for (const client of server.clients) {
        client.terminate();
      }
      server.close(() => resolve());
    });

    await waitUntil(
      () => countConnectAttempts(logger) > WEB_REMOTE_CONTROL_MAX_INITIAL_CONNECT_ATTEMPTS + 1,
    );
    expect(states).not.toContain("error");

    transport.dispose();
  });
});
