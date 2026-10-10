// ============================================================
// Provider Model Fetch - 从供应商端点拉取可用模型列表
// ============================================================
// 借鉴 CCSwitch（farion1231/cc-switch）的 fetch_models_for_config：
// 用 OpenAI 兼容的 GET /v1/models 端点，对 baseURL 生成候选列表并依次尝试，
// 兼容 Anthropic 子路径与 `/vN` 版本段；响应兼容 OpenAI/Anthropic 的
// `data[]` 与智谱的 `models[].slug` 两种形状。
//
// 与 `testModelConnectivity` 一样，网络调用只发生在服务端（node side），
// 复用 Host 的 HTTP transport（代理/CA 设置），渲染进程不直接访问供应商端点。

import type { ProviderApiType } from "@zcode/provider";

/** 拉取到的模型条目（`/v1/models` 通常只给 ID 与归属，不给元数据）。 */
export interface FetchedProviderModel {
  readonly id: string;
  readonly ownedBy?: string;
}

/** 拉取模型列表的请求参数；取设置表单的当前值，而不是已保存配置。 */
export interface ProviderModelFetchRequest {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly apiFormat?: ProviderApiType;
}

export interface ProviderModelFetchResult {
  readonly models: readonly FetchedProviderModel[];
}

/** 拉取失败的可分类错误码，UI 据此展示本地化文案。 */
export type ProviderModelFetchErrorCode =
  | "missing-config"
  | "auth"
  | "not-found"
  | "timeout"
  | "parse"
  | "http"
  | "network";

export class ProviderModelFetchError extends Error {
  readonly code: ProviderModelFetchErrorCode;

  constructor(code: ProviderModelFetchErrorCode, message: string) {
    super(message);
    this.name = "ProviderModelFetchError";
    this.code = code;
  }
}

export type ProviderModelFetcher = (
  input: ProviderModelFetchRequest,
) => Promise<ProviderModelFetchResult>;

const MODEL_FETCH_TIMEOUT_MS = 15_000;
/** 404/405 响应体截断长度：避免把几十 KB HTML 404 页整页保留到错误串里。 */
const ERROR_BODY_MAX_CHARS = 512;

/**
 * 已知的「Anthropic 协议兼容子路径」后缀；按长度降序，最长前缀优先匹配。
 * baseURL 命中这些后缀时，候选列表会追加「剥离后缀再拼 /v1/models / /models」的版本。
 */
const KNOWN_COMPAT_SUFFIXES: readonly string[] = [
  "/api/claudecode",
  "/api/anthropic",
  "/apps/anthropic",
  "/api/coding",
  "/claudecode",
  "/anthropic",
  "/step_plan",
  "/coding",
  "/claude",
];

/** 判断 baseURL 是否以 OpenAI 风格的版本段 `/v{N}` 结尾（N 为一个或多个数字）。 */
export function endsWithVersionSegment(url: string): boolean {
  const last = url.replace(/\/+$/, "").split("/").at(-1) ?? "";
  if (!last.startsWith("v")) return false;
  const digits = last.slice(1);
  return digits.length > 0 && /^\d+$/.test(digits);
}

/** 若 baseURL 以任一已知兼容子路径结尾，返回剥离后的剩余部分；否则 `undefined`。 */
export function stripCompatSuffix(baseUrl: string): string | undefined {
  for (const suffix of KNOWN_COMPAT_SUFFIXES) {
    if (baseUrl.endsWith(suffix)) {
      return baseUrl.slice(0, baseUrl.length - suffix.length);
    }
  }
  return undefined;
}

/**
 * 构造「模型列表端点」的候选 URL 列表。
 *
 * 候选顺序：
 * 1. baseURL 已以版本段 `/v{N}` 结尾（如 `/v1`、智谱 `/api/coding/paas/v4`）时，模型端点是
 *    `{base}/models`，不再补 `/v1`；版本段非 `/v1` 时追加 `{base}/v1/models` 作为兜底。
 * 2. 其余情况先拼 `{base}/v1/models`。
 * 3. baseURL 命中已知兼容子路径时，追加「剥离后缀再拼 `/v1/models`、`/models`」的兜底。
 *
 * 结果已去重且保持首次出现顺序。
 */
export function buildModelFetchUrlCandidates(baseUrl: string): string[] {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return [];

  const candidates: string[] = [];
  if (endsWithVersionSegment(trimmed)) {
    candidates.push(`${trimmed}/models`);
    if (!trimmed.endsWith("/v1")) candidates.push(`${trimmed}/v1/models`);
  } else {
    candidates.push(`${trimmed}/v1/models`);
  }

  const stripped = stripCompatSuffix(trimmed);
  if (stripped) {
    const root = stripped.replace(/\/+$/, "");
    if (root && /^[a-z][a-z\d+.-]*:\/\//i.test(root)) {
      candidates.push(`${root}/v1/models`, `${root}/models`);
    }
  }

  const unique: string[] = [];
  for (const url of candidates) {
    if (!unique.includes(url)) unique.push(url);
  }
  return unique;
}

