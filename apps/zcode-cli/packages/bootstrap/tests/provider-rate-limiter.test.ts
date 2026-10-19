import { describe, expect, it, vi } from "vitest";
import type { ModelRequestAdmissionTicket, ModelRequestTarget } from "@zcode/contracts";
import {
  createProviderRateLimiter,
  createRateLimitOnlyAdmission,
  withProviderRateLimit,
  type ProviderRateLimiterOptions,
} from "../src/app/provider-rate-limiter.js";

const MODEL: ModelRequestTarget = { providerId: "provider-a", modelId: "model-a" };

/**
 * 受控时钟：限速器只据 `now` / `schedule` 两个注入点推进，因此测试不真等一分钟。
 * 定时器按到期先后触发；触发过程中新排的定时器若也已到期会被继续带动。
 */
function createTestClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => current,
    schedule: (run: () => void, delayMs: number): (() => void) => {
      const id = nextId++;
      timers.set(id, { at: current + delayMs, run });
      return () => {
        timers.delete(id);
      };
    },
    pending: () => timers.size,
    advanceBy(ms: number): void {
      current += ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= current)
          .sort((a, b) => a[1].at - b[1].at);
        if (due.length === 0) return;
        for (const [id, timer] of due) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}

/** 默认把 provider-a 配成 1/min——桶容量 1，第二次请求必须等满 60 秒。 */
function createLimiterHarness(overrides: Partial<ProviderRateLimiterOptions> = {}) {
  const clock = createTestClock();
  const info = vi.fn();
  const limiter = createProviderRateLimiter({
    resolveRequestsPerMinute: (providerId) => (providerId === MODEL.providerId ? 1 : undefined),
    now: clock.now,
    schedule: clock.schedule,
    logger: { info },
    ...overrides,
  });
  return { clock, limiter, info };
}

/** 主代理那一侧：治理器 observer 式的准入端口，经装饰拿到限速层。 */
const GOVERNOR_LIKE: { acquire: () => Promise<ModelRequestAdmissionTicket> } = {
  acquire: () => Promise.resolve({ publish() {}, release() {} }),
};

describe("provider 速率限制器", () => {
  it("没配配额的 provider 不建桶、不排定时器、不等", async () => {
    const { clock, limiter } = createLimiterHarness();
    await expect(
      limiter.awaitRateLimit({ model: { providerId: "provider-b", modelId: "model-a" } }),
    ).resolves.toBe(0);
    expect(clock.pending()).toBe(0);
  });

  it("非法配额（0 / 负数 / 非有限）等价于不限速——否则配额永远补不满，请求会被永久挂起", async () => {
    for (const invalid of [0, -3, Number.NaN, Number.POSITIVE_INFINITY]) {
      const { clock, limiter } = createLimiterHarness({ resolveRequestsPerMinute: () => invalid });
      await expect(limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);
      expect(clock.pending()).toBe(0);
    }
  });

  it("配额用尽后按节奏补齐：1/min 时下一个令牌等满 60 秒，并落一条等待日志", async () => {
    const { clock, limiter, info } = createLimiterHarness();
    await expect(limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);

    const waiting = limiter.awaitRateLimit({ model: MODEL });
    expect(clock.pending()).toBe(1);
    clock.advanceBy(60_000);
    await expect(waiting).resolves.toBe(60_000);
    expect(info).toHaveBeenCalledWith(
      "Model request rate limit wait",
      expect.objectContaining({
        providerId: MODEL.providerId,
        requestsPerMinute: 1,
        waitedMs: 60_000,
      }),
    );
  });

  it("等待者 FIFO：先入队的先拿令牌，后入队的不插队", async () => {
    const { clock, limiter } = createLimiterHarness();
    await expect(limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);

    const first = limiter.awaitRateLimit({ model: MODEL });
    const second = limiter.awaitRateLimit({ model: MODEL });
    clock.advanceBy(60_000);
    await expect(first).resolves.toBe(60_000);
    clock.advanceBy(60_000);
    await expect(second).resolves.toBe(120_000);
  });

  it("等待中被 abort：立刻以 signal.reason 拒绝，且不留下无主定时器", async () => {
    const { clock, limiter } = createLimiterHarness();
    await expect(limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);

    const controller = new AbortController();
    const waiting = limiter.awaitRateLimit({ model: MODEL, signal: controller.signal });
    expect(clock.pending()).toBe(1);
    controller.abort(new Error("cancelled"));
    await expect(waiting).rejects.toThrow("cancelled");
    expect(clock.pending()).toBe(0);
  });
});

