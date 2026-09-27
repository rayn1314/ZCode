import {
  isApiKeyAccess,
  type ProviderApiType,
  type ProviderConfigObject,
  type ProviderRequestPolicy,
} from "@zcode/provider";
import {
  getProviderFormLabel,
  type ProviderSettingsFormProvider,
} from "@/lib/providerSettingsFormTypes.js";

export interface ProviderDraftValues {
  nameValue: string;
  apiFormat: ProviderApiType;
  baseUrlValue: string;
  apiKeyValue: string;
  /** 原样保留用户输入；空串表示「不限制」。上界 600 与 `providerRateLimitRequestsPerMinuteDataSchema` 同源。 */
  requestsPerMinuteValue: string;
}

/** 与 `providerRateLimitRequestsPerMinuteDataSchema` 的值域同源，避免 UI 允许写出非法整数。 */
export const PROVIDER_REQUESTS_PER_MINUTE_MIN = 1;
export const PROVIDER_REQUESTS_PER_MINUTE_MAX = 600;

/**
 * 空串与任何非纯数字串都 → null（不限制）；越界值收敛到 [1,600]，手输 0/999 时也不会把非法值写进盘。
 *
 * 刻意**不**做「抽出其中数字」的宽松解析：那是把 8.5 猜成 8、把 1a 猜成 1，用户会得到一个自己从没
 * 填过的额度。非法输入宁可当成没填（保持草稿原样等用户改），也不要写进盘。
 */
export function parseProviderRequestsPerMinuteDraft(value: string): number | null {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number.parseInt(trimmed, 10);
  return Math.min(
    Math.max(parsed, PROVIDER_REQUESTS_PER_MINUTE_MIN),
    PROVIDER_REQUESTS_PER_MINUTE_MAX,
  );
}

export function formatProviderRequestsPerMinuteDraft(value: number | null): string {
  return value == null ? "" : String(value);
}

/**
 * 把稀疏叶子补丁合并到各自基线。返回 undefined 表示「这次编辑不该产生 requestPolicy 键」，
 * 调用方必须整个省略这个键——留下 `requestPolicy: undefined` 和写 `{}` 一样是往盘里塞噪声。
 */
function applyRequestPolicyChanges(
  base: ProviderConfigObject["requestPolicy"],
  changes: Partial<ProviderRequestPolicy>,
): ProviderRequestPolicy | undefined {
  // 空策略对象与「没配」是同一件事，不该写进盘；省略键才表示继承 template。
  const merged = { ...base, ...changes };
  return Object.keys(merged).length > 0 ? merged : undefined;
}

function normalizeConfiguredBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!normalized) return "";

  try {
    const parsed = new URL(normalized);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return normalized;
    const marker = `${parsed.protocol}//${parsed.host}`;
    const duplicateIndex = normalized.indexOf(marker, marker.length);
    if (duplicateIndex < 0) return normalized;
    const firstUrl = normalized.slice(0, duplicateIndex).replace(/\/+$/, "");
    const secondUrl = normalized.slice(duplicateIndex).replace(/\/+$/, "");
    // 旧设置页曾把完整 Base URL 再作为 path 拼接；仅折叠两段完全相同的安全形态。
    return firstUrl === secondUrl ? firstUrl : normalized;
  } catch {
    return normalized;
  }
}