/** 按 apiFormat 设置鉴权头：Anthropic 用 x-api-key，OpenAI 兼容用 Bearer。 */
export function buildModelFetchHeaders(
  apiKey: string,
  apiFormat: ProviderApiType | undefined,
): Headers {
  const headers = new Headers();
  if (apiFormat === "anthropic-messages") {
    headers.set("x-api-key", apiKey);
  } else {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  return headers;
}

/** `models[]` 条目对应的模型 id：`slug` 优先，回退 OpenAI 风格的 `id`。 */
function catalogModelIds(models: unknown): string[] {
  if (!Array.isArray(models)) return [];
  const ids: string[] = [];
  for (const entry of models) {
    if (entry == null || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const slug = record.slug;
    const id = record.id;
    const value = typeof slug === "string" && slug.trim() ? slug : typeof id === "string" ? id : "";
    if (value.trim()) ids.push(value.trim());
  }
  return ids;
}

async function parseModelFetchResponse(
  response: Response,
): Promise<readonly FetchedProviderModel[]> {
  let json: unknown;
  try {
    json = await response.json();
  } catch (error) {
    throw new ProviderModelFetchError(
      "parse",
      `Failed to parse model list response: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (json == null || typeof json !== "object") {
    throw new ProviderModelFetchError("parse", "Model list response is not a JSON object");
  }

  const record = json as Record<string, unknown>;
  const data = record.data;
  const models = record.models;
  const entries: FetchedProviderModel[] = [];

  if (Array.isArray(data)) {
    for (const entry of data) {
      if (entry == null || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      const id = typeof item.id === "string" ? item.id.trim() : "";
      if (!id) continue;
      entries.push({
        id,
        ...(typeof item.owned_by === "string" && item.owned_by.trim()
          ? { ownedBy: item.owned_by.trim() }
          : {}),
      });
    }
  } else {
    for (const id of catalogModelIds(models)) entries.push({ id });
  }

  // 按 ID 排序并去重；重复条目保留首次出现的 ownedBy。
  entries.sort((a, b) => a.id.localeCompare(b.id));
  const seen = new Set<string>();
  const unique: FetchedProviderModel[] = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    unique.push(entry);
  }
  return unique;
}

/** 从错误响应体里读取脱敏后的文本，避免 API Key 泄漏进错误消息。 */
async function readRedactedErrorBody(response: Response, apiKey: string): Promise<string> {
  let body = "";
  try {
    body = await response.text();
  } catch {
    // 响应体不可读时保留空串，错误分类仍有效。
  }
  const redacted = body.replaceAll(apiKey, "[REDACTED]");
  if (redacted.length <= ERROR_BODY_MAX_CHARS) return redacted;
  return `${redacted.slice(0, ERROR_BODY_MAX_CHARS)}…`;
}

/**
 * 创建模型拉取执行器。
 *
 * `fetchImpl` 由装配层注入 Host 的 HTTP transport（代理/CA 生效）；测试可注入
 * mock fetch 验证候选 URL、鉴权头、解析与错误分类。
 */
export function createProviderModelFetcher(dependencies: {
  fetch: typeof fetch;
  timeoutMs?: number;
}): ProviderModelFetcher {
  const fetchImpl = dependencies.fetch;
  const timeoutMs = dependencies.timeoutMs ?? MODEL_FETCH_TIMEOUT_MS;

  return async (input) => {
    const baseUrl = input.baseUrl.trim();
    const apiKey = input.apiKey.trim();
    if (!baseUrl) throw new ProviderModelFetchError("missing-config", "Base URL is empty");
    if (!apiKey) {
      throw new ProviderModelFetchError(
        "missing-config",
        "API Key is required to fetch provider models",
      );
    }

    const candidates = buildModelFetchUrlCandidates(baseUrl);
    if (candidates.length === 0) {
      throw new ProviderModelFetchError(
        "missing-config",
        "Cannot derive models endpoint from Base URL",
      );
    }
    const headers = buildModelFetchHeaders(apiKey, input.apiFormat);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    let lastError: string | undefined;
    try {
      for (const url of candidates) {
        let response: Response;
        try {
          response = await fetchImpl(url, { headers, signal: controller.signal });
        } catch (error) {
          if (controller.signal.aborted) {
            throw new ProviderModelFetchError(
              "timeout",
              `Fetching provider models timed out after ${timeoutMs}ms`,
            );
          }
          throw new ProviderModelFetchError(
            "network",
            `Request failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        if (response.ok) {
          const models = await parseModelFetchResponse(response);
          return { models };
        }

        const body = await readRedactedErrorBody(response, apiKey);
        if (response.status === 401 || response.status === 403) {
          throw new ProviderModelFetchError("auth", `HTTP ${response.status}: ${body}`);
        }
        if (response.status === 404 || response.status === 405) {
          lastError = `HTTP ${response.status}: ${body}`;
          continue;
        }
        throw new ProviderModelFetchError("http", `HTTP ${response.status}: ${body}`);
      }

      throw new ProviderModelFetchError(
        "not-found",
        `All candidate model endpoints failed: ${lastError ?? "no candidates"}`,
      );
    } finally {
      clearTimeout(timeout);
    }
  };
}