describe("createRateLimitOnlyAdmission", () => {
  it("不设并发闸门：提供 awaitRateLimit，刻意不提供 tryAcquire（runner 据此不发并发排队事件）", () => {
    const { limiter } = createLimiterHarness();
    const admission = createRateLimitOnlyAdmission(limiter);
    expect(admission.awaitRateLimit).toBeTypeOf("function");
    expect(admission.tryAcquire).toBeUndefined();
  });

  it("acquire 立即给票且 release 幂等，不占任何并发槽", async () => {
    const { clock, limiter } = createLimiterHarness();
    const admission = createRateLimitOnlyAdmission(limiter);
    const ticket = await admission.acquire({ model: MODEL });
    expect(clock.pending()).toBe(0);
    expect(() => {
      ticket.release();
      ticket.release();
      ticket.publish({ type: "model_request_started" } as never);
    }).not.toThrow();
  });

  it("与主代理共享同一份 provider 配额：主代理用掉令牌后，工作流子代理的请求要等", async () => {
    const { clock, limiter } = createLimiterHarness();
    const governed = withProviderRateLimit(GOVERNOR_LIKE, limiter)!;
    const quotaOnly = createRateLimitOnlyAdmission(limiter);

    await expect(governed.awaitRateLimit!({ model: MODEL })).resolves.toBe(0);

    const waiting = quotaOnly.awaitRateLimit!({ model: MODEL });
    expect(clock.pending()).toBe(1);
    clock.advanceBy(60_000);
    await expect(waiting).resolves.toBe(60_000);
  });

  it("配额是按 provider 分的：另一个 provider 不受同一份桶影响", async () => {
    const { clock, limiter } = createLimiterHarness({
      resolveRequestsPerMinute: (providerId) => (providerId === "provider-a" ? 1 : 5),
    });
    const quotaOnly = createRateLimitOnlyAdmission(limiter);
    await expect(quotaOnly.awaitRateLimit!({ model: MODEL })).resolves.toBe(0);
    await expect(
      quotaOnly.awaitRateLimit!({ model: { providerId: "provider-b", modelId: "model-a" } }),
    ).resolves.toBe(0);
    expect(clock.pending()).toBe(0);
  });
});

describe("withProviderRateLimit", () => {
  it("inner 缺席时原样返回 undefined：没有并发闸门的调用方不该被凭空加上限速", () => {
    const { limiter } = createLimiterHarness();
    expect(withProviderRateLimit(undefined, limiter)).toBeUndefined();
  });

  it("只补 awaitRateLimit，tryAcquire / acquire 逐字不动", () => {
    const { limiter } = createLimiterHarness();
    const decorated = withProviderRateLimit(GOVERNOR_LIKE, limiter)!;
    expect(decorated.acquire).toBe(GOVERNOR_LIKE.acquire);
    expect(decorated.tryAcquire).toBeUndefined();
    expect(decorated.awaitRateLimit).toBeTypeOf("function");
  });
});

describe("限速器是进程单例", () => {
  it("同一进程里的多个 app 取用同一个桶（配额在账号上，不按会话分）", async () => {
    const { getProviderRateLimiter } = await import("../src/app/provider-rate-limiter.js");
    const first = getProviderRateLimiter({ resolveRequestsPerMinute: () => undefined });
    const second = getProviderRateLimiter({ resolveRequestsPerMinute: () => undefined });
    expect(second).toBe(first);
  });
});
