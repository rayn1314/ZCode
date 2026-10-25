/**
 * 进程级并发治理器（docs/dynamic-workflow/concurrency.md「The governor」）：AIMD 按 provider key
 * 分桶、**每个模型请求**准入（tryAdmit 快路径 / admit 排队）、run 间轮转、ticket 上的状态事件映射与去重、
 * epoch 阻尼、cap 变化扇出、Retry-After 冷却唤醒、空闲重置、主代理 observer。控制器用真的（纯 AIMD
 * 状态机），时钟与定时器注入。另有一层 provider 硬上限闸门（`requestPolicy.maxConcurrent`）跨模型桶
 * 结算，见文件末尾的用例。
 */

import { describe, expect, it } from "vitest";
import type {
  ModelNetworkStatusEvent,
  ModelRef,
  ModelRequestAdmissionTicket,
} from "@zcode/contracts";
import type { ConcurrencyChange } from "@zcode/dynamic-workflow";
import {
  createWorkflowConcurrencyGovernor,
  workflowConcurrencyKey,
} from "../src/app/workflow-concurrency-governor.js";
import type { ProviderConcurrencySharedView } from "../src/app/provider-concurrency-shared.js";
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_DEFAULT_CONCURRENCY_MAX,
} from "../src/app/workflow-default-concurrency.js";

const MODEL_A = { providerId: "prov", modelId: "alpha" } as unknown as ModelRef;
const MODEL_B = { providerId: "prov", modelId: "beta" } as unknown as ModelRef;
const KEY_A = workflowConcurrencyKey(MODEL_A);
const KEY_B = workflowConcurrencyKey(MODEL_B);
const CEILING = 8;

/** 假时钟 + 假定时器：治理器唯一的 I/O 面。 */
function fakeClock() {
  let current = 1_000_000;
  const timers: Array<{ at: number; fire: () => void; cancelled: boolean }> = [];
  return {
    now: () => current,
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { at: current + delayMs, fire: callback, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    /** 推进时钟并触发到期定时器。 */
    advance(ms: number) {
      current += ms;
      for (const entry of [...timers]) {
        if (entry.cancelled || entry.at > current) continue;
        timers.splice(timers.indexOf(entry), 1);
        entry.fire();
      }
    },
    pendingTimers: () => timers.filter((t) => !t.cancelled).length,
  };
}

function statusEvent(
  partial: Partial<ModelNetworkStatusEvent> & { type: ModelNetworkStatusEvent["type"] },
  model: ModelRef = MODEL_A,
): ModelNetworkStatusEvent {
  return {
    timestamp: new Date(0).toISOString(),
    traceId: "trace",
    requestId: "req",
    model,
    transport: "http",
    attempt: 1,
    maxAttempts: 0,
    ...partial,
  } as unknown as ModelNetworkStatusEvent;
}

/** 一次尝试的四种结局，按 runner 实际发出的事件序列喂给 ticket。 */
const outcome = {
  started: (ticket: ModelRequestAdmissionTicket, model = MODEL_A) =>
    ticket.publish(statusEvent({ type: "model_request_started" }, model)),
  completed: (ticket: ModelRequestAdmissionTicket, model = MODEL_A) => {
    outcome.started(ticket, model);
    void ticket.publish(
      statusEvent({ type: "model_request_completed", durationMs: 1 } as never, model),
    );
  },
  /** 一次完整的 429：runner 先发 failed(retryable:true) 再发 retry_scheduled（决策 27 去重的对象）。 */
  throttled429: (ticket: ModelRequestAdmissionTicket, retryAfterMs?: number, model = MODEL_A) => {
    outcome.started(ticket, model);
    void ticket.publish(
      statusEvent(
        {
          type: "model_request_failed",
          reason: "rate_limited",
          retryable: true,
          message: "429",
        } as never,
        model,
      ),
    );
    void ticket.publish(
      statusEvent(
        {
          type: "model_retry_scheduled",
          reason: "rate_limited",
          delayMs: 2000,
          nextAttempt: 2,
          message: "429",
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        } as never,
        model,
      ),
    );
  },
  retryScheduled: (
    ticket: ModelRequestAdmissionTicket,
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    outcome.started(ticket);
    void ticket.publish(
      statusEvent({
        type: "model_retry_scheduled",
        reason,
        delayMs: 1000,
        nextAttempt: 2,
        message: reason,
        ...extra,
      } as never),
    );
  },
  permanent: (ticket: ModelRequestAdmissionTicket) => {
    outcome.started(ticket);
    void ticket.publish(
      statusEvent({
        type: "model_request_failed",
        reason: "auth_failed",
        retryable: false,
        message: "401",
      } as never),
    );
  },
};

function makeGovernor(defaultConcurrency = CEILING) {
  const clock = fakeClock();
  const governor = createWorkflowConcurrencyGovernor({
    defaultConcurrency,
    now: clock.now,
    schedule: clock.schedule,
  });
  /** 快路径必命中（测试前提：闸门开、无人排队），否则测试本身写错。 */
  const admitNow = (runId = "runA", model = MODEL_A): ModelRequestAdmissionTicket => {
    const ticket = governor.tryAdmit(runId, model);
    if (ticket === undefined) throw new Error("tryAdmit unexpectedly missed");
    return ticket;
  };
  /** 主代理路径：observer 立即放行。 */
  const observe = async (model = MODEL_A) => governor.observer().acquire({ model });
  return { clock, governor, admitNow, observe };
}

/** admit 立即结算与否的观察面（不 await 挂起的 promise）。 */
function track(promise: Promise<ModelRequestAdmissionTicket>) {
  const state: { ticket?: ModelRequestAdmissionTicket; error?: unknown; settled: boolean } = {
    settled: false,
  };
  promise.then(
    (ticket) => {
      state.ticket = ticket;
      state.settled = true;
    },
    (error) => {
      state.error = error;
      state.settled = true;
    },
  );
  return state;
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

describe("resolveWorkflowDefaultConcurrency", () => {
  it("地板为 4（双核与四核都是 4），8 核为 6，18 核及以上顶在 16", () => {
    expect(resolveWorkflowDefaultConcurrency(() => 1)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 2)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 4)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 6)).toBe(4);
    expect(resolveWorkflowDefaultConcurrency(() => 8)).toBe(6);
    expect(resolveWorkflowDefaultConcurrency(() => 10)).toBe(8);
    expect(resolveWorkflowDefaultConcurrency(() => 18)).toBe(WORKFLOW_DEFAULT_CONCURRENCY_MAX);
    expect(resolveWorkflowDefaultConcurrency(() => 64)).toBe(16);
  });
});

