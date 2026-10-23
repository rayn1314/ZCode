import { describe, expect, it, vi } from "vitest";

import { VSBuffer } from "@zcode/rpc";
import type { ZCodeAgentConnectionScope } from "@zcode/services";
import {
  SEND_DRAINED_BYTES,
  SEND_SATURATED_BYTES,
  attachSendFlowControl,
  wrapWebSocket,
  type BackpressureSocket,
  type WebSocketLike,
} from "./contract.js";
import { wsBackpressureModule } from "./module.js";

// 契约测试只 import contract 与 module，不知道实现是谁；同一份测试应同时跑真实现与跨进程代理。

/** 只实现 wrapWebSocket 依赖的成员；bufferedAmount 可人为控制以模拟慢消费者。 */
class FakeWebSocket implements WebSocketLike {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: Uint8Array[] = [];
  private readonly listeners = new Map<string, Set<() => void>>();

  on(event: "message", listener: (raw: Buffer | ArrayBuffer | Buffer[]) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
  on(event: string, listener: unknown): unknown {
    const set = this.listeners.get(event) ?? new Set<() => void>();
    set.add(listener as () => void);
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
  return wrapWebSocket(fake, { pollIntervalMs: 1 });
}

describe("ws-backpressure contract", () => {
  it("declares its module manifest", () => {
    expect(wsBackpressureModule.id).toBe("ws-backpressure");
  });

  it("水位是边沿触发且带滞回：越过高水位一次 SAT，回落到低水位以下一次 DRN", () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeWebSocket();
      const socket = wrap(fake);
      const saturated = vi.fn();
      const drained = vi.fn();
      socket.onSaturated(saturated);
      socket.onDrained(drained);

      // 高水位之下不报；SAT 依据是 v4 单帧上限 1MiB、订阅者 flush buffer 上限 1MiB/500ops。
      fake.bufferedAmount = SEND_SATURATED_BYTES - 1;
      socket.write(VSBuffer.fromString("{}"));
      expect(saturated).not.toHaveBeenCalled();

      fake.bufferedAmount = SEND_SATURATED_BYTES;
      socket.write(VSBuffer.fromString("{}"));
      expect(saturated).toHaveBeenCalledTimes(1);
      // 饱和期间不重复触发（边沿，不是电平）。
      socket.write(VSBuffer.fromString("{}"));
      expect(saturated).toHaveBeenCalledTimes(1);

      // 滞回：只有回落到低水位以下才恢复生产。
      fake.bufferedAmount = SEND_DRAINED_BYTES + 1;
      vi.advanceTimersByTime(1);
      expect(drained).not.toHaveBeenCalled();

      fake.bufferedAmount = SEND_DRAINED_BYTES;
      vi.advanceTimersByTime(1);
      expect(drained).toHaveBeenCalledTimes(1);

      // 再次越过高水位 → 再来一次 SAT。
      fake.bufferedAmount = SEND_SATURATED_BYTES;
      socket.write(VSBuffer.fromString("{}"));
      expect(saturated).toHaveBeenCalledTimes(2);
      expect(fake.sent).toHaveLength(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drain 做真：空闲立即完成、有积压要等归零、关闭时收口 resolve", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeWebSocket();
      const socket = wrap(fake);
      // 空闲：没有更多可写，立即完成。
      await expect(socket.drain()).resolves.toBeUndefined();

      fake.bufferedAmount = 1024;
      let settled = false;
      const pending = socket.drain().then(() => {
        settled = true;
      });
      await vi.advanceTimersByTimeAsync(2);
      expect(settled).toBe(false);

      fake.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).resolves.toBeUndefined();

      // 关闭：等待者全部收口（不 reject），避免连接收口后悬挂。
      fake.bufferedAmount = 4096;
      let closedSettled = false;
      const closedPending = socket.drain().then(() => {
        closedSettled = true;
      });
      socket.dispose();
      await vi.advanceTimersByTimeAsync(2);
      await expect(closedPending).resolves.toBeUndefined();
      expect(closedSettled).toBe(true);
      // 收口后不再写进 socket。
      const sentBefore = fake.sent.length;
      socket.write(VSBuffer.fromString("{}"));
      expect(fake.sent).toHaveLength(sentBefore);
    } finally {
      vi.useRealTimers();
    }
  });

  it("流控转发按序串行，close 之后迟到的边沿不再转发", async () => {
    vi.useFakeTimers();
    try {
      const fake = new FakeWebSocket();
      const socket = wrap(fake);
      const order: string[] = [];
      const release: Array<() => void> = [];
      const scope = {
        setTransportFlowState: (state: "saturated" | "drained") =>
          new Promise<void>((resolve) => {
            order.push(state);
            release.push(resolve);
          }),
      } as unknown as ZCodeAgentConnectionScope;
      attachSendFlowControl(socket, () => scope);

      fake.bufferedAmount = SEND_SATURATED_BYTES;
      socket.write(VSBuffer.fromString("{}"));
      fake.bufferedAmount = 0;
      await vi.advanceTimersByTimeAsync(2);

      // 第一个 RPC 还没回，DRN 也不插队。
      expect(order).toEqual(["saturated"]);
      for (const resolve of release.splice(0)) resolve();
      await vi.advanceTimersByTimeAsync(2);
      expect(order).toEqual(["saturated", "drained"]);

      // close 之后的边沿（如迟到的 SAT）不再进入提交链。
      socket.dispose();
      fake.bufferedAmount = SEND_SATURATED_BYTES * 2;
      socket.write(VSBuffer.fromString("{}"));
      await vi.advanceTimersByTimeAsync(2);
      expect(order).toEqual(["saturated", "drained"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
