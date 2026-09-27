// ============================================================
// per-provider 请求速率限制（进程级，按 providerId 分桶，令牌桶）
// ============================================================
// 「这个 provider 每分钟最多发 N 个模型请求」，N 可空（不限制）。配额长在**账号**上，不在会话
// 上，所以桶是进程级的：主代理、workflow 的所有 run、工具内部的模型调用共用同一份额度。
//
// 为什么只有这一个旋钮：服务商侧的约束本来就是「每分钟 N 次」。按它限速后并发自然被压住——
// N=15/min 意味着每 4 秒一个令牌，单次请求约 3 秒，同一时刻最多 1 个在飞，并发上限是冗余的。
// 反过来，429 处理策略也是多余的：不主动撞墙就不会触发，真撞了走既有的指数退避即可。
//
// **与并发闸门的关系是「先它后槽」**，见 contracts 的 ModelRequestAdmission 注释：限速层只读
// 自己的令牌桶、不碰任何并发槽，因此等待它不会与等待槽位形成环。反过来（持槽等令牌）会死锁：
// 槽被等令牌的人占着，令牌要靠已发出的请求补充，而别人在排队等槽。
//
// 令牌桶而不是滑动窗口：滑动窗口要保留每个请求的时间戳、状态随在飞量线性增长，而桶是三个标量。
// 代价是「一分钟内最多 N 次」在突发边界上略有出入（桶满时 N 次可立刻发出，随后按 N/60000 每毫秒
// 匀速补），对配额约束而言这正是想要的语义——用户配的是**节奏**，不是精确的窗口计数。

import type { Logger, ModelRequestAdmission, ModelRequestTarget } from "@zcode/contracts";

/** 限速端口：与并发闸门正交的一层，由 bootstrap 装到各处构造的 `ModelRequestAdmission` 上。 */
export interface ProviderRateLimitPort {
  /** 返回本次为配额**实际等待的毫秒数**，0 = 令牌现成即用。abort 时以 `signal.reason` reject。 */
  awaitRateLimit(input: { model: ModelRequestTarget; signal?: AbortSignal }): Promise<number>;
}

/**
 * 读某个 provider 配了多少「每分钟请求数」。答 undefined / 非法值 = 不限速。
 * 由 bootstrap 从已解析的 Provider Registry 注入：限速器是进程单例，构造时拿不到 per-request
 * 的 provider 配置。**每次请求都重读**——用户在设置里改完就该立刻生效，不必重建桶。
 */
export type ProviderRequestsPerMinuteResolver = (providerId: string) => number | undefined;

export interface ProviderRateLimiterOptions {
  /** 每分钟请求数的查询（可注入）。 */
  resolveRequestsPerMinute: ProviderRequestsPerMinuteResolver;
  /** 时钟（可注入）：毫秒。 */
  now?: () => number;
  /** 定时器（可注入）：令牌补齐时唤醒等待者。返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
  logger?: Logger;
}

interface Waiter {
  resolve: (waitedMs: number) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  enqueuedAtMs: number;
}

interface Bucket {
  requestsPerMinute: number;
  /** 令牌余额（浮点，按经过时间补齐）。 */
  tokens: number;
  /** 上次补算的时刻。 */
  updatedAtMs: number;
  /** 等待者 FIFO：先进先出，避免密集流量下有人被永久跳过。 */
  waiters: Waiter[];
  /** 已排定的唤醒定时器；同一时刻至多一个（惊群会让 N 个等待者抢同一个令牌）。 */
  cancelWake?: () => void;
  /** 该定时器被排定在什么时刻——抬高上限后要据此判断能否提前唤醒。 */
  wakeAtMs?: number;
}

const MINUTE_MS = 60_000;

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等令牌的定时器把进程钉住：用户 Ctrl-C 之后它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/** 配出来的值是否可用。0 与负数会让配额永远补不满——那不是限速，是把所有请求永久挂起。 */
function normalizeRequestsPerMinute(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : undefined;
}

/** 按经过时间补令牌。桶容量 = 每分钟请求数（满桶即允许一次 N 连发）。 */
function refill(bucket: Bucket, nowMs: number): void {
  const elapsed = nowMs - bucket.updatedAtMs;
  // 时钟回拨（系统改时间、NTP 校正）不该凭空造出令牌：负的时间差当作没经过。
  if (elapsed <= 0) {
    bucket.updatedAtMs = nowMs;
    return;
  }
  bucket.updatedAtMs = nowMs;
  bucket.tokens = Math.min(
    bucket.requestsPerMinute,
    bucket.tokens + (elapsed * bucket.requestsPerMinute) / MINUTE_MS,
  );
}

/** 距下一个令牌还有多少毫秒（至少 1ms，向上取整——0 会让定时器空转烧 CPU）。 */
function msUntilNextToken(bucket: Bucket): number {
  const missing = 1 - bucket.tokens;
  if (missing <= 0) return 1;
  return Math.max(1, Math.ceil((missing * MINUTE_MS) / bucket.requestsPerMinute));
}