describe("workflow concurrency governor — 桶与闸门（决策 34）", () => {
  it("首个 run 从天花板起步：ceiling 个 tryAdmit 命中，第 ceiling+1 个未命中并在 admit 里等待", async () => {
    const { governor, admitNow } = makeGovernor();
    const tickets = Array.from({ length: CEILING }, () => admitNow());
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();
    const waiting = track(governor.admit("runA", MODEL_A, new AbortController().signal));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: CEILING, inFlight: CEILING, waiters: 1 });

    // 一次尝试结束（成功）释放名额，唤醒等待者。
    outcome.completed(tickets[0]!);
    await flush();
    expect(waiting.ticket).toBeDefined();
    expect(governor.snapshot(KEY_A)).toMatchObject({ inFlight: CEILING, waiters: 0 });
  });

  it("tryAdmit 的公平性：有人排队时即便闸门开着也不走快路径（决策 9）", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const first = admitNow("A");
    const waiting = track(governor.admit("B", MODEL_A, new AbortController().signal));
    await flush();
    // 释放 first 让闸门开一瞬：排队的 B 先拿到；A 再来 tryAdmit 不能越过 B。
    outcome.completed(first);
    await flush();
    expect(waiting.ticket).toBeDefined();
    expect(governor.tryAdmit("A", MODEL_A)).toBeUndefined();
    const another = track(governor.admit("A", MODEL_A, new AbortController().signal));
    await flush();
    expect(another.settled).toBe(false);
    // 有 A 在排队时闸门若开，快路径对任何 run 都关着。
    outcome.completed(waiting.ticket!);
    await flush();
    expect(another.ticket).toBeDefined();
  });

  it("主代理（observer）的 429 把桶压到 4 后，新 run 直接从 4 起步（决策 10/19/37）", async () => {
    const { governor, observe } = makeGovernor();
    const main = await observe();
    outcome.throttled429(main);
    expect(governor.snapshot(KEY_A)?.cap).toBe(6); // 8 × 0.75

    const hits = Array.from({ length: 7 }, () => governor.tryAdmit("runB", MODEL_A));
    expect(hits.filter((t) => t !== undefined)).toHaveLength(6);
    expect(hits[6]).toBeUndefined();
  });

  it("observer 的 tryAcquire 总命中且计入 inFlight（v3 决策 44/47）：主代理的工具与 sidecar 请求从不排队、从不发 queued", async () => {
    const clock = fakeClock();
    const governor = createWorkflowConcurrencyGovernor({
      defaultConcurrency: 2,
      now: clock.now,
      schedule: clock.schedule,
    });
    const first = governor.observer().tryAcquire!({ model: MODEL_A });
    const second = governor.observer().tryAcquire!({ model: MODEL_A });
    const third = governor.observer().tryAcquire!({ model: MODEL_A });
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    // 闸门已满（2/2）：observer 仍命中快路径。
    expect(third).toBeDefined();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(3);
    // workflow 请求此刻拿不到快路径。
    expect(governor.tryAdmit("run-x", MODEL_A)).toBeUndefined();
    first!.release();
    second!.release();
    third!.release();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });

  it("observer 不排队、不看冷却，但计入 inFlight（决策 37）", async () => {
    const { governor, observe, admitNow, clock } = makeGovernor(1);
    const busy = admitNow("A");
    // 闸门已满：observer 仍立即放行。
    const main = await observe();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(2);
    outcome.throttled429(main, 30_000);
    expect(governor.snapshot(KEY_A)?.cooldownUntil).toBe(clock.now() + 30_000);
    // 冷却中：observer 照样放行；workflow 请求不行。
    const again = await observe();
    expect(again).toBeDefined();
    expect(governor.tryAdmit("A", MODEL_A)).toBeUndefined();
    outcome.completed(busy);
    outcome.completed(again);
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });

  it("按 key 分桶：alpha 被限流不影响 beta", async () => {
    const { governor, observe } = makeGovernor();
    outcome.throttled429(await observe());
    expect(governor.snapshot(KEY_A)?.cap).toBe(6);
    expect(governor.snapshot(KEY_B)).toBeUndefined();
    const hits = Array.from({ length: CEILING }, () => governor.tryAdmit("runB", MODEL_B));
    expect(hits.every((t) => t !== undefined)).toBe(true);
    expect(governor.snapshot(KEY_B)?.cap).toBe(CEILING);
  });

  it("run 间轮转：A 排 10 个、B 排 1 个，B 的第一个不晚于 A 的第二个（决策 9）", async () => {
    const { governor } = makeGovernor(1);
    const order: string[] = [];
    const tickets: ModelRequestAdmissionTicket[] = [];
    const enqueue = (runId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        void governor.admit(runId, MODEL_A, new AbortController().signal).then((ticket) => {
          order.push(runId);
          tickets.push(ticket);
        });
      }
    };
    enqueue("A", 10);
    enqueue("B", 1);
    await flush();
    // cap=1：第一个放行的是 A（先到）；结束后轮到 B，而不是 A 的第二个。
    expect(order).toEqual(["A"]);
    outcome.completed(tickets.shift()!);
    await flush();
    expect(order).toEqual(["A", "B"]);
    outcome.completed(tickets.shift()!);
    await flush();
    expect(order).toEqual(["A", "B", "A"]);
  });

  it("signal abort 把等待者移出队列并以 signal.reason reject", async () => {
    const { governor, admitNow } = makeGovernor(1);
    const first = admitNow("A");
    const controller = new AbortController();
    const waiting = track(governor.admit("A", MODEL_A, controller.signal));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(governor.snapshot(KEY_A)?.waiters).toBe(1);

    controller.abort(new Error("run cancelled"));
    await flush();
    expect(waiting.error).toBeInstanceOf(Error);
    expect((waiting.error as Error).message).toBe("run cancelled");
    expect(governor.snapshot(KEY_A)?.waiters).toBe(0);
    // 第一个结束：没有人再被放行（等待者已退场），名额空着。
    outcome.completed(first);
    await flush();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });

  it("已 abort 的 signal 立即 reject", async () => {
    const { governor } = makeGovernor();
    const controller = new AbortController();
    controller.abort();
    await expect(governor.admit("A", MODEL_A, controller.signal)).rejects.toBeInstanceOf(Error);
  });

  it("Retry-After 冷却冻结新准入直到 deadline，定时器到期唤醒等待者（决策 11）", async () => {
    const { governor, clock, observe } = makeGovernor();
    outcome.throttled429(await observe(), 20_000);
    const snapshot = governor.snapshot(KEY_A)!;
    expect(snapshot.cap).toBe(6);
    expect(snapshot.cooldownUntil).toBe(clock.now() + 20_000);

    expect(governor.tryAdmit("A", MODEL_A)).toBeUndefined();
    const waiting = track(governor.admit("A", MODEL_A, new AbortController().signal));
    await flush();
    expect(waiting.settled).toBe(false);
    expect(clock.pendingTimers()).toBe(1);

    clock.advance(19_999);
    await flush();
    expect(waiting.settled).toBe(false);
    clock.advance(1);
    await flush();
    expect(waiting.ticket).toBeDefined();
  });
});

