/**
 * provider-request-policy 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ModelRequestAdmission, ModelRequestTarget } from "@zcode/contracts";
import {
  createProviderQuotaSharing,
  getProviderRateLimiter,
  withProviderRateLimit,
  type ProviderConcurrencySharedView,
  type ProviderRateLimitPort,
  type ProviderRequestsPerMinuteResolver,
} from "./contract.js";

/**
 * 装配一次请求策略（`create-app.ts` 的唯一装配点）：算账本 → 取进程单例端口 → 装饰既有准入端口。
 *
 * 只装速率这一层：`maxConcurrent` 由治理器的 provider 闸门消费（装配时把 resolver 交给
 * `getWorkflowConcurrencyGovernor`），两层的顺序由 runner 的 `admitAttempt` 保证（先配额后槽）。
 *
 * `env` 缺席时共享文件位置按 `process.env` 读；位置算不出来（非 Windows / 非 WSL）就不共享，
 * 各进程各限各的。返回的 `admission` 可能缺席——既有并发闸门不存在时不要凭空加一层限速。
 *
 * **一站式端口**：主代理、workflow run 与 legacy `Workflow` 工具的子代理都该拿这同一个装饰后的
 * 端口。给 legacy 单独发一张「只限速、并发直通」的票会留下一个旁路——它们发的是同一个 provider
 * 的请求，并发上限照样要被它们遵守。
 */
export function exampleWireProviderRateLimit(input: {
  resolveRequestsPerMinute: ProviderRequestsPerMinuteResolver;
  /** 既有准入端口（并发治理器给主代理/子代理的 observer；legacy 子代理也用它）。 */
  governor: ModelRequestAdmission;
  env?: Readonly<Record<string, string | undefined>>;
}): ModelRequestAdmission | undefined {
  const sharing = createProviderQuotaSharing({
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const rateLimit = getProviderRateLimiter({
    // 每次请求重读：设置页改完立刻生效，不重建桶。
    resolveRequestsPerMinute: input.resolveRequestsPerMinute,
    ...(sharing.sharedStore === undefined ? {} : { sharedStore: sharing.sharedStore }),
  });
  return withProviderRateLimit(input.governor, rateLimit);
}

/**
 * 治理器那一侧的装配：并发硬上限（`maxConcurrent`）与「同机另一端此刻占着几个」都从环境算出的
 * 共享里取。真实的 `create-app.ts` 只调一次 `createProviderQuotaSharing`，把它的两半分别交给
 * 限速器单例（`sharedStore`）与治理器单例（`concurrencyShared`）。
 *
 * `concurrencyShared` 缺席 = 不共享（非 Windows / 非 WSL，或用户显式关掉）：治理器只按本进程的
 * `maxConcurrent` 放行，与加这条共享之前逐字相同。它给的是**收敛读数**（有刷新窗口），不是严格配额。
 */
export function exampleWireConcurrencyGovernor(input: {
  resolveMaxConcurrent: (providerId: string) => number | undefined;
  env?: Readonly<Record<string, string | undefined>>;
}): {
  resolveMaxConcurrent: (providerId: string) => number | undefined;
  sharedConcurrency?: ProviderConcurrencySharedView;
} {
  const sharing = createProviderQuotaSharing({
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  return {
    resolveMaxConcurrent: input.resolveMaxConcurrent,
    ...(sharing.concurrencyShared === undefined
      ? {}
      : { sharedConcurrency: sharing.concurrencyShared }),
  };
}

/**
 * 一次真实调用：发请求前先等令牌，返回值就是本次为配额**实际等待的毫秒数**（0 = 令牌现成）。
 * abort 时以 `signal.reason` reject，不留残余等待者。
 */
export async function exampleAwaitQuota(
  rateLimit: ProviderRateLimitPort,
  model: ModelRequestTarget,
  signal?: AbortSignal,
): Promise<number> {
  return await rateLimit.awaitRateLimit({ model, ...(signal === undefined ? {} : { signal }) });
}