export function createProviderRateLimiter(
  options: ProviderRateLimiterOptions,
): ProviderRateLimitPort {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();

  const cancelWake = (bucket: Bucket): void => {
    bucket.cancelWake?.();
    bucket.cancelWake = undefined;
    bucket.wakeAtMs = undefined;
  };

  const releaseWaiter = (waiter: Waiter): void => {
    if (waiter.signal !== undefined && waiter.onAbort !== undefined) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
  };

  const removeWaiter = (bucket: Bucket, waiter: Waiter): boolean => {
    const index = bucket.waiters.indexOf(waiter);
    if (index < 0) return false;
    bucket.waiters.splice(index, 1);
    releaseWaiter(waiter);
    return true;
  };

  /** 排下一次唤醒；已有更早的排定就不动（否则抬高上限也救不了已在等的那批人）。 */
  const scheduleWake = (bucket: Bucket, atMs: number): void => {
    const delayMs = msUntilNextToken(bucket);
    if (bucket.cancelWake !== undefined) {
      if (bucket.wakeAtMs !== undefined && bucket.wakeAtMs <= atMs + delayMs) return;
      cancelWake(bucket);
    }
    bucket.wakeAtMs = atMs + delayMs;
    bucket.cancelWake = schedule(() => {
      bucket.cancelWake = undefined;
      bucket.wakeAtMs = undefined;
      drain(bucket, now());
    }, delayMs);
  };

  /** 把能立刻拿到令牌的等待者按 FIFO 放行；剩下的排下一次唤醒。 */
  const drain = (bucket: Bucket, atMs: number): void => {
    refill(bucket, atMs);
    while (bucket.waiters.length > 0 && bucket.tokens >= 1) {
      const waiter = bucket.waiters.shift()!;
      releaseWaiter(waiter);
      bucket.tokens -= 1;
      waiter.resolve(Math.max(0, atMs - waiter.enqueuedAtMs));
    }
    if (bucket.waiters.length === 0) {
      cancelWake(bucket);
      return;
    }
    scheduleWake(bucket, atMs);
  };

  return {
    awaitRateLimit: async (input) => {
      const providerId = String(input.model.providerId);
      const requestsPerMinute = normalizeRequestsPerMinute(
        options.resolveRequestsPerMinute(providerId),
      );
      // 不限速：不建桶、不排定时器、不留任何状态。绝大多数 provider 走这条路。
      if (requestsPerMinute === undefined) return 0;
      const atMs = now();
      let bucket = buckets.get(providerId);
      if (bucket === undefined) {
        bucket = { requestsPerMinute, tokens: requestsPerMinute, updatedAtMs: atMs, waiters: [] };
        buckets.set(providerId, bucket);
      } else {
        // 配置是每次请求重读的：改了上限立刻生效。**不重置余额**——抬高上限只放宽「最多还要
        // 等多久」，已经累积的令牌不该被抹掉；调低则由 refill 的容量钳制自然收紧。
        bucket.requestsPerMinute = requestsPerMinute;
      }
      const current = bucket;
      // 先放行既有等待者，再考虑自己：新来的不能插队到已经排队的请求前面。
      drain(current, atMs);
      if (current.tokens >= 1) {
        current.tokens -= 1;
        return 0;
      }
      const signal = input.signal;
      if (signal?.aborted === true) throw signal.reason;
      const waitedMs = await new Promise<number>((resolve, reject) => {
        const waiter: Waiter = {
          enqueuedAtMs: atMs,
          reject,
          resolve,
          ...(signal === undefined ? {} : { signal }),
        };
        if (signal !== undefined) {
          const onAbort = (): void => {
            // abort 必须**立刻**返回且不留残余：等待者摘掉后若队列空了，定时器也一并撤掉，
            // 否则用户取消之后进程还会被一个无主的 setTimeout 拖住。
            if (!removeWaiter(current, waiter)) return;
            if (current.waiters.length === 0) cancelWake(current);
            reject(signal.reason);
          };
          waiter.onAbort = onAbort;
          signal.addEventListener("abort", onAbort, { once: true });
        }
        current.waiters.push(waiter);
        if (current.cancelWake === undefined) scheduleWake(current, atMs);
      });
      // 每分钟配额是「攒出来的一分钟里的一小段等待」，值得一条 info 让用户知道转圈是在等什么；
      // 只报真正等了的那次（>0），不限速的 provider 不会刷屏。
      if (waitedMs > 0) {
        options.logger?.info?.("Model request rate limit wait", {
          event: "model.rate_limit.wait",
          module: "bootstrap.app",
          providerId,
          requestsPerMinute,
          waitedMs,
        });
      }
      return waitedMs;
    },
  };
}

let processRateLimiter: ProviderRateLimitPort | undefined;
/**
 * 当前 app 背后的 resolver。限速器是单例、只在首次构造时吃 options，所以单例必须读一个可改写的
 * 间接层：进程里的多个 app 先后取用单例时，后一个要能把 resolver 换成自己的 Registry。
 */
let processResolver: ProviderRequestsPerMinuteResolver | undefined;

/**
 * 进程级单例：配额长在账号上，同一进程里的多个会话（app）必须共用一份桶，否则每个会话各发 N 次，
 * 加起来照样撞墙。取用时重新绑定 resolver，让桶始终读**当前** app 背后的 Provider Registry。
 */
export function getProviderRateLimiter(options: {
  readonly resolveRequestsPerMinute: ProviderRequestsPerMinuteResolver;
}): ProviderRateLimitPort {
  processResolver = options.resolveRequestsPerMinute;
  processRateLimiter ??= createProviderRateLimiter({
    resolveRequestsPerMinute: (providerId) => processResolver?.(providerId),
  });
  return processRateLimiter;
}

/**
 * 把限速闸门装到一个准入端口上。inner 缺席就原样返回 undefined——没有并发闸门的调用方不该被
 * 凭空加上一层限速。
 *
 * 装饰而不是改造既有实现：并发治理器（主代理的 observer、driver 的 governed）都不知道 provider
 * 配置，也不该知道；限速是另一层正交的闸门。
 */
export function withProviderRateLimit(
  inner: ModelRequestAdmission | undefined,
  rateLimit: ProviderRateLimitPort,
): ModelRequestAdmission | undefined {
  if (inner === undefined) return undefined;
  return { ...inner, awaitRateLimit: rateLimit.awaitRateLimit };
}