describe("workflow concurrency governor — ticket 上的事件映射（决策 27/36）", () => {
  it("一次 429 = failed(retryable:true) + retry_scheduled，只算一次 throttled（不减两次）", async () => {
    const { governor, observe } = makeGovernor();
    outcome.throttled429(await observe());
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, inFlight: 0 });
  });

  it("retryable:false 的 rate_limited failed（主对话 / 工具侧撞 3008）→ 一次 throttled（apps/zcode-cli/packages/dynamic-workflow/docs/execution-engine.md）", () => {
    const { governor, admitNow, clock } = makeGovernor();
    const ticket = admitNow();
    outcome.started(ticket);
    void ticket.publish(
      statusEvent({
        type: "model_request_failed",
        reason: "rate_limited",
        retryable: false,
        message: "[3008] user concurrency limit exceeded",
        errorCode: "model_rate_limited",
        providerErrorCode: "3008",
        retryAfterMs: 5_000,
      } as never),
    );
    expect(governor.snapshot(KEY_A)).toMatchObject({
      inFlight: 0,
      cap: 6,
      cooldownUntil: clock.now() + 5_000,
    });
  });

  // 配额 429（1308 + Retry-After）是 Stop 集：run 停下、由用户决定何时再试。它若按限流记，
  // Retry-After（常指到额度窗口结束）会冻住整个桶，用户用重置卡恢复额度后 resume 仍卡在闸门上。
  it.each([
    ["run 的 ticket", "run"],
    ["主代理 observer 的 ticket", "observer"],
  ] as const)(
    "Stop 集失败（配额 1308 带 Retry-After，来自%s）不动 cap 也不冷却：resume 立即准入（docs/dynamic-workflow/concurrency.md「Reading a ticket」）",
    async (_label, source) => {
      const { governor, admitNow, observe } = makeGovernor();
      const ticket = source === "run" ? admitNow() : await observe();
      outcome.started(ticket);
      void ticket.publish(
        statusEvent({
          type: "model_request_failed",
          reason: "rate_limited",
          retryable: false,
          message: "[1308] 已达到 5 小时的使用上限",
          errorCode: "model_rate_limited",
          providerErrorCode: "1308",
          retryAfterMs: 3 * 60 * 60 * 1000,
        } as never),
      );
      const snapshot = governor.snapshot(KEY_A)!;
      expect(snapshot).toMatchObject({ inFlight: 0, cap: CEILING });
      expect(snapshot.cooldownUntil).toBeUndefined();
      expect(governor.tryAdmit("resumed-run", MODEL_A)).toBeDefined();
    },
  );

  it("retryable:false 的 failed 只减 inFlight，不动 cap 与 streak", () => {
    const { governor, admitNow } = makeGovernor();
    for (let i = 0; i < 3; i++) outcome.completed(admitNow());
    const before = governor.snapshot(KEY_A)!.successStreak;
    const ticket = admitNow();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(1);
    outcome.permanent(ticket);
    expect(governor.snapshot(KEY_A)).toMatchObject({
      inFlight: 0,
      cap: CEILING,
      successStreak: before,
    });
  });

  it("reasoning_signature_repair / auth_refresh 不是 provider 失败：cap 与 streak 都不动，只终结尝试", () => {
    const { governor, admitNow } = makeGovernor();
    for (let i = 0; i < 3; i++) outcome.completed(admitNow());
    const before = governor.snapshot(KEY_A)!.successStreak;
    outcome.retryScheduled(admitNow(), "reasoning_signature_repair", { delayMs: 0 });
    outcome.retryScheduled(admitNow(), "auth_refresh", { delayMs: 0 });
    expect(governor.snapshot(KEY_A)).toMatchObject({
      cap: CEILING,
      successStreak: before,
      inFlight: 0,
    });
  });

  it("offpeak_queued 归 throttled：减 cap 并按 Retry-After 冷却", () => {
    const { governor, admitNow, clock } = makeGovernor();
    outcome.retryScheduled(admitNow(), "offpeak_queued", { retryAfterMs: 60_000, delayMs: 60_000 });
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, cooldownUntil: clock.now() + 60_000 });
  });

  it("timeout / 5xx 的 retry_scheduled 只清 streak，不减 cap（决策 6）", () => {
    const { governor, admitNow } = makeGovernor();
    outcome.completed(admitNow());
    outcome.retryScheduled(admitNow(), "server_error");
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: CEILING, successStreak: 0, inFlight: 0 });
  });

  it("release() 没见终结事件即 ended；重复 release 幂等；结算后的 publish 惰性", () => {
    const { governor, admitNow } = makeGovernor();
    outcome.completed(admitNow());
    const streak = governor.snapshot(KEY_A)!.successStreak;
    const ticket = admitNow();
    outcome.started(ticket);
    ticket.release();
    ticket.release();
    expect(governor.snapshot(KEY_A)).toMatchObject({
      inFlight: 0,
      successStreak: streak,
      cap: CEILING,
    });
    // 已结算：再喂 429 也不减。
    void ticket.publish(
      statusEvent({
        type: "model_retry_scheduled",
        reason: "rate_limited",
        delayMs: 2000,
        nextAttempt: 2,
        message: "429",
      } as never),
    );
    expect(governor.snapshot(KEY_A)).toMatchObject({ inFlight: 0, cap: CEILING });
    // 终结事件之后再 release 也不再减。
    const second = admitNow();
    outcome.completed(second);
    second.release();
    expect(governor.snapshot(KEY_A)?.inFlight).toBe(0);
  });
});

