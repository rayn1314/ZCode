import { describe, expect, it } from "vitest";
import type { WebRemoteControlRelayIncomingMessage } from "@zcode/shared";

const DEVICE_META = { platform: "win32", version: "test", name: "test-desktop" };
const TERMINAL_META = { platform: "web", version: "test", name: "test-mobile" };
const PASS_HASH = "dGVzdF9oYXNo";

/** 只实现 hub 依赖的 send / close；不起真实 HTTP 与 WebSocket。 */
class FakeRelaySocket {
  readonly sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  messages(): WebRemoteControlRelayIncomingMessage[] {
    return this.sent.map((raw) => JSON.parse(raw) as WebRemoteControlRelayIncomingMessage);
  }

  lastMessage(): WebRemoteControlRelayIncomingMessage {
    const messages = this.messages();
    const last = messages[messages.length - 1];
    if (!last) {
      throw new Error("socket received no relay message");
    }
    return last;
  }

  /** 最近一次 auth_challenge 的 nonce；客户端据此计算 proof。 */
  lastNonce(): string {
    for (let index = this.sent.length - 1; index >= 0; index -= 1) {
      const raw = this.sent[index];
      const message = JSON.parse(raw ?? "{}") as WebRemoteControlRelayIncomingMessage;
      if (message.type === "auth_challenge") {
        return message.nonce;
      }
    }
    throw new Error("socket received no auth_challenge");
  }
}

type HubModule = typeof import("../src/relay/webRemoteControlRelayHub.js");
type AuthModule = typeof import("../src/relay/relayAuth.js");

let hubModulePromise: Promise<HubModule> | undefined;
let authModulePromise: Promise<AuthModule> | undefined;

function loadHubModule(): Promise<HubModule> {
  hubModulePromise ??= import("../src/relay/webRemoteControlRelayHub.js");
  return hubModulePromise;
}

function loadAuthModule(): Promise<AuthModule> {
  authModulePromise ??= import("../src/relay/relayAuth.js");
  return authModulePromise;
}

function createHub(HubClass: HubModule["WebRemoteControlRelayHub"]) {
  let serial = 0;
  return new HubClass({
    now: () => 1_700_000_000_000,
    createId: () => `id-${++serial}`,
  });
}

async function registerDevice(
  hub: HubModule["WebRemoteControlRelayHub"],
  socket: FakeRelaySocket,
): Promise<string> {
  hub.handleMessage(
    socket,
    JSON.stringify({
      type: "device_register_init",
      device_mid: "mid-1",
      pass_hash: PASS_HASH,
      meta: DEVICE_META,
      client_ts: 1,
    }),
  );
  const ack = socket.lastMessage();
  expect(ack.type).toBe("device_register_ack");
  if (ack.type !== "device_register_ack") {
    throw new Error("expected device_register_ack");
  }
  return ack.device_sid;
}

async function authenticate(
  hub: HubModule["WebRemoteControlRelayHub"],
  socket: FakeRelaySocket,
  role: "device" | "terminal",
  deviceSid: string,
): Promise<WebRemoteControlRelayIncomingMessage> {
  const { calculateRelayProof } = await loadAuthModule();
  hub.handleMessage(
    socket,
    JSON.stringify({
      type: "auth_init",
      role,
      device_sid: deviceSid,
      meta: role === "device" ? DEVICE_META : TERMINAL_META,
      client_ts: 2,
    }),
  );
  const nonce = socket.lastNonce();
  hub.handleMessage(
    socket,
    JSON.stringify({
      type: "auth_response",
      device_sid: deviceSid,
      proof: calculateRelayProof(PASS_HASH, nonce, role, deviceSid),
      client_ts: 3,
    }),
  );
  return socket.lastMessage();
}

function queryPairStatus(
  hub: HubModule["WebRemoteControlRelayHub"],
  socket: FakeRelaySocket,
  deviceSid: string,
): void {
  hub.handleMessage(socket, JSON.stringify({ type: "pair_status_query", device_sid: deviceSid }));
}

