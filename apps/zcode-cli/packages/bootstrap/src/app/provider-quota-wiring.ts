// ============================================================
// provider 配额的装配：从「已解析的 Provider 配置 + 环境」算出限速器要的共享部分
// ============================================================
// 限速器本身是进程单例、且刻意不认识 Provider Registry（它只吃两个 resolver），所以「账本落在哪个
// 文件、桶按什么键分」这段决策既不属于账本（纯文件语义）也不属于限速器（纯配额语义），只能由装配层
// 决定。放在这里而不是内联在 create-app.ts 里，是为了让这段决策能被单测钉住——它错的方式很安静：
// 键算成 providerId 会让同机两个不同 Key 互相限流，路径算错会让共享静默失效。

import type { Logger } from "@zcode/contracts";
import type { ProviderConfig } from "@zcode/provider";
import type { ProviderSharedQuotaKeyResolver } from "./provider-rate-limiter.js";
import {
  computeSharedQuotaKey,
  createFileProviderQuotaStore,
  resolveProviderQuotaSharedFilePath,
  type ProviderQuotaSharedStore,
} from "./provider-quota-shared-store.js";

/** 读某个 provider 已解析的配置。窄端口：限速装配只需要单个 provider，不需要整个 Registry。 */
export type ProviderConfigReader = (providerId: string) => ProviderConfig | undefined;

export interface ProviderQuotaSharingInput {
  readProviderConfig: ProviderConfigReader;
  /**
   * 决定账本位置的来源。缺席时按 `resolveProviderQuotaSharedFilePath` 的缺省读 `process.env`——
   * app 的 `env` 本来就是可选注入。
   */
  env?: Readonly<Record<string, string | undefined>>;
  logger?: Logger;
}

/** 交给 `getProviderRateLimiter` 的共享部分。`sharedStore` 缺席 = 不共享，各进程各限各的。 */
export interface ProviderQuotaSharing {
  sharedStore?: ProviderQuotaSharedStore;
  resolveSharedBucketKey: ProviderSharedQuotaKeyResolver;
}

/**
 * 算出跨进程共享所需的两个东西：账本（位置由环境决定，算不出来就没有）与账号指纹键。
 *
 * 键按**账号指纹**分，不按 providerId：配额长在账号上，而同一个 providerId 配不同 Key（中转站的
 * 两个账号）本就该各算各的，按 providerId 分会让它们互相限流。凭据只进哈希，文件里看不到 Key。
 * 读不到 provider（配置还没解析出来）就答 undefined，让它走进程内桶。
 */
export function createProviderQuotaSharing(input: ProviderQuotaSharingInput): ProviderQuotaSharing {
  const filePath = resolveProviderQuotaSharedFilePath(input.env);
  // 位置算出来就交给账本，不在这里做可写性探测：探测通过也仍可能在写入时失败，用不了自然降级。
  const sharedStore =
    filePath === undefined
      ? undefined
      : createFileProviderQuotaStore({
          filePath,
          ...(input.logger === undefined ? {} : { logger: input.logger }),
        });
  return {
    ...(sharedStore === undefined ? {} : { sharedStore }),
    resolveSharedBucketKey: (providerId) => {
      const config = input.readProviderConfig(providerId);
      if (config === undefined) return undefined;
      const access = config.access;
      return computeSharedQuotaKey({
        providerId,
        // 配置里的 `api` 字段是 `| null`（未配置），指纹只认 `string | undefined`。
        apiType: config.api?.type ?? undefined,
        baseUrl: config.api?.baseUrl ?? undefined,
        // 只有 API Key 型凭据进指纹：账号型（智谱账号）的凭据不在配置里，且它本来就按账号分。
        apiKey:
          access?.type === "api-key" || access?.type === "zhipu-coding-plan-api-key"
            ? (access.apiKey ?? undefined)
            : undefined,
      });
    },
  };
}
