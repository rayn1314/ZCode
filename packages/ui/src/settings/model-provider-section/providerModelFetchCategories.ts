import type { FetchedProviderModel } from "@zcode/services";

/**
 * 常见模型 ID 前缀 → 供应商名。
 *
 * 借鉴 new-api 的 `resolveModelProvider` 思路：上游 `/v1/models` 不返回
 * `owned_by`（如 Anthropic 端点）时，用模型 ID 前缀启发式推断供应商用于分组。
 */
const MODEL_PROVIDER_ID_RULES: readonly { provider: string; keywords: readonly string[] }[] = [
  {
    provider: "OpenAI",
    keywords: [
      "gpt-",
      "chatgpt-",
      "o1-",
      "o3-",
      "o4-",
      "dall-e-",
      "whisper-",
      "tts-",
      "text-embedding-",
      "text-moderation-",
    ],
  },
  { provider: "Anthropic", keywords: ["claude-"] },
  { provider: "Google", keywords: ["gemini-"] },
  { provider: "Meta", keywords: ["llama-"] },
  { provider: "DeepSeek", keywords: ["deepseek-"] },
  { provider: "智谱", keywords: ["glm-"] },
  { provider: "通义千问", keywords: ["qwen-", "qwq-"] },
  { provider: "月之暗面", keywords: ["moonshot-", "kimi-"] },
  { provider: "Mistral", keywords: ["mistral-"] },
  { provider: "Cohere", keywords: ["command-"] },
  { provider: "xAI", keywords: ["grok-"] },
  { provider: "豆包", keywords: ["doubao-", "seed-"] },
  { provider: "百度", keywords: ["ernie-"] },
  { provider: "腾讯", keywords: ["hunyuan-"] },
  { provider: "讯飞", keywords: ["spark-"] },
];

function inferModelProviderFromId(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  for (const rule of MODEL_PROVIDER_ID_RULES) {
    if (rule.keywords.some((keyword) => lower.includes(keyword))) return rule.provider;
  }
  return undefined;
}

/** 模型分组名：优先 ownedBy，其次按 ID 前缀推断，最后归入 "other"。 */
export function getModelCategory(model: FetchedProviderModel): string {
  const ownedBy = model.ownedBy?.trim();
  return ownedBy || inferModelProviderFromId(model.id) || "other";
}

export type ModelGroup = readonly [category: string, models: readonly FetchedProviderModel[]];

/** 分组并按组名排序；"other" 始终排到最后（与 new-api 的排序策略一致）。 */
export function groupModelsByCategory(
  models: readonly FetchedProviderModel[],
): readonly ModelGroup[] {
  const groups = new Map<string, FetchedProviderModel[]>();
  for (const model of models) {
    const category = getModelCategory(model);
    const list = groups.get(category);
    if (list) list.push(model);
    else groups.set(category, [model]);
  }
  return [...groups.entries()].sort(([a], [b]) => {
    if (a === "other") return 1;
    if (b === "other") return -1;
    return a.localeCompare(b, undefined, { sensitivity: "base" });
  });
}
