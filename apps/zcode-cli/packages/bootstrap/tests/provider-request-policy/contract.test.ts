import { describe, expect, it } from "vitest";
import type { ModelRequestAdmission, ModelRequestTarget } from "@zcode/contracts";
import {
  computeSharedQuotaKey,
  createProviderRateLimiter,
  createRateLimitOnlyAdmission,
  normalizeRequestsPerMinute,
  PROVIDER_QUOTA_SHARED_FILE_ENV,
  refillQuotaState,
  resolveProviderQuotaSharedFilePath,
  withProviderRateLimit,
  type ProviderRateLimitPort,
} from "../../src/provider-request-policy/contract.js";
import { providerRequestPolicyModule } from "../../src/provider-request-policy/module.js";

const model: ModelRequestTarget = { providerId: "openai-compatible", modelId: "gpt-4o" };

/** 注入时钟与定时器：契约关心的是「等多久」，不是真睡觉。 */
function createTestLimiter(requestsPerMinute: number | undefined) {
  let currentMs = 0;
  let scheduled: (() => void) | undefined;
  const limiter = createProviderRateLimiter({
    resolveRequestsPerMinute: () => requestsPerMinute,
    now: () => currentMs,
    schedule: (callback) => {
      scheduled = callback;
      return () => {
        if (scheduled === callback) scheduled = undefined;
      };
    },
  });
  return {
    limiter,
    advance(ms: number) {
      currentMs += ms;
    },
    get scheduledWake() {
      return scheduled;
    },
  };
}

describe("provider-request-policy contract", () => {
  it("非法配额等价于不限速，且不排定时器（不能把所有请求永久挂起）", async () => {
    expect(normalizeRequestsPerMinute(0)).toBeUndefined();
    expect(normalizeRequestsPerMinute(-5)).toBeUndefined();
    expect(normalizeRequestsPerMinute(Number.NaN)).toBeUndefined();
    expect(normalizeRequestsPerMinute(15.9)).toBe(15);

    const clock = createTestLimiter(0);
    expect(await clock.limiter.awaitRateLimit({ model })).toBe(0);
    expect(await clock.limiter.awaitRateLimit({ model })).toBe(0);
    // 不限速的 provider 不建桶、不留状态，因此也没有唤醒定时器。
    expect(clock.scheduledWake).toBeUndefined();
  });

  it("令牌桶按节奏补令牌：满桶连发，随后按每分钟配额等待", async () => {
    const clock = createTestLimiter(2);
    expect(await clock.limiter.awaitRateLimit({ model })).toBe(0);
    expect(await clock.limiter.awaitRateLimit({ model })).toBe(0);

    const third = clock.limiter.awaitRateLimit({ model });
    expect(clock.scheduledWake).toBeTypeOf("function");
    clock.advance(30_000);
    clock.scheduledWake?.();
    expect(await third).toBe(30_000);

    // 时钟回拨（系统改时间 / NTP 校正）不凭空造令牌。
    const state = { requestsPerMinute: 2, tokens: 0, updatedAtMs: 1_000 };
    refillQuotaState(state, 500);
    expect(state.tokens).toBe(0);
  });

  it("装饰只补配额那一条：inner 缺席时不凭空加限速，配额-only 端口不提供 tryAcquire", async () => {
    const clock = createTestLimiter(60);
    const port: ProviderRateLimitPort = clock.limiter;
    expect(withProviderRateLimit(undefined, port)).toBeUndefined();

    const ticket = { release: () => undefined };
    const inner: ModelRequestAdmission = {
      awaitRateLimit: async () => -1,
      tryAcquire: () => ({ ...ticket, publish: () => undefined }),
      acquire: async () => ({ ...ticket, publish: () => undefined }),
    };
    const decorated = withProviderRateLimit(inner, port)!;
    // 并发那一层原样保留，只有 awaitRateLimit 被换成限速器的实现。
    expect(decorated.tryAcquire).toBe(inner.tryAcquire);
    expect(decorated.acquire).toBe(inner.acquire);
    expect(await decorated.awaitRateLimit!({ model })).toBe(0);

    const quotaOnly = createRateLimitOnlyAdmission(port);
    // 没有快路径，runner 因此不发并发那一条排队事件；并发语义逐字不变。
    expect(quotaOnly.tryAcquire).toBeUndefined();
    expect(await quotaOnly.awaitRateLimit!({ model })).toBe(0);
    await expect(quotaOnly.acquire({ model })).resolves.toMatchObject({
      publish: expect.any(Function),
      release: expect.any(Function),
    });
  });

  it("共享账本按账号指纹分桶，位置读不到就不共享且不回落到硬编码路径", () => {
    const base = {
      providerId: "relay",
      apiType: "openai-chat",
      baseUrl: "https://relay.example/v1",
    };
    const first = computeSharedQuotaKey({ ...base, apiKey: "key-a" });
    const second = computeSharedQuotaKey({ ...base, apiKey: "key-b" });
    expect(computeSharedQuotaKey({ ...base, apiKey: "key-a" })).toBe(first);
    // 同一个 providerId 配两个 Key（中转站的两个账号）各算各的，不互相限流。
    expect(second).not.toBe(first);
    // 凭据只进哈希：文件里的键看不到 Key 本身。
    expect(first).not.toContain("key-a");
    expect(first.startsWith("relay--")).toBe(true);

    expect(
      resolveProviderQuotaSharedFilePath(
        { [PROVIDER_QUOTA_SHARED_FILE_ENV]: "D:\\zcode\\quota.json" },
        "win32",
      ),
    ).toBe("D:\\zcode\\quota.json");
    expect(
      resolveProviderQuotaSharedFilePath({ [PROVIDER_QUOTA_SHARED_FILE_ENV]: "off" }, "win32"),
    ).toBeUndefined();
    // 注入的空 env 不能静默写到真实机器的共享位置。
    expect(resolveProviderQuotaSharedFilePath({}, "win32")).toBeUndefined();
    expect(resolveProviderQuotaSharedFilePath({}, "linux")).toBeUndefined();
  });

  it("清单公开入口与契约文件一致", () => {
    expect(providerRequestPolicyModule.id).toBe("provider-request-policy");
    expect(providerRequestPolicyModule.publicEntrypoints).toContain("contract.ts");
  });
});
