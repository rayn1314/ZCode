import { describe, expect, it, vi } from "vitest";
import type { ModelRequestAdmissionTicket, ModelRequestTarget } from "@zcode/contracts";
import {
  createProviderRateLimiter,
  createRateLimitOnlyAdmission,
  withProviderRateLimit,
  type ProviderRateLimiterOptions,
} from "../src/app/provider-rate-limiter.js";
import { msUntilNextQuotaToken, refillQuotaState } from "../src/app/provider-quota-math.js";
import type { ProviderQuotaSharedStore } from "../src/app/provider-quota-shared-store.js";

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

/**
 * 共享路径天然是异步的（要跨文件边界），所以「它到底排没排定时器」必须等微任务跑完再断言；
 * 同步断言只会看到「还没开始等」。
 */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** 默认把 provider-a 配成 1/min——桶容量 1，第二次请求必须等满 60 秒。 */ function createLimiterHarness(
  overrides: Partial<ProviderRateLimiterOptions> = {},
) {
  const clock = createTestClock();
  const info = vi.fn();
  const warn = vi.fn();
  const limiter = createProviderRateLimiter({
    resolveRequestsPerMinute: (providerId) => (providerId === MODEL.providerId ? 1 : undefined),
    now: clock.now,
    schedule: clock.schedule,
    logger: { info, warn },
    ...overrides,
  });
  return { clock, limiter, info, warn };
}

/**
 * 共享账本的测试替身：用**真实**的桶数学（`provider-quota-math`）在两个限速器实例之间共享余额，
 * 就是「两个进程摸到同一份账本」的语义。文件版账本自己的读写与加锁由
 * provider-quota-shared-store.test.ts 覆盖。
 */
function createInMemorySharedStore() {
  const buckets = new Map<
    string,
    { requestsPerMinute: number; tokens: number; updatedAtMs: number }
  >();
  const calls: string[] = [];
  const store: ProviderQuotaSharedStore = {
    tryConsume: ({ key, requestsPerMinute, atMs }) => {
      calls.push(key);
      const bucket = buckets.get(key) ?? {
        requestsPerMinute,
        tokens: requestsPerMinute,
        updatedAtMs: atMs,
      };
      bucket.requestsPerMinute = requestsPerMinute;
      refillQuotaState(bucket, atMs);
      buckets.set(key, bucket);
      if (bucket.tokens >= 1) {
        bucket.tokens -= 1;
        return Promise.resolve({ kind: "granted" as const });
      }
      return Promise.resolve({
        kind: "exhausted" as const,
        retryInMs: msUntilNextQuotaToken(bucket),
      });
    },
  };
  return { calls, store };
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

describe("跨进程共享账本（同机多端）", () => {
  it("两个限速器实例共用一个账本：合计才是额度，不是各算一份", async () => {
    const { store } = createInMemorySharedStore();
    const clock = createTestClock();
    const shared = {
      resolveSharedBucketKey: () => "provider-a--fingerprint",
      now: clock.now,
      schedule: clock.schedule,
      sharedStore: store,
    };
    const first = createLimiterHarness(shared);
    const second = createLimiterHarness(shared);

    await expect(first.limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);
    // 第二个进程（同机另一端）接着发：额度已被用掉，必须等。
    const waiting = second.limiter.awaitRateLimit({ model: MODEL });
    await flushMicrotasks();
    expect(clock.pending()).toBe(1);
    clock.advanceBy(60_000);
    await expect(waiting).resolves.toBe(60_000);
  });

  it("算不出账号指纹（key 为 undefined）就不走账本，退回进程内桶", async () => {
    const { store, calls } = createInMemorySharedStore();
    const { limiter } = createLimiterHarness({
      resolveSharedBucketKey: () => undefined,
      sharedStore: store,
    });
    await expect(limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);
    expect(calls).toEqual([]);
  });

  it("账本不可达时降级为进程内限速：仍然限速，绝不 fail-open", async () => {
    const broken: ProviderQuotaSharedStore = {
      tryConsume: () => Promise.reject(new Error("shared store offline")),
    };
    const { clock, limiter, warn } = createLimiterHarness({
      resolveSharedBucketKey: () => "provider-a--fingerprint",
      sharedStore: broken,
    });
    // 第一次：账本挂了，退回进程内桶 —— 桶里有一个令牌，立即放行。
    await expect(limiter.awaitRateLimit({ model: MODEL })).resolves.toBe(0);
    // 第二次：进程内桶也空了 —— 依然要等，说明降级不是「放行」。
    const waiting = limiter.awaitRateLimit({ model: MODEL });
    await flushMicrotasks();
    expect(clock.pending()).toBe(1);
    clock.advanceBy(60_000);
    await expect(waiting).resolves.toBe(60_000);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("falling back to process-local limit");
  });

  it("降级告警会节流，不刷屏", async () => {
    const broken: ProviderQuotaSharedStore = {
      tryConsume: () => Promise.reject(new Error("shared store offline")),
    };
    // 本地配额给足，让三次请求都即刻放行——不同时刻的降级才会各记一条，节流看的是同一个窗口内。
    const { limiter, warn } = createLimiterHarness({
      resolveRequestsPerMinute: () => 3,
      resolveSharedBucketKey: () => "provider-a--fingerprint",
      sharedStore: broken,
    });
    await limiter.awaitRateLimit({ model: MODEL });
    await limiter.awaitRateLimit({ model: MODEL });
    await limiter.awaitRateLimit({ model: MODEL });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("共享模式不影响不限速的 provider", async () => {
    const { store, calls } = createInMemorySharedStore();
    const { limiter } = createLimiterHarness({
      resolveSharedBucketKey: () => "provider-b--fingerprint",
      sharedStore: store,
    });
    await expect(
      limiter.awaitRateLimit({ model: { providerId: "provider-b", modelId: "model-a" } }),
    ).resolves.toBe(0);
    expect(calls).toEqual([]);
  });
});
