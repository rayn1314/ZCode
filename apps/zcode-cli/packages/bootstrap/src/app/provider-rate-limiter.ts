// ============================================================
// per-provider 请求速率限制（令牌桶；进程内默认，可选跨进程共享）
// ============================================================
// 「这个 provider 每分钟最多发 N 个模型请求」，N 可空（不限制）。配额长在**账号**上，不在会话
// 上，所以桶是进程级的：主代理、workflow 的所有 run、legacy Workflow 工具的子代理、工具内部的
// 模型调用共用同一份额度。桶键就是 providerId——一条 provider 配置 = 一份策略 = 一个桶；同一家
// 供应商的多个 Key 要各算各的配额，就多建一条 provider 配置。
//
// 速率不是唯一的节奏约束：有的服务商**只限并发不限次数**（N 个在飞），且超发时不返回 429 而是
// 静默排队。那种约束下「按速率限完并发自然被压住」不成立——长时间流（一次 60s）会把平均在飞数
// 顶到 `RPM × 时长 / 60`，本地若没有并发闸门就只能等上游队列变长、超时、重试。并发那半边由
// `requestPolicy.maxConcurrent` + 治理器的 provider 闸门负责（见 workflow-concurrency-governor）。
// 429 处理策略依旧多余：不主动撞墙就不会触发，真撞了走既有的指数退避即可。
//
// **与并发闸门的关系是「先它后槽」**，见 contracts 的 ModelRequestAdmission 注释：限速层只读
// 自己的令牌桶、不碰任何并发槽，因此等待它不会与等待槽位形成环。反过来（持槽等令牌）会死锁：
// 槽被等令牌的人占着，令牌要靠已发出的请求补充，而别人在排队等槽。
//
// 令牌桶而不是滑动窗口：滑动窗口要保留每个请求的时间戳、状态随在飞量线性增长，而桶是三个标量。
// 代价是「一分钟内最多 N 次」在突发边界上略有出入（桶满时 N 次可立刻发出，随后按 N/60000 每毫秒
// 匀速补），对配额约束而言这正是想要的语义——用户配的是**节奏**，不是精确的窗口计数。
//
// 跨进程共享（同机多端，见 provider-quota-shared-store.ts）：进程内的桶只能管住自己这个进程，
// 于是「Windows 限 20/min、WSL 限 20/min」合计能到 40/min。给定共享账本时改走账本、由文件锁
// 保证两端共用一个余额；账本不可达则**降级为进程内限速**，绝不 fail-open。

import type {
  Logger,
  ModelRequestAdmission,
  ModelRequestTarget,
} from "@zcode/contracts";
import {
  normalizeRequestsPerMinute,
  msUntilNextQuotaToken,
  refillQuotaState,
  type QuotaState,
} from "./provider-quota-math.js";
import type { ProviderQuotaSharedStore } from "./provider-quota-shared-store.js";

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
  /** 跨进程共享账本；缺席则一切照旧（各进程各限各的）。 */
  sharedStore?: ProviderQuotaSharedStore;
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

/** 进程内的桶 = 令牌桶状态 + 等待者与定时器（那两样是纯数学里没有的）。 */
interface Bucket extends QuotaState {
  /** 等待者 FIFO：先进先出，避免密集流量下有人被永久跳过。 */
  waiters: Waiter[];
  /** 已排定的唤醒定时器；同一时刻至多一个（惊群会让 N 个等待者抢同一个令牌）。 */
  cancelWake?: () => void;
  /** 该定时器被排定在什么时刻——抬高上限后要据此判断能否提前唤醒。 */
  wakeAtMs?: number;
}

