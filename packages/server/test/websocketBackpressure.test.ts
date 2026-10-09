import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { WebSocket, WebSocketServer } from "ws";
import { VSBuffer } from "@zcode/rpc";
import type { ZCodeAgentConnectionScope } from "@zcode/services";
import {
  SEND_DRAINED_BYTES,
  SEND_SATURATED_BYTES,
  attachSendFlowControl,
  wrapWebSocket,
  type BackpressureSocket,
} from "../src/websocketBackpressure.js";

const POLL_MS = 5;

/** 只实现 wrapWebSocket 依赖的成员；bufferedAmount 可人为控制以模拟慢消费者。 */
class FakeWebSocket {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  on(event: string, listener: () => void): this {
    const set = this.listeners.get(event) ?? new Set();
    set.add(listener);
    this.listeners.set(event, set);
    return this;
  }

  send(data: Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }

  emit(event: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }
}

function wrap(fake: FakeWebSocket): BackpressureSocket {
  return wrapWebSocket(fake, { pollIntervalMs: POLL_MS });
}

/** 断言 promise 在预算内完成，避免实现挂死时测试无限等待。 */
async function withTimeout<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`promise 超过 ${ms}ms 未完成`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("drain 在已连接且无积压的 socket 上立即 resolve", async () => {
  const fake = new FakeWebSocket();
  const socket = wrap(fake);
  await withTimeout(socket.drain());
});

test("drain 在 bufferedAmount>0 时挂起，归零后由轮询收口 resolve", async () => {
  const fake = new FakeWebSocket();
  fake.bufferedAmount = 1024;
  const socket = wrap(fake);

  let drained = false;
  const pending = socket.drain().then(() => {
    drained = true;
  });
  await sleep(3 * POLL_MS);
  assert.equal(drained, false, "bufferedAmount 未归零时 drain 不得提前 resolve");

  fake.bufferedAmount = 0;
  await withTimeout(pending);
  assert.equal(drained, true);
});

test("drain 挂起期间连接关闭必须收口 resolve", async () => {
  const fake = new FakeWebSocket();
  fake.bufferedAmount = 4096;
  const socket = wrap(fake);
  const pending = socket.drain();
  await sleep(POLL_MS);
  fake.close();
  await withTimeout(pending);
});

test("非 OPEN 状态的 write 不写入 socket", () => {
  const fake = new FakeWebSocket();
  const socket = wrap(fake);
  fake.readyState = 3;
  socket.write(VSBuffer.alloc(8));
  assert.equal(fake.sent.length, 0);
});

test("水位状态机：4MiB SAT / 512KiB DRN 边沿触发各一次", async () => {
  const fake = new FakeWebSocket();
  const socket = wrap(fake);
  const saturated: number[] = [];
  const drained: number[] = [];
  socket.onSaturated(() => saturated.push(Date.now()));
  socket.onDrained(() => drained.push(Date.now()));

  // 低于高水位的正常写入不触发 SAT。
  fake.bufferedAmount = SEND_SATURATED_BYTES - 1;
  socket.write(VSBuffer.alloc(16));
  await sleep(3 * POLL_MS);
  assert.equal(saturated.length, 0);

  // 越过高水位触发一次 SAT；饱和期间继续写入不重复触发。
  fake.bufferedAmount = SEND_SATURATED_BYTES;
  socket.write(VSBuffer.alloc(16));
  socket.write(VSBuffer.alloc(16));
  await sleep(3 * POLL_MS);
  assert.equal(saturated.length, 1);
  assert.equal(drained.length, 0);

  // 回落但仍高于低水位 → 不 DRN。
  fake.bufferedAmount = SEND_DRAINED_BYTES + 1;
  await sleep(3 * POLL_MS);
  assert.equal(drained.length, 0);

  // 回落到低水位 → 恰好一次 DRN。
  fake.bufferedAmount = SEND_DRAINED_BYTES;
  await sleep(3 * POLL_MS);
  assert.equal(drained.length, 1);
  assert.equal(saturated.length, 1);

  // 再次越过高水位重新 SAT（滞回后可再次进入饱和）。
  fake.bufferedAmount = SEND_SATURATED_BYTES;
  socket.write(VSBuffer.alloc(16));
  await sleep(3 * POLL_MS);
  assert.equal(saturated.length, 2);
  assert.equal(drained.length, 1);
});

test("dispose 收口：挂起的 drain resolve，此后不再写入", async () => {
  const fake = new FakeWebSocket();
  fake.bufferedAmount = 2048;
  const socket = wrap(fake);
  const pending = socket.drain();
  await sleep(POLL_MS);
  socket.dispose();
  await withTimeout(pending);
  fake.readyState = 1;
  socket.write(VSBuffer.alloc(8));
  assert.equal(fake.sent.length, 0, "dispose 后不得再写 socket");
});

test("attachSendFlowControl 把 SAT/DRN 边沿按序转给 connection scope", async () => {
  const fake = new FakeWebSocket();
  const socket = wrap(fake);
  const states: string[] = [];
  let resolveScope: ZCodeAgentConnectionScope | undefined = {
    service: undefined as never,
    setTransportFlowState(state) {
      states.push(state);
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  };
  attachSendFlowControl(socket, () => resolveScope);

  fake.bufferedAmount = SEND_SATURATED_BYTES;
  socket.write(VSBuffer.alloc(16));
  fake.bufferedAmount = SEND_DRAINED_BYTES;
  await sleep(4 * POLL_MS);
  assert.deepEqual(states, ["saturated", "drained"]);

  // scope 缺席（无 agent service）时空转，不抛错。
  resolveScope = undefined;
  fake.bufferedAmount = SEND_SATURATED_BYTES;
  socket.write(VSBuffer.alloc(16));
  await sleep(3 * POLL_MS);
  assert.deepEqual(states, ["saturated", "drained"]);
});

test("连接关闭后不再向 scope 转发新的流控状态", async () => {
  const fake = new FakeWebSocket();
  const socket = wrap(fake);
  const states: string[] = [];
  const scope: ZCodeAgentConnectionScope = {
    service: undefined as never,
    setTransportFlowState(state) {
      states.push(state);
      return Promise.resolve();
    },
    dispose: () => Promise.resolve(),
  };
  attachSendFlowControl(socket, () => scope);

  fake.bufferedAmount = SEND_SATURATED_BYTES;
  socket.write(VSBuffer.alloc(16));
  await sleep(3 * POLL_MS);
  assert.deepEqual(states, ["saturated"]);

  fake.close();
  // 关闭后 write 被拒（readyState≠OPEN），不再产生边沿；scope 不会收到复活的 SAT。
  fake.readyState = 1;
  fake.bufferedAmount = SEND_SATURATED_BYTES;
  socket.write(VSBuffer.alloc(16));
  await sleep(3 * POLL_MS);
  assert.deepEqual(states, ["saturated"]);
});

test("真实 ws 连接上 drain 立即 resolve（契约与 stdio 对齐）", async () => {
  const wss = new WebSocketServer({ port: 0 });
  try {
    const address = wss.address();
    assert.ok(address && typeof address === "object");
    const accepted = new Promise<WebSocket>((resolve) => wss.once("connection", resolve));
    const client = new WebSocket(`ws://127.0.0.1:${address.port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", resolve);
      client.once("error", reject);
    });
    const serverSide = await accepted;
    const socket = wrapWebSocket(serverSide);
    await withTimeout(socket.drain());
    client.close();
    socket.dispose();
  } finally {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  }
});