describe("workflow concurrency governor — epoch 阻尼（决策 35）", () => {
  it("同一批准入的 8 个 429 只减一次、只发一条事件；再减只能来自新 epoch 的请求", async () => {
    const { governor, admitNow } = makeGovernor();
    const seen: ConcurrencyChange[] = [];
    governor.subscribe("runA", (change) => seen.push(change));
    const batch = Array.from({ length: CEILING }, () => admitNow());
    for (const ticket of batch) outcome.throttled429(ticket);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, inFlight: 0, epoch: 1 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ previous: CEILING, next: 6, reason: "rate_limited" });

    // 新 epoch 下发出的请求撞墙才是对 cap=6 的评价。
    outcome.throttled429(admitNow());
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 4, epoch: 2 });
    expect(seen).toHaveLength(2);
  });

  it("旧 epoch 的成功不计 streak；当前 epoch 连续 K = 4 次成功且有等待者才 +1", async () => {
    const { governor, admitNow } = makeGovernor(2);
    const stale = [admitNow(), admitNow()];
    // 两个都在飞时其中一个 429：cap 2→1，另一个成了旧 epoch。
    outcome.throttled429(stale[0]!);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 1, inFlight: 1 });
    // 让一个等待者排着（决策 15：有需求才加 cap）。
    const waiting = track(governor.admit("runA", MODEL_A, new AbortController().signal));
    await flush();
    outcome.completed(stale[1]!);
    expect(governor.snapshot(KEY_A)?.successStreak).toBe(0);
    await flush();
    // 等待者拿到名额（inFlight 1 == cap 1），此后每次结束都补一个等待者，凑 4 次当前 epoch 成功。
    expect(waiting.ticket).toBeDefined();
    let current = waiting.ticket!;
    for (let i = 0; i < 3; i++) {
      const next = track(governor.admit("runA", MODEL_A, new AbortController().signal));
      outcome.completed(current);
      await flush();
      expect(next.ticket).toBeDefined();
      current = next.ticket!;
    }
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 1, successStreak: 3 });
    const last = track(governor.admit("runA", MODEL_A, new AbortController().signal));
    outcome.completed(current);
    await flush();
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 2, successStreak: 0 });
    expect(last.ticket).toBeDefined();
  });
});

