/**
 * WebSocket 出口的发送背压：真 drain + 发送水位（SAT/DRN）。
 *
 * 背景：`ws` 没有 stdio 那样的 drain 事件，`send()` 也从不等待对端消费。弱网慢消费者
 * 会让服务端的发送队列（`bufferedAmount`）无界增长，堆内存随之失控。这里做两件事：
 * 1. 把 ISocket 的 `drain()` 契约做真（与 `stdio.ts` 的 `writableNeedDrain` 语义对齐）；
 * 2. 把 `bufferedAmount` 的水位边沿交给上层 connection scope → CLI 暂停 flush。
 *
 * 设计、失败语义与不变式见 packages/server/spec/websocket-send-backpressure.md。
 */
import { Emitter, VSBuffer, type Event, type ISocket } from "@zcode/rpc";
import type { ZCodeAgentConnectionScope } from "@zcode/services";

/**
 * 发送高水位：`bufferedAmount` 越过即判定该连接饱和（SAT）。
 *
 * 4MiB 的依据：
 * - v4 单帧上限 1MiB（PROTOCOL_V4_LIMITS.maxFrameBytes），订阅者 flush buffer 上限
 *   1MiB/500ops；正常突发（订阅 ACK 后 staging 释放、整帧 resync）低于该值，不误触发。
 * - SAT→CLI 暂停 flush 是一轮本机 RPC 往返，期间 CLI 已在途的帧仍会继续写入 socket；
 *   高水位必须给这段在途留余量，否则边沿会随每次 flush 抖动。
 */
export const SEND_SATURATED_BYTES = 4 * 1024 * 1024;

/** 发送低水位：饱和后回落到该值以下即报 DRN 恢复生产。取高水位 1/8 形成滞回。 */
export const SEND_DRAINED_BYTES = 512 * 1024;

/** 水位与 drain 探测间隔（ms）。`ws` 无公开 drain 事件，只能轮询 `bufferedAmount`。 */
const DEFAULT_POLL_INTERVAL_MS = 20;

/**
 * wrapWebSocket 只依赖 ws 库的这几个成员，用结构类型描述，便于测试注入 fake，
 * 也避免传输模块反向依赖 @types/ws。
 */
export interface WebSocketLike {
  readonly OPEN: number;
  readyState: number;
  readonly bufferedAmount: number;
  send(data: Uint8Array): void;
  close(): void;
  on(event: "message", listener: (raw: Buffer | ArrayBuffer | Buffer[]) => void): unknown;
  on(event: "close" | "error", listener: () => void): unknown;
}

export interface BackpressureSocket extends ISocket {
  /** `bufferedAmount` 越过发送高水位（边沿触发，饱和期间不重复触发）。 */
  readonly onSaturated: Event<void>;
  /** 饱和后回落到低水位以下（边沿触发）。 */
  readonly onDrained: Event<void>;
}

export interface WrapWebSocketOptions {
  /** 轮询间隔，仅测试注入；生产走默认值。 */
  pollIntervalMs?: number;
}

export function wrapWebSocket(
  ws: WebSocketLike,
  options: WrapWebSocketOptions = {},
): BackpressureSocket {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  const onSaturated = new Emitter<void>();
  const onDrained = new Emitter<void>();

  // close/error 之后不再观测水位、不再接新写入；所有等待者必须在收口时 resolve。
  let closed = false;
  let saturated = false;
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  /** 等待 bufferedAmount 归零的 drain() 调用方。 */
  const drainWaiters = new Set<() => void>();

  const settleDrainWaiters = () => {
    if (drainWaiters.size === 0) return;
    for (const settle of drainWaiters) settle();
    drainWaiters.clear();
  };

  const stopPolling = () => {
    if (pollTimer === null) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const tick = () => {
    if (closed) {
      settleDrainWaiters();
      stopPolling();
      return;
    }
    const bytes = ws.bufferedAmount;
    if (bytes === 0) settleDrainWaiters();
    if (saturated && bytes <= SEND_DRAINED_BYTES) {
      saturated = false;
      onDrained.fire();
    }
    // 探测只为「有 drain 等待者或仍处饱和态」存在；空闲连接不挂定时器。
    if (drainWaiters.size === 0 && !saturated) stopPolling();
  };

  const ensurePolling = () => {
    if (pollTimer !== null || closed) return;
    pollTimer = setInterval(tick, pollIntervalMs);
    // 背压观测用的定时器不得阻止进程退出。
    pollTimer.unref?.();
  };

  const observeWatermark = () => {
    if (closed || saturated) return;
    if (ws.bufferedAmount < SEND_SATURATED_BYTES) return;
    saturated = true;
    onSaturated.fire();
    ensurePolling();
  };

  const shutdown = () => {
    if (closed) return;
    closed = true;
    saturated = false;
    settleDrainWaiters();
    stopPolling();
  };

  ws.on("message", (raw) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    shutdown();
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    shutdown();
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      // 已接 send() 的帧绝不丢：写入本身不做水位拒绝，背压由 SAT 让上游停止生产。
      if (closed || ws.readyState !== ws.OPEN) return;
      ws.send(buffer.buffer);
      observeWatermark();
    },
    end() {
      ws.close();
    },
    drain() {
      if (closed || ws.bufferedAmount === 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        drainWaiters.add(resolve);
        ensurePolling();
      });
    },
    dispose() {
      // 先收口等待者与定时器再关 socket：dispose 后 close 事件可能不再到来。
      shutdown();
      ws.close();
    },
    onSaturated: onSaturated.event,
    onDrained: onDrained.event,
  };
}

export interface AttachSendFlowControlOptions {
  /** SAT/DRN 转发到 scope 失败时的告警回调；失败只降级为现状（无界），不阻塞连接。 */
  onForwardError?: (state: "saturated" | "drained", error: unknown) => void;
}

/**
 * 把 socket 的 SAT/DRN 边沿串行转成 connection scope 的传输流控
 * （scope → `setConnectionFlowStateV4` RPC → CLI gateway 暂停该 connectionId 的 flush）。
 *
 * 与 desktop host 的 MessagePort `onFlowState` 转发同构：边沿可能快速交替，必须按序
 * 提交；close 之后不允许迟到的 SAT 复活 CLI pause（scope 自身对 disposed/closed 也再兜一层）。
 * resolveScope 用 getter 注入，是因为 scope 的创建晚于 socket 包装。
 */
export function attachSendFlowControl(
  socket: BackpressureSocket,
  resolveScope: () => ZCodeAgentConnectionScope | undefined,
  options: AttachSendFlowControlOptions = {},
): void {
  let closed = false;
  let chain = Promise.resolve();
  const forward = (state: "saturated" | "drained"): Promise<void> => {
    const scope = resolveScope();
    if (closed || !scope) return Promise.resolve();
    const update = chain.then(() => scope.setTransportFlowState(state));
    // 快速 SAT→DRN 必须保持提交顺序；单次 RPC 失败不打断后续 edge 的提交。
    chain = update.catch((error) => options.onForwardError?.(state, error));
    return update;
  };
  socket.onSaturated(() => {
    void forward("saturated").catch(() => {});
  });
  socket.onDrained(() => {
    void forward("drained").catch(() => {});
  });
  socket.onClose(() => {
    closed = true;
  });
}
