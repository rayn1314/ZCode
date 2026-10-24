// ============================================================
// provider-model-fetch 对外契约：从供应商端点拉取可用模型列表
// ============================================================
// 意图：「服务商卡片 → 拉取模型」那条路径：用 OpenAI 兼容的 `GET /v1/models`（并兼容 Anthropic 子路径
// 与 `/vN` 版本段）从 baseURL 候选列表里依次尝试，把结果交给设置页让用户勾选后加入配置。
//
// 调用方必须知道的不变量：
//
// 1. **网络只在服务端发生**：`fetch` 由装配层注入 Host 的 HTTP transport（代理 / CA 生效），
//    渲染进程不直接访问供应商端点；请求参数取设置表单的**当前值**，不是已保存配置。
// 2. **候选顺序固定**（`buildModelFetchUrlCandidates`）：baseURL 已以版本段 `/v{N}` 结尾时模型端点是
//    `{base}/models`（版本段非 `/v1` 时再追加 `{base}/v1/models` 兜底）；否则先拼 `{base}/v1/models`；
//    命中已知 Anthropic 兼容后缀时再追加「剥离后缀 + `/v1/models`、`/models`」。结果去重且保序。
// 3. **逐候选降级**：404 / 405 继续下一个候选；401 / 403 立即以 `auth` 失败（换 URL 不会变好）；
//    其它非 2xx 以 `http` 失败；全部候选都 404 时以 `not-found` 失败。
// 4. **结果收敛**：按模型 ID 排序并去重，重复条目保留首次出现的 `ownedBy`；`data[].id`（OpenAI /
//    Anthropic）与 `models[].slug`（智谱）两种形状都能解析。
// 5. **不泄漏凭据**：错误消息里的 API Key 一律替换为 `[REDACTED]`，404 响应体截断到 512 字符
//    （几十 KB 的 HTML 404 页不该整页进错误串）。
// 6. **无状态**：每次调用独立 AbortController 与超时（默认 15s），超时归类为 `timeout`；调用方可以
//    直接重试，不需要清理上一次的残留。
//
// 装配与消费：`packages/services/src/node.ts` 用 Host transport 造出该端口（`fetchProviderModels`），
// 经 `@zcode/services` 公开出口给设置页；弹窗由 `ProviderCardSections.tsx` 渲染。

import {
  type FetchedProviderModel,
  type ProviderModelFetchErrorCode,
  type ProviderModelFetchRequest,
  type ProviderModelFetchResult,
  type ProviderModelFetcher,
  ProviderModelFetchError,
  buildModelFetchHeaders,
  buildModelFetchUrlCandidates,
  createProviderModelFetcher,
  endsWithVersionSegment,
  stripCompatSuffix,
} from "../providerModelFetch.js";

/** 契约的对外出口：端口、错误分类与纯 helper（候选 URL / 鉴权头）全部来自实现文件。 */
export {
  ProviderModelFetchError,
  buildModelFetchHeaders,
  buildModelFetchUrlCandidates,
  createProviderModelFetcher,
  endsWithVersionSegment,
  stripCompatSuffix,
};
export type {
  FetchedProviderModel,
  ProviderModelFetchErrorCode,
  ProviderModelFetchRequest,
  ProviderModelFetchResult,
  ProviderModelFetcher,
};

/**
 * 「拉取模型」弹窗的 props 形状——**唯一来源**。
 *
 * 渲染方 `packages/ui/src/settings/model-provider-section/ProviderModelFetchDialog.tsx` 直接把这个
 * 类型当作组件入参类型，不再自带一份等价形状；本文件经 `@zcode/services` 出口暴露给 UI。
 * 因此改这里、或改 .tsx 里多写/少写/改名一个字段，都会在 `pnpm typecheck` 阶段报错（services 与 ui
 * 都在根 workspace 的 tsc 工程列表内），不会静默漂移。
 *
 * 注：`onAddModels` 缺席即只读浏览。
 */
export interface ProviderModelFetchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 表单当前值：不是已保存配置。 */
  providerId: string;
  baseUrl: string;
  apiKey: string;
  apiFormat?: ProviderModelFetchRequest["apiFormat"];
  /** 已在本供应商配置里的模型 ID：它们在弹窗里不可再选（勾选态显示「已添加」）。 */
  configuredModelIds: readonly string[];
  fetchModels: ProviderModelFetcher;
  /** 提交选中项；缺席时「添加所选」按钮禁用。 */
  onAddModels?: (modelIds: readonly string[]) => Promise<void>;
}
