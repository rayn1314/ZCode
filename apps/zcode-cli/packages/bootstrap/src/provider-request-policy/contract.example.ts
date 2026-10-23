/**
 * provider-request-policy 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ModelRequestAdmission, ModelRequestTarget } from "@zcode/contracts";
import {
  createProviderQuotaSharing,
  createRateLimitOnlyAdmission,
  getProviderRateLimiter,
  withProviderRateLimit,
  type ProviderConfigReader,
  type ProviderRateLimitPort,
} from "./contract.js";

/**
 * 装配一次限速（`create-app.ts` 的唯一装配点）：算账本 → 取进程单例端口 → 装饰既有准入端口。
 *
 * `env` 缺席时共享文件位置按 `process.env` 读；位置算不出来（非 Windows / 非 WSL）就不共享，
 * 各进程各限各的。返回的 `admission` 可能缺席——既有并发闸门不存在时不要凭空加一层限速。
 */
export function exampleWireProviderRateLimit(input: {
  readProviderConfig: ProviderConfigReader;
  /** 主代理 / 子代理拿到的既有准入端口（并发治理器的 observer）。 */
  governor: ModelRequestAdmission;
  env?: Readonly<Record<string, string | undefined>>;
}): {
  admission: ModelRequestAdmission | undefined;
  /** 给不参与并发治理的 legacy workflow 子代理：只带配额，不设并发闸门。 */
  legacyAdmission: ModelRequestAdmission;
} {
  const sharing = createProviderQuotaSharing({
    readProviderConfig: input.readProviderConfig,
    ...(input.env === undefined ? {} : { env: input.env }),
  });
  const rateLimit = getProviderRateLimiter({
    // 每次请求重读：设置页改完立刻生效，不重建桶。
    resolveRequestsPerMinute: (providerId) =>
      input.readProviderConfig(providerId)?.requestPolicy?.requestsPerMinute ?? undefined,
    resolveSharedBucketKey: sharing.resolveSharedBucketKey,
    ...(sharing.sharedStore === undefined ? {} : { sharedStore: sharing.sharedStore }),
  });
  return {
    admission: withProviderRateLimit(input.governor, rateLimit),
    legacyAdmission: createRateLimitOnlyAdmission(rateLimit),
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