describe("workflow concurrency governor — 扇出与遗忘", () => {
  it("cap 变化只扇出给该 key 上有在飞或排队请求的 run（决策 8）", async () => {
    const { governor, admitNow, observe } = makeGovernor();
    const seenA: ConcurrencyChange[] = [];
    const seenB: ConcurrencyChange[] = [];
    const seenC: ConcurrencyChange[] = [];
    governor.subscribe("A", (change) => seenA.push(change));
    governor.subscribe("B", (change) => seenB.push(change));
    governor.subscribe("C", (change) => seenC.push(change));
    // A 在 alpha 上有在飞；B 只订阅了；C 在 beta 上有在飞。
    const a = admitNow("A", MODEL_A);
    admitNow("C", MODEL_B);

    outcome.throttled429(await observe(), 5_000);
    expect(seenA).toHaveLength(1);
    expect(seenA[0]).toMatchObject({
      key: KEY_A,
      previous: CEILING,
      next: 6,
      reason: "rate_limited",
      cooldownMs: 5_000,
    });
    expect(seenB).toEqual([]);
    expect(seenC).toEqual([]);
    outcome.completed(a);
  });

  it("排队中的 run 也收扇出；退订后不再收到", async () => {
    const { governor, admitNow, observe } = makeGovernor(1);
    const seen: ConcurrencyChange[] = [];
    const unsubscribe = governor.subscribe("A", (change) => seen.push(change));
    const busy = admitNow("B");
    track(governor.admit("A", MODEL_A, new AbortController().signal));
    await flush();
    outcome.throttled429(await observe(), 1_000);
    expect(seen).toHaveLength(1);
    unsubscribe();
    outcome.throttled429(await observe(), 1_000);
    expect(seen).toHaveLength(1);
    outcome.completed(busy);
  });

  it("空闲 5 分钟且无在飞后，下一个 run 从天花板起步（决策 20）", async () => {
    const { governor, clock, observe, admitNow } = makeGovernor();
    outcome.completed(await observe());
    outcome.throttled429(await observe());
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, inFlight: 0 });

    clock.advance(300_000);
    const hits = Array.from({ length: CEILING }, () => governor.tryAdmit("runNext", MODEL_A));
    expect(hits.every((t) => t !== undefined)).toBe(true);
    expect(governor.snapshot(KEY_A)?.cap).toBe(CEILING);
    for (const t of hits) outcome.completed(t!);
    void admitNow;
  });

  it("有在飞请求时不重置：5 分钟后 cap 仍是学到的值", async () => {
    const { governor, clock, observe, admitNow } = makeGovernor();
    const busy = admitNow();
    outcome.throttled429(await observe());
    clock.advance(300_000);
    expect(governor.tryAdmit("runA", MODEL_A)).toBeDefined();
    expect(governor.snapshot(KEY_A)?.cap).toBe(6);
    outcome.completed(busy);
  });
});

describe("workflow concurrency governor — 增长上限（docs/dynamic-workflow/concurrency.md「The governor」）", () => {
  /** 让 run 在 key 上持续有一个等待者，并凑满 n 次当前 epoch 的成功；返回最后仍在飞的票。 */
  async function climb(
    governor: ReturnType<typeof makeGovernor>["governor"],
    runId: string,
    tickets: ModelRequestAdmissionTicket[],
    successes: number,
  ): Promise<ModelRequestAdmissionTicket[]> {
    let live = [...tickets];
    for (let i = 0; i < successes; i++) {
      const next = track(governor.admit(runId, MODEL_A, new AbortController().signal));
      const done = live.shift()!;
      outcome.completed(done);
      await flush();
      // 等待者可能被放行（cap 够），也可能还在排；放行的票加入在飞。
      if (next.ticket !== undefined) live.push(next.ticket);
      // 每轮把能放行的都补满，保持「有人在等」。
      for (;;) {
        const extra = governor.tryAdmit(runId, MODEL_A);
        if (extra === undefined) break;
        live.push(extra);
      }
    }
    return live;
  }

  it("桶从 D 起步，自动增长停在 2D", async () => {
    const { governor, admitNow } = makeGovernor(4);
    const tickets = Array.from({ length: 4 }, () => admitNow("A"));
    expect(governor.snapshot(KEY_A)).toMatchObject({ initial: 4, growthLimit: 8, cap: 4 });
    const live = await climb(governor, "A", tickets, 80);
    expect(governor.snapshot(KEY_A)?.cap).toBe(8);
    for (const t of live) outcome.completed(t);
  });

  it("用过这个 key 的在飞 run 登记了高于 2D 的上界 → 增长上限抬到它；没用过这个 key 的 run 不抬", async () => {
    const { governor, admitNow } = makeGovernor(4);
    governor.setRunBound("big", 20);
    governor.setRunBound("elsewhere", 50);
    admitNow("elsewhere", MODEL_B);
    const tickets = Array.from({ length: 4 }, () => admitNow("big"));
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(20);
    expect(governor.snapshot(KEY_B)?.growthLimit).toBe(50);
    // 起跳：第一次准入即把 cap 拉到登记的上界，不用一级一级爬。
    expect(governor.snapshot(KEY_A)?.cap).toBe(20);
    expect(governor.snapshot(KEY_B)?.cap).toBe(50);
    for (const t of tickets) outcome.completed(t);
  });

  it("上界不高于 2D 的 run 不抬增长上限；observer 永不抬", async () => {
    const { governor, admitNow, observe } = makeGovernor(4);
    governor.setRunBound("small", 3);
    admitNow("small");
    outcome.completed(await observe());
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(8);
  });

  it("run 清掉上界：增长上限落回、高于新上限的 cap 被拉下来，limit_lowered 扇给仍 engaged 的 run", async () => {
    const { governor, admitNow } = makeGovernor(4);
    const seenOther: ConcurrencyChange[] = [];
    governor.subscribe("other", (change) => seenOther.push(change));
    governor.setRunBound("big", 20);
    // 另一个默认 run 在这个 key 上一直有一个在飞请求（engaged，所以收得到扇出）。
    const other = admitNow("other");
    const live = Array.from({ length: 3 }, () => admitNow("big"));
    const capBefore = governor.snapshot(KEY_A)!.cap;
    expect(capBefore).toBeGreaterThan(8);
    governor.clearRunBound("big");
    expect(governor.snapshot(KEY_A)).toMatchObject({ growthLimit: 8, cap: 8 });
    expect(seenOther.at(-1)).toMatchObject({
      key: KEY_A,
      previous: capBefore,
      next: 8,
      reason: "limit_lowered",
    });
    for (const t of live) outcome.completed(t);
    outcome.completed(other);
  });

  it("retune 调低上界同样落回；调回高位再抬起来（setRunBound 覆盖旧值）", async () => {
    const { governor, admitNow } = makeGovernor(4);
    governor.setRunBound("r", 30);
    const ticket = admitNow("r");
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(30);
    governor.setRunBound("r", 5);
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(8);
    governor.setRunBound("r", 12);
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(12);
    outcome.completed(ticket);
  });

  it("run 先用 key、后登记上界：登记即抬起它用过的 key", () => {
    const { governor, admitNow } = makeGovernor(4);
    const ticket = admitNow("late");
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(8);
    governor.setRunBound("late", 16);
    expect(governor.snapshot(KEY_A)?.growthLimit).toBe(16);
    outcome.completed(ticket);
  });
});

