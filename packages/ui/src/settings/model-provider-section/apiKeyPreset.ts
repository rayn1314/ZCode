import type { ApiKeyAccessConfigInput } from "@zcode/provider";

/** 与 provider `access.apiKeyPresets` 元素同源；经 provider 包 schema 校验后才落盘。 */
export type ApiKeyPreset = NonNullable<ApiKeyAccessConfigInput["apiKeyPresets"]>[number];

/** 菜单与列表只露尾 4 位：够区分彼此，又不把整段 Key 摊开。 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length <= 4) return "····";
  return `····${trimmed.slice(-4)}`;
}

export function createApiKeyPreset(name: string, apiKey: string): ApiKeyPreset {
  return { id: crypto.randomUUID(), name: name.trim(), apiKey: apiKey.trim() };
}

/**
 * 当前生效预设靠「与生效 Key 按值比对」得出，不引入独立指针：
 * 手改 Key 后自然脱选，也就不存在指针与真实 Key 走散的问题。
 */
export function findActiveApiKeyPreset(
  presets: readonly ApiKeyPreset[],
  apiKey: string,
): ApiKeyPreset | undefined {
  if (!apiKey) return undefined;
  return presets.find((preset) => preset.apiKey === apiKey);
}