/** 降级告警的节流窗口：账本长期不可达时别再刷屏，一次说清就够。 */
const DEGRADE_LOG_INTERVAL_MS = 60_000;

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等令牌的定时器把进程钉住：用户 Ctrl-C 之后它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createProviderRateLimiter(
  options: ProviderRateLimiterOptions,
): ProviderRateLimitPort {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  let lastDegradeLoggedAtMs: number | undefined;

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
    const delayMs = msUntilNextQuotaToken(bucket);
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
    refillQuotaState(bucket, atMs);
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

  /** 进程内限速：也是共享账本不可达时的退路。 */
  const awaitLocalQuota = async (
    providerId: string,
    requestsPerMinute: number,
    signal: AbortSignal | undefined,
  ): Promise<number> => {
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
    if (signal?.aborted === true) throw signal.reason;
    return await new Promise<number>((resolve, reject) => {
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
  };

  /** 睡一小段（等账本说的下一个令牌时刻）。与进程内的等待一样，abort 立刻生效。 */
  const waitForDelay = (delayMs: number, signal: AbortSignal | undefined): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      let settled = false;
      const cancel = schedule(() => {
        if (settled) return;
        settled = true;
        if (signal !== undefined) signal.removeEventListener("abort", abort);
        resolve();
      }, delayMs);
      const abort = (): void => {
        if (settled) return;
        settled = true;
        cancel();
        reject(signal?.reason);
      };
      if (signal === undefined) return;
      if (signal.aborted) {
        abort();
        return;
      }
      signal.addEventListener("abort", abort, { once: true });
    });

  /**
   * 跨进程限速：每次尝试都由账本在文件锁下原子扣一个令牌。拿不到令牌就按账本说的间隔重试；
   * 账本不可达则退回进程内限速（**不是**放行）。
   *
   * 与进程内那套的差别只在公平性：账本说不出「谁先到」，两端同时醒来时谁抢到算谁的。跨进程的
   * FIFO 要么做不到、要么得把排序状态也搬进文件，不划算——配额约束要的是节奏，不是先后。
   */
  const awaitSharedQuota = async (
    providerId: string,
    requestsPerMinute: number,
    signal: AbortSignal | undefined,
  ): Promise<number> => {
    const store = options.sharedStore;
    if (store === undefined) return awaitLocalQuota(providerId, requestsPerMinute, signal);
    const startedAtMs = now();
    for (;;) {
      if (signal?.aborted === true) throw signal.reason;
      let outcome;
      try {
        outcome = await store.tryConsume({
          key: providerId,
          requestsPerMinute,
          atMs: now(),
        });
      } catch (error) {
        const atMs = now();
        if (
          lastDegradeLoggedAtMs === undefined ||
          atMs - lastDegradeLoggedAtMs >= DEGRADE_LOG_INTERVAL_MS
        ) {
          lastDegradeLoggedAtMs = atMs;
          options.logger?.warn?.(
            "Provider quota shared store unavailable; falling back to process-local limit",
            {
              event: "model.rate_limit.shared_unavailable",
              module: "bootstrap.app",
              providerId,
              requestsPerMinute,
              reason: error instanceof Error ? error.message : String(error),
            },
          );
        }
        // 退回进程内桶：账本读不到时至少还按本进程的额度限着，绝不能一次挂载失败变成完全不限速。
        return await awaitLocalQuota(providerId, requestsPerMinute, signal);
      }
      if (outcome.kind === "granted") return Math.max(0, now() - startedAtMs);
      await waitForDelay(outcome.retryInMs, signal);
    }
  };

  return {
    awaitRateLimit: async (input) => {
      const providerId = String(input.model.providerId);
      const requestsPerMinute = normalizeRequestsPerMinute(
        options.resolveRequestsPerMinute(providerId),
      );
      // 不限速：不建桶、不排定时器、不留任何状态。绝大多数 provider 走这条路。
      if (requestsPerMinute === undefined) return 0;
      const waitedMs =
        options.sharedStore !== undefined
          ? await awaitSharedQuota(providerId, requestsPerMinute, input.signal)
          : await awaitLocalQuota(providerId, requestsPerMinute, input.signal);
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
 *
 * 共享账本只在首次构造时采纳：它读环境变量定位置，而环境在进程内是常量；换 app 只换 resolver。
 */
export function getProviderRateLimiter(options: {
  readonly resolveRequestsPerMinute: ProviderRequestsPerMinuteResolver;
  readonly sharedStore?: ProviderQuotaSharedStore;
}): ProviderRateLimitPort {
  processResolver = options.resolveRequestsPerMinute;
  processRateLimiter ??= createProviderRateLimiter({
    resolveRequestsPerMinute: (providerId) => processResolver?.(providerId),
    ...(options.sharedStore === undefined ? {} : { sharedStore: options.sharedStore }),
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