export function resolvePendingProviderDraftSave({
  provider,
  draft,
  readOnlyEndpoints,
  nameConfirmed = false,
}: {
  provider: ProviderSettingsFormProvider;
  draft: ProviderDraftValues;
  readOnlyEndpoints?: boolean;
  nameConfirmed?: boolean;
  now: () => number;
}): ProviderSettingsFormProvider | null {
  const label = draft.nameValue.trim();
  const baseURL = normalizeConfiguredBaseUrl(draft.baseUrlValue);
  // ID 和默认协议只用于空配置的表单展示，不是用户覆盖；脏检查与表单初始化必须同源。
  // 名称只在 Enter/失焦确认；连接的闲时保存、测试和卸载不能夹带未确认的名称。
  const labelChanged = nameConfirmed && label !== getProviderFormLabel(provider);
  const typeChanged =
    !readOnlyEndpoints && draft.apiFormat !== (provider.config.api?.type ?? "anthropic-messages");
  const urlChanged = !readOnlyEndpoints && baseURL !== (provider.config.api?.baseUrl ?? "");
  const keyChanged =
    isApiKeyAccess(provider.config.access) &&
    draft.apiKeyValue !== (provider.config.access.apiKey ?? "");
  // 表单展示 effective 值，脏检查因此与 effective 同源；personal 层只用来判断
  // 「清空是否真的有东西要撤」，避免把从未覆盖过的叶子写成 null 抹掉 template。
  const effectiveRequestPolicy = provider.config.requestPolicy;
  const personalRequestPolicy = provider.personalConfig.requestPolicy;
  const effectiveRequestsPerMinute = effectiveRequestPolicy?.requestsPerMinute ?? null;
  const requestsPerMinuteValue = parseProviderRequestsPerMinuteDraft(draft.requestsPerMinuteValue);
  const requestsPerMinuteChanged = requestsPerMinuteValue !== effectiveRequestsPerMinute;
  if (!labelChanged && !typeChanged && !urlChanged && !keyChanged && !requestsPerMinuteChanged) {
    return null;
  }

  // 表单只拥有名称、连接类型、地址和 Key；重建整个 api 会删除隐藏 headers，
  // 保存 Effective 对象又会把继承字段物化。分别在各自基线上只应用修改过的叶子。
  const apiChanges = {
    ...(typeChanged || (urlChanged && !provider.config.api?.type) ? { type: draft.apiFormat } : {}),
    ...(urlChanged ? { baseUrl: baseURL || undefined } : {}),
  };
  const api =
    typeChanged || urlChanged ? { ...provider.config.api, ...apiChanges } : provider.config.api;
  // requestPolicy 同样是稀疏嵌套对象：只把用户动过的叶子放进补丁。
  // 写 null 的前提是 personal 层真的有东西要撤，否则会顺手把从 template 继承的额度抹成不限制。
  const personalRequestsPerMinute = personalRequestPolicy?.requestsPerMinute ?? null;
  const requestPolicyChanges: Partial<ProviderRequestPolicy> = !requestsPerMinuteChanged
    ? {}
    : requestsPerMinuteValue == null
      ? personalRequestsPerMinute == null
        ? {}
        : { requestsPerMinute: null }
      : { requestsPerMinute: requestsPerMinuteValue };
  // effective 视图承载用户刚表达的完整意图；personal 层只收稀疏补丁，两边都可能是「无键」。
  const nextEffectiveRequestPolicy = applyRequestPolicyChanges(
    effectiveRequestPolicy,
    requestsPerMinuteChanged ? { requestsPerMinute: requestsPerMinuteValue } : {},
  );
  const nextPersonalRequestPolicy = applyRequestPolicyChanges(
    personalRequestPolicy,
    requestPolicyChanges,
  );
  const access =
    keyChanged && isApiKeyAccess(provider.config.access)
      ? { ...provider.config.access, apiKey: draft.apiKeyValue }
      : provider.config.access;
  const config = {
    ...provider.config,
    access,
    api,
    ...(nextEffectiveRequestPolicy ? { requestPolicy: nextEffectiveRequestPolicy } : {}),
  };

  const personalConfig = {
    ...provider.personalConfig,
    ...(keyChanged && isApiKeyAccess(provider.config.access)
      ? {
          access: {
            ...provider.personalConfig.access,
            type: provider.config.access.type,
            apiKey: draft.apiKeyValue,
          },
        }
      : {}),
    ...(typeChanged || urlChanged
      ? { api: { ...provider.personalConfig.api, ...apiChanges } }
      : {}),
    ...(nextPersonalRequestPolicy ? { requestPolicy: nextPersonalRequestPolicy } : {}),
  };

  if (!labelChanged && JSON.stringify(config) === JSON.stringify(provider.config)) {
    return null;
  }
  return {
    ...provider,
    ...(labelChanged ? { providerName: label || null, providerNameUpdate: label || null } : {}),
    config,
    personalConfig,
  };
}