describe("workflow concurrency governor — 调高上界即起跳（docs/dynamic-workflow/concurrency.md「Seeding」）", () => {
  it("retune 调高：cap 当场跳到新上界，seeded 扇给这个 run——哪怕它此刻没有在飞请求", () => {
    const { governor, admitNow } = makeGovernor(8);
    const seen: ConcurrencyChange[] = [];
    governor.subscribe("r", (change) => seen.push(change));
    governor.setRunBound("r", 8);
    outcome.completed(admitNow("r")); // 用过这个 key，此刻空闲
    expect(governor.snapshot(KEY_A)?.cap).toBe(8);
    governor.setRunBound("r", 32);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 32, growthLimit: 32 });
    expect(seen.at(-1)).toMatchObject({ key: KEY_A, previous: 8, next: 32, reason: "seeded" });
  });

  it("五分钟内有过 429 就不起跳：cap 照常靠探测爬", async () => {
    const { governor, admitNow, observe } = makeGovernor(8);
    governor.setRunBound("r", 8);
    const ticket = admitNow("r");
    outcome.throttled429(await observe()); // 8 → 6
    governor.setRunBound("r", 32);
    expect(governor.snapshot(KEY_A)).toMatchObject({ cap: 6, growthLimit: 32 });
    outcome.completed(ticket);
  });

  it("默认上界与压低的上界都不起跳", () => {
    const { governor, admitNow } = makeGovernor(8);
    governor.setRunBound("a", 8);
    governor.setRunBound("b", 3);
    const tickets = [admitNow("a"), admitNow("b")];
    expect(governor.snapshot(KEY_A)?.cap).toBe(8);
    for (const t of tickets) outcome.completed(t);
  });

  it("起跳之后撞墙：第一次 429 按系数减（32 → 24），同一波的其余 429 不再减", async () => {
    const { governor, admitNow } = makeGovernor(8);
    governor.setRunBound("r", 32);
    const tickets = Array.from({ length: 32 }, () => admitNow("r"));
    expect(governor.snapshot(KEY_A)?.cap).toBe(32);
    for (const t of tickets.slice(0, 20)) outcome.throttled429(t);
    expect(governor.snapshot(KEY_A)?.cap).toBe(24);
    for (const t of tickets.slice(20)) outcome.completed(t);
  });
});

