/**
 * provider-model-fetch 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ProviderApiType } from "@zcode/provider";
import {
  createProviderModelFetcher,
  ProviderModelFetchError,
  type ProviderModelFetchDialogProps,
  type ProviderModelFetchRequest,
  type ProviderModelFetchResult,
} from "./contract.js";

/** 端口类型别名：装配方注入的就是 `createProviderModelFetcher` 的返回值。 */
export type ProviderModelFetcherAlias = ReturnType<typeof createProviderModelFetcher>;

/**
 * 装配一次：`fetch` 由装配层注入 Host 的 HTTP transport（代理 / CA 生效），服务端唯一创建点。
 * 端口无状态，可以在整个进程里共用一份（`node.ts` 的 `fetchProviderModels`）。
 */
export function exampleCreateFetcher(fetchImpl: typeof fetch): ProviderModelFetcherAlias {
  return createProviderModelFetcher({ fetch: fetchImpl });
}

/** 一次真实调用：取表单当前值，失败按 `code` 分类展示本地化文案。 */
export async function exampleFetchModels(
  fetchModels: ProviderModelFetcherAlias,
  request: ProviderModelFetchRequest,
): Promise<readonly string[]> {
  try {
    const result: ProviderModelFetchResult = await fetchModels(request);
    return result.models.map((model) => model.id);
  } catch (error) {
    if (error instanceof ProviderModelFetchError) {
      // 分类错误码（missing-config / auth / not-found / timeout / parse / http / network）。
      throw new Error(`fetch models failed: ${error.code}`);
    }
    throw error;
  }
}

/** 弹窗的 props 用法：表单当前值 + 端口 + 已有模型 ID，提交走 `onAddModels`。 */
export function exampleDialogProps(input: {
  apiFormat?: ProviderApiType;
  apiKey: string;
  baseUrl: string;
  configuredModelIds: readonly string[];
  fetchModels: ProviderModelFetcherAlias;
  onAddModels: (modelIds: readonly string[]) => Promise<void>;
  providerId: string;
}): ProviderModelFetchDialogProps {
  return {
    open: true,
    onOpenChange: () => undefined,
    providerId: input.providerId,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    ...(input.apiFormat === undefined ? {} : { apiFormat: input.apiFormat }),
    configuredModelIds: input.configuredModelIds,
    fetchModels: input.fetchModels,
    onAddModels: input.onAddModels,
  };
}