describe("web remote control relay hub", () => {
  it("A1 配对：device 注册→auth→waiting；terminal 接入→matched；双向 data 逐字节透传", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    const hub = createHub(WebRemoteControlRelayHub);
    const deviceSocket = new FakeRelaySocket();
    const terminalSocket = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);
    hub.handleConnection(terminalSocket);

    const deviceSid = await registerDevice(hub, deviceSocket);
    expect(deviceSid.startsWith("dvc_")).toBe(true);

    expect(await authenticate(hub, deviceSocket, "device", deviceSid)).toMatchObject({
      type: "auth_ack",
      pair_status: "waiting",
    });
    queryPairStatus(hub, deviceSocket, deviceSid);
    expect(deviceSocket.lastMessage()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });

    expect(await authenticate(hub, terminalSocket, "terminal", deviceSid)).toMatchObject({
      type: "auth_ack",
      pair_status: "matched",
    });
    queryPairStatus(hub, deviceSocket, deviceSid);
    expect(deviceSocket.lastMessage()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "matched",
    });
    queryPairStatus(hub, terminalSocket, deviceSid);
    expect(terminalSocket.lastMessage()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "matched",
    });

    // payload 对 relay 是 opaque：含中文与高位字节的负载必须原样抵达对端。
    const deviceFrame = JSON.stringify({
      type: "data",
      payload: {
        zcode_type: "rpc-frame",
        bridgeSessionId: "bridge-1",
        seq: 1,
        messageSeq: 1,
        fragmentIndex: 0,
        fragmentCount: 1,
        dataBase64: "AAH/fg==",
        note: "中文 opaque 负载 🚀",
      },
      client_ts: 10,
    });
    const terminalFramesBefore = terminalSocket.sent.length;
    hub.handleMessage(deviceSocket, deviceFrame);
    expect(terminalSocket.sent).toHaveLength(terminalFramesBefore + 1);
    expect(terminalSocket.sent[terminalFramesBefore]).toBe(deviceFrame);

    const terminalFrame = JSON.stringify({
      type: "data",
      payload: {
        zcode_type: "rpc-frame-ack",
        bridgeSessionId: "bridge-1",
        seq: 1,
        bytes: [0, 1, 127, 128, 255],
        note: "手机回传",
      },
      client_ts: 11,
    });
    const deviceFramesBefore = deviceSocket.sent.length;
    hub.handleMessage(terminalSocket, terminalFrame);
    expect(deviceSocket.sent[deviceFramesBefore]).toBe(terminalFrame);
  });

  it("A3 单 terminal：第二个 terminal 顶替旧 terminal，旧 terminal 收到 KICKED 且被断开", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    const hub = createHub(WebRemoteControlRelayHub);
    const deviceSocket = new FakeRelaySocket();
    const firstTerminal = new FakeRelaySocket();
    const secondTerminal = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);
    hub.handleConnection(firstTerminal);
    hub.handleConnection(secondTerminal);

    const deviceSid = await registerDevice(hub, deviceSocket);
    await authenticate(hub, deviceSocket, "device", deviceSid);
    expect(await authenticate(hub, firstTerminal, "terminal", deviceSid)).toMatchObject({
      pair_status: "matched",
    });

    expect(await authenticate(hub, secondTerminal, "terminal", deviceSid)).toMatchObject({
      type: "auth_ack",
      pair_status: "matched",
    });
    expect(firstTerminal.lastMessage()).toMatchObject({ type: "error", code: "KICKED" });
    expect(firstTerminal.closed).toBe(true);

    // 被顶替的连接后续帧直接忽略，data 只发给新 terminal。
    const framesBefore = firstTerminal.sent.length;
    queryPairStatus(hub, firstTerminal, deviceSid);
    expect(firstTerminal.sent).toHaveLength(framesBefore);

    const frame = JSON.stringify({
      type: "data",
      payload: { zcode_type: "mobile-diagnostic", event: "pair-status" },
      client_ts: 12,
    });
    hub.handleMessage(deviceSocket, frame);
    expect(secondTerminal.sent[secondTerminal.sent.length - 1]).toBe(frame);
  });

  it("A6 不透传失败：未配对时 data 被丢弃，不缓存不排队", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    const hub = createHub(WebRemoteControlRelayHub);
    const deviceSocket = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);

    const deviceSid = await registerDevice(hub, deviceSocket);
    await authenticate(hub, deviceSocket, "device", deviceSid);

    const framesBefore = deviceSocket.sent.length;
    hub.handleMessage(
      deviceSocket,
      JSON.stringify({
        type: "data",
        payload: { zcode_type: "bootstrap-request", requestId: "request-1" },
        client_ts: 13,
      }),
    );
    // 静默丢弃：没有 error、没有缓存，帧数不变。
    expect(deviceSocket.sent).toHaveLength(framesBefore);

    // 未认证连接的 data 同样丢弃。
    const anonymousSocket = new FakeRelaySocket();
    hub.handleConnection(anonymousSocket);
    hub.handleMessage(
      anonymousSocket,
      JSON.stringify({ type: "data", payload: { requestId: "request-2" }, client_ts: 14 }),
    );
    expect(anonymousSocket.sent).toHaveLength(0);

    // terminal 接入后设备侧 data 正常送达，证明此前丢弃不是延迟投递。
    const terminalSocket = new FakeRelaySocket();
    hub.handleConnection(terminalSocket);
    await authenticate(hub, terminalSocket, "terminal", deviceSid);
    const frame = JSON.stringify({
      type: "data",
      payload: { zcode_type: "workspace-list-request", requestId: "request-3" },
      client_ts: 15,
    });
    hub.handleMessage(deviceSocket, frame);
    expect(terminalSocket.sent[terminalSocket.sent.length - 1]).toBe(frame);
  });

  it("device 瞬断：terminal 的 data 得到 INTERNAL 且保持连接，持久化 sid 重连即恢复 matched", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    const hub = createHub(WebRemoteControlRelayHub);
    const deviceSocket = new FakeRelaySocket();
    const terminalSocket = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);
    hub.handleConnection(terminalSocket);

    const deviceSid = await registerDevice(hub, deviceSocket);
    await authenticate(hub, deviceSocket, "device", deviceSid);
    await authenticate(hub, terminalSocket, "terminal", deviceSid);

    hub.handleDisconnect(deviceSocket);
    const framesBefore = terminalSocket.sent.length;
    hub.handleMessage(
      terminalSocket,
      JSON.stringify({ type: "data", payload: { zcode_type: "app-error" }, client_ts: 16 }),
    );
    expect(terminalSocket.sent).toHaveLength(framesBefore + 1);
    expect(terminalSocket.lastMessage()).toMatchObject({ type: "error", code: "INTERNAL" });
    expect(terminalSocket.closed).toBe(false);

    queryPairStatus(hub, terminalSocket, deviceSid);
    expect(terminalSocket.lastMessage()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });

    // relay 未重启：桌面用持久化 device_sid 直接重连，手机不必重新扫码。
    const reconnectedSocket = new FakeRelaySocket();
    hub.handleConnection(reconnectedSocket);
    expect(await authenticate(hub, reconnectedSocket, "device", deviceSid)).toMatchObject({
      type: "auth_ack",
      pair_status: "matched",
    });
    queryPairStatus(hub, terminalSocket, deviceSid);
    expect(terminalSocket.lastMessage()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "matched",
    });
  });

  it("错误码：缺字段 WRONG_PARAM 且连接保持；device sid 未注册时 device 得 AUTH_FAILED、terminal 得 DEVICE_OFFLINE", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    const hub = createHub(WebRemoteControlRelayHub);
    const deviceSocket = new FakeRelaySocket();
    const terminalSocket = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);
    hub.handleConnection(terminalSocket);

    hub.handleMessage(
      deviceSocket,
      JSON.stringify({ type: "auth_init", role: "device", meta: DEVICE_META }),
    );
    expect(deviceSocket.lastMessage()).toMatchObject({ type: "error", code: "WRONG_PARAM" });
    expect(deviceSocket.closed).toBe(false);

    hub.handleMessage(
      deviceSocket,
      JSON.stringify({
        type: "auth_init",
        role: "device",
        device_sid: "dvc_missing",
        meta: DEVICE_META,
      }),
    );
    expect(deviceSocket.lastMessage()).toMatchObject({ type: "error", code: "AUTH_FAILED" });

    hub.handleMessage(
      terminalSocket,
      JSON.stringify({
        type: "auth_init",
        role: "terminal",
        device_sid: "dvc_missing",
        meta: TERMINAL_META,
      }),
    );
    expect(terminalSocket.lastMessage()).toMatchObject({ type: "error", code: "DEVICE_OFFLINE" });
  });

  it("terminal 断开即解除配对：device 回到 waiting，新 terminal 可直接接入", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    const hub = createHub(WebRemoteControlRelayHub);
    const deviceSocket = new FakeRelaySocket();
    const terminalSocket = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);
    hub.handleConnection(terminalSocket);

    const deviceSid = await registerDevice(hub, deviceSocket);
    await authenticate(hub, deviceSocket, "device", deviceSid);
    await authenticate(hub, terminalSocket, "terminal", deviceSid);

    hub.handleDisconnect(terminalSocket);
    queryPairStatus(hub, deviceSocket, deviceSid);
    expect(deviceSocket.lastMessage()).toMatchObject({
      type: "pair_status_ack",
      pair_status: "waiting",
    });

    // 已断开 terminal 的帧被忽略，data 不再透传。
    const framesBefore = terminalSocket.sent.length;
    hub.handleMessage(
      terminalSocket,
      JSON.stringify({ type: "data", payload: { requestId: "stale" }, client_ts: 21 }),
    );
    expect(terminalSocket.sent).toHaveLength(framesBefore);

    const nextTerminal = new FakeRelaySocket();
    hub.handleConnection(nextTerminal);
    expect(await authenticate(hub, nextTerminal, "terminal", deviceSid)).toMatchObject({
      type: "auth_ack",
      pair_status: "matched",
    });
  });

  it("logger 未提供 debug 时 data 转发不抛错（debug 是可选回调，必须可选调用）", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    let serial = 0;
    const hub = new WebRemoteControlRelayHub({
      now: () => 1_700_000_000_000,
      createId: () => `id-${++serial}`,
      // 与 entry-relay 关闭 ZCODE_RELAY_DEBUG 时的形态一致：没有 debug 成员。
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const deviceSocket = new FakeRelaySocket();
    const terminalSocket = new FakeRelaySocket();
    hub.handleConnection(deviceSocket);
    hub.handleConnection(terminalSocket);

    const deviceSid = await registerDevice(hub, deviceSocket);
    await authenticate(hub, deviceSocket, "device", deviceSid);
    await authenticate(hub, terminalSocket, "terminal", deviceSid);

    const frame = JSON.stringify({
      type: "data",
      payload: { zcode_type: "mobile-diagnostic", event: "pair-status" },
      client_ts: 20,
    });
    expect(() => hub.handleMessage(deviceSocket, frame)).not.toThrow();
    expect(terminalSocket.sent[terminalSocket.sent.length - 1]).toBe(frame);
  });

  it("设备数超限返回 INTERNAL，同 device_mid 重复注册作废旧 sid", async () => {
    const { WebRemoteControlRelayHub } = await loadHubModule();
    let serial = 0;
    const hub = new WebRemoteControlRelayHub({
      maxDevices: 1,
      now: () => 1_700_000_000_000,
      createId: () => `id-${++serial}`,
    });

    const firstSocket = new FakeRelaySocket();
    hub.handleConnection(firstSocket);
    const firstSid = await registerDevice(hub, firstSocket);

    const secondSocket = new FakeRelaySocket();
    hub.handleConnection(secondSocket);
    hub.handleMessage(
      secondSocket,
      JSON.stringify({
        type: "device_register_init",
        device_mid: "mid-2",
        pass_hash: PASS_HASH,
        meta: DEVICE_META,
      }),
    );
    expect(secondSocket.lastMessage()).toMatchObject({ type: "error", code: "INTERNAL" });

    // 同一 device_mid 重新注册：旧 socket 被断开，旧 sid 失效。
    const replacementSocket = new FakeRelaySocket();
    hub.handleConnection(replacementSocket);
    const replacementSid = await registerDevice(hub, replacementSocket);
    expect(replacementSid).not.toBe(firstSid);
    expect(firstSocket.closed).toBe(true);

    hub.handleMessage(
      firstSocket,
      JSON.stringify({ type: "pair_status_query", device_sid: firstSid }),
    );
    expect(firstSocket.sent).toHaveLength(1);
  });
});