describe("workflow concurrency governor — provider 硬上限闸门（requestPolicy.maxConcurrent）", () => {
  /** ceilings 用可变对象：模拟设置页改配置（resolver 每次准入重读）。 */
  function makeCappedGovernor(
    ceilings: Record<string, number | undefined>,
    defaultConcurrency = CEILING,
  ) {
    const clock = fakeClock();
    const governor = createWorkflowConcurrencyGovernor({
      defaultConcurrency,
      resolveMaxConcurrent: (providerId) => ceilings[providerId],
      now: clock.now,
      schedule: clock.schedule,
    });
    return { clock, governor, ceilings };
  }

  it("总在飞数跨模型桶封顶：alpha 与 beta 各有 AIMD cap，但共用 provider 的 2 个名额", () => {
    const { governor } = makeCappedGovernor({ prov: 2 });
    const a = governor.tryAdmit("runA", MODEL_A)!;
    const b = governor.tryAdmit("runB", MODEL_B)!;
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    // 两个桶的 AIMD cap 都还是 8——卡住它们的是 provider 闸门，不是模型桶。
    expect(governor.snapshot(KEY_A)?.cap).toBe(CEILING);
    expect(governor.snapshot(KEY_B)?.cap).toBe(CEILING);
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();
    expect(governor.tryAdmit("runB", MODEL_B)).toBeUndefined();

    a.release();
    // 释放的是 alpha 的名额，beta 的请求同样能拿到——闸门是 provider 级的。
    expect(governor.tryAdmit("runB", MODEL_B)).toBeDefined();
  });

  it("上限热更新：调大立刻放行、调小只拦新请求（在飞的自然结束）", () => {
    const { governor, ceilings } = makeCappedGovernor({ prov: 1 });
    const first = governor.tryAdmit("runA", MODEL_A)!;
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();

    ceilings.prov = 2;
    const second = governor.tryAdmit("runA", MODEL_A);
    expect(second).toBeDefined();

    ceilings.prov = 1;
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();
    first.release();
    second!.release();
  });

  it("取消配置就恢复原行为：provider 闸门不存在", () => {
    const { governor, ceilings } = makeCappedGovernor({ prov: 1 });
    const first = governor.tryAdmit("runA", MODEL_A)!;
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();
    ceilings.prov = undefined;
    expect(governor.tryAdmit("runA", MODEL_A)).toBeDefined();
    first.release();
  });

  it("主代理优先级：名额满时排优先通道，释放后先于 run 的等待者放行", async () => {
    const { governor } = makeCappedGovernor({ prov: 2 });
    const first = governor.tryAdmit("runA", MODEL_A)!;
    const second = governor.tryAdmit("runA", MODEL_A)!;
    // 名额满：主代理的快路径也不命中（配置了上限就守闸门）。
    expect(governor.observer().tryAcquire!({ model: MODEL_A })).toBeUndefined();

    const main = track(governor.observer().acquire({ model: MODEL_A }));
    const runWaiting = track(governor.admit("runB", MODEL_B, new AbortController().signal));
    await flush();
    expect(main.settled).toBe(false);
    expect(runWaiting.settled).toBe(false);

    outcome.completed(first);
    await flush();
    // 优先通道先走：主代理拿到名额，run 仍在等。
    expect(main.ticket).toBeDefined();
    expect(runWaiting.settled).toBe(false);

    main.ticket!.release();
    await flush();
    expect(runWaiting.ticket).toBeDefined();
    outcome.completed(second);
    outcome.completed(runWaiting.ticket!);
  });

  it("跨模型桶唤醒：alpha 的请求结算后放行 beta 的等待者", async () => {
    const { governor } = makeCappedGovernor({ prov: 1 });
    const a = governor.tryAdmit("runA", MODEL_A)!;
    const waiting = track(governor.admit("runB", MODEL_B, new AbortController().signal));
    await flush();
    expect(waiting.settled).toBe(false);

    outcome.completed(a);
    await flush();
    expect(waiting.ticket).toBeDefined();
    outcome.completed(waiting.ticket!);
  });

  it("主代理绕开模型桶的 AIMD cap 与冷却，但守 provider 总量", () => {
    const { governor } = makeCappedGovernor({ prov: 3 }, 1);
    // 模型桶 cap=1 刚撞过 429 并带 Retry-After：run 的新请求既没快路径也要等冷却。
    const run = governor.tryAdmit("runA", MODEL_A)!;
    outcome.throttled429(run, 60_000);
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();

    // observer 只守 provider 总量：3 个名额都空着，冷却不拦它。
    const mainA = governor.observer().tryAcquire!({ model: MODEL_A });
    const mainB = governor.observer().tryAcquire!({ model: MODEL_B });
    const mainC = governor.observer().tryAcquire!({ model: MODEL_A });
    expect(mainA).toBeDefined();
    expect(mainB).toBeDefined();
    expect(mainC).toBeDefined();
    // 总量到顶：主代理也要排队（快路径不命中，runner 据此报「在等并发」）。
    expect(governor.observer().tryAcquire!({ model: MODEL_A })).toBeUndefined();
  });
});

describe("workflow concurrency governor — 同机跨端共享同一份并发额度", () => {
  /**
   * 假共享视图。**两个读数要分开**，这是真实语义：`othersInFlight()` 是「最后观察到的值」（快路径
   * 用它，同步、陈旧），`refresh()` 才是去读盘。测试想模拟「对方放掉了」，改的是 `onDisk`；想让这一
   * 侧知道，得等它重读（被挡住时重读，或轮询到点）。
   */
  function fakeSharedView(initial: number) {
    const state = {
      cached: initial,
      onDisk: initial,
      reported: [] as Array<{ providerId: string; count: number }>,
      refreshCalls: 0,
    };
    const view: ProviderConcurrencySharedView = {
      othersInFlight: () => state.cached,
      refresh: async () => {
        state.refreshCalls += 1;
        state.cached = state.onDisk;
        return state.cached;
      },
      report: (providerId, count) => {
        state.reported.push({ providerId, count });
      },
      dispose: async () => {},
    };
    return { view, state };
  }

  function makeSharedGovernor(options: {
    ceiling?: number;
    others?: number;
    defaultConcurrency?: number;
  }) {
    const clock = fakeClock();
    const shared = fakeSharedView(options.others ?? 0);
    const governor = createWorkflowConcurrencyGovernor({
      defaultConcurrency: options.defaultConcurrency ?? CEILING,
      resolveMaxConcurrent: () => options.ceiling,
      resolveSharedConcurrency: () => shared.view,
      now: clock.now,
      schedule: clock.schedule,
    });
    return { clock, governor, shared, options };
  }

  it("别人占着的份额从本进程额度里扣：上限 2、别人占 1 ⇒ 本进程只能有 1 个在飞", () => {
    const { governor, shared } = makeSharedGovernor({ ceiling: 2, others: 1 });
    const first = governor.tryAdmit("runA", MODEL_A);
    expect(first).toBeDefined();
    // 额度 = 2 − 1 = 1，已经用掉。
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();

    // 对方放掉：重读之后额度回到 2，还差 1 个名额。
    shared.state.onDisk = 0;
    void shared.view.refresh("prov");
    expect(governor.tryAdmit("runA", MODEL_A)).toBeDefined();
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();
    first!.release();
  });

  it("快路径用的是「最后观察到的」读数：对方放掉了也不会自动变宽，要靠重读", () => {
    const { governor, shared } = makeSharedGovernor({ ceiling: 2, others: 1 });
    const held = governor.tryAdmit("runA", MODEL_A)!;
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();

    shared.state.onDisk = 0; // 对方放掉了，但我们还没重读
    expect(shared.state.cached).toBe(1);
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();

    // 重读一次：额度立刻回到 2。
    void shared.view.refresh("prov");
    expect(governor.tryAdmit("runA", MODEL_A)).toBeDefined();
    held.release();
  });

  it("别人报满（甚至报得比上限还大）仍留 1：下限钳制保证任何一侧都还在往前挪", () => {
    for (const others of [2, 5]) {
      const { governor } = makeSharedGovernor({ ceiling: 2, others });
      expect(governor.tryAdmit("runA", MODEL_A)).toBeDefined();
      // 留的那 1 个用掉之后仍然要等——下限是「不僵死」，不是「不受限」。
      expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();
    }
  });

  it("挡住我们的是别人时，排队前先重读一次：视图偏旧不会排假队", async () => {
    const { governor, shared } = makeSharedGovernor({ ceiling: 3, others: 2 });
    const held = governor.tryAdmit("runA", MODEL_A)!; // 可用额度 = max(1, 3−2) = 1，用掉
    expect(governor.tryAdmit("runA", MODEL_A)).toBeUndefined();

    // 对方已经放掉 1 个，只是我们还没重读：这次准入应当重读后直接拿到票，而不是排进队列。
    shared.state.onDisk = 1;
    const ticket = await governor.admit("runB", MODEL_B, new AbortController().signal);
    expect(ticket).toBeDefined();
    expect(shared.state.refreshCalls).toBeGreaterThan(0);
    ticket.release();
    held.release();
  });

  it("有在飞就轮询另一端：对方放掉后由重读定时器唤醒（别人放行不会通知我们）", async () => {
    const { clock, governor, shared } = makeSharedGovernor({ ceiling: 2, others: 1 });
    const held = governor.tryAdmit("runA", MODEL_A)!; // 可用额度 = 1，用掉 ⇒ 本进程已顶满
    const waiting = track(governor.admit("runB", MODEL_B, new AbortController().signal));
    await flush();
    // 挡住它的不是本进程的 AIMD：额度只有 1，而对方还占着 —— 这条队列只能靠重读解开。
    expect(waiting.settled).toBe(false);

    shared.state.onDisk = 0;
    clock.advance(250);
    await flush();
    expect(waiting.ticket).toBeDefined();
    waiting.ticket!.release();
    held.release();
  });

  it("上报本进程在飞数：配了硬上限才报（没配就没有要分的额度，一次 IO 都不做）", () => {
    const { governor, shared } = makeSharedGovernor({ ceiling: 2, others: 0 });
    const ticket = governor.tryAdmit("runA", MODEL_A)!;
    expect(shared.state.reported).toEqual([{ providerId: "prov", count: 1 }]);
    ticket.release();
    expect(shared.state.reported).toEqual([
      { providerId: "prov", count: 1 },
      { providerId: "prov", count: 0 },
    ]);

    const uncapped = makeSharedGovernor({ ceiling: undefined, others: 0 });
    const free = uncapped.governor.tryAdmit("runA", MODEL_A)!;
    free.release();
    expect(uncapped.shared.state.reported).toEqual([]);
  });

  it("取消上限后不再共享上报：闸门不存在，也就没有份额可分", () => {
    const { governor, shared, options } = makeSharedGovernor({ ceiling: 1, others: 0 });
    const held = governor.tryAdmit("runA", MODEL_A)!;
    const before = shared.state.reported.length;
    expect(before).toBe(1);

    options.ceiling = undefined;
    const after = governor.tryAdmit("runA", MODEL_A);
    expect(after).toBeDefined();
    expect(shared.state.reported.length).toBe(before);
    held.release();
  });

  it("跨模型桶仍然是一份额度：另一个模型上的在飞也扣在同一个 provider 上", () => {
    const { governor } = makeSharedGovernor({ ceiling: 2, others: 1 });
    expect(governor.tryAdmit("runA", MODEL_A)).toBeDefined();
    // 本进程额度已满（1），换个模型桶也一样要等——共享读数按 provider 算，不按模型算。
    expect(governor.tryAdmit("runB", MODEL_B)).toBeUndefined();
  });
});
