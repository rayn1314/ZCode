// Provider Model Fetch 的核心契约：
//   * 端点候选构造：普通根 /v1/models；/vN 版本段结尾用 /models；命中 Anthropic
//     兼容子路径时剥离后再拼 /v1/models、/models 兜底；结果去重保序。
//   * 鉴权头按 apiFormat 选择（anthropic-messages → x-api-key，OpenAI → Bearer）。
//   * 响应兼容 OpenAI/Anthropic 的 data[] 与智谱 models[].slug，按 ID 排序去重。
//   * 失败按分类抛出 ProviderModelFetchError（missing-config/auth/not-found/timeout/parse/http/network）。
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ProviderModelFetchError,
  buildModelFetchHeaders,
  buildModelFetchUrlCandidates,
  createProviderModelFetcher,
  endsWithVersionSegment,
  stripCompatSuffix,
} from "../src/model-provider/providerModelFetch.js";

/** 测试用占位值；仅用于验证鉴权头与脱敏逻辑，不是真实凭据。 */
const TEST_CRED = "dummy-value";

test("endsWithVersionSegment 识别 /v1、/v4 版本段", () => {
  assert.equal(endsWithVersionSegment("https://x.com/v1"), true);
  assert.equal(endsWithVersionSegment("https://open.bigmodel.cn/api/coding/paas/v4"), true);
  assert.equal(endsWithVersionSegment("https://x.com/v10"), true);
  assert.equal(endsWithVersionSegment("https://x.com/api"), false);
  assert.equal(endsWithVersionSegment("https://x.com/vX"), false);
  assert.equal(endsWithVersionSegment("https://x.com/models"), false);
  assert.equal(endsWithVersionSegment("https://api.siliconflow.cn"), false);
});

test("stripCompatSuffix 最长前缀优先", () => {
  // /api/anthropic 比 /anthropic 长，剥离整个 /api/anthropic。
  assert.equal(stripCompatSuffix("https://api.z.ai/api/anthropic"), "https://api.z.ai");
  assert.equal(stripCompatSuffix("https://api.deepseek.com/anthropic"), "https://api.deepseek.com");
  assert.equal(
    stripCompatSuffix("https://open.bigmodel.cn/apps/anthropic"),
    "https://open.bigmodel.cn",
  );
  assert.equal(stripCompatSuffix("https://api.siliconflow.cn"), undefined);
});

test("buildModelFetchUrlCandidates 普通根与尾斜杠", () => {
  assert.deepEqual(buildModelFetchUrlCandidates("https://api.siliconflow.cn"), [
    "https://api.siliconflow.cn/v1/models",
  ]);
  assert.deepEqual(buildModelFetchUrlCandidates("https://api.example.com/"), [
    "https://api.example.com/v1/models",
  ]);
});

test("buildModelFetchUrlCandidates /v1 版本段用 {base}/models", () => {
  assert.deepEqual(buildModelFetchUrlCandidates("https://api.example.com/v1"), [
    "https://api.example.com/v1/models",
  ]);
  assert.deepEqual(buildModelFetchUrlCandidates("https://open.bigmodel.cn/api/coding/paas/v4"), [
    "https://open.bigmodel.cn/api/coding/paas/v4/models",
    "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
  ]);
});

test("buildModelFetchUrlCandidates 剥离 Anthropic 兼容子路径并去重", () => {
  assert.deepEqual(buildModelFetchUrlCandidates("https://api.deepseek.com/anthropic"), [
    "https://api.deepseek.com/anthropic/v1/models",
    "https://api.deepseek.com/v1/models",
    "https://api.deepseek.com/models",
  ]);
  // 最长后缀优先：剥离整个 /api/anthropic，而不是只剥 /anthropic。
  assert.deepEqual(buildModelFetchUrlCandidates("https://api.z.ai/api/anthropic"), [
    "https://api.z.ai/api/anthropic/v1/models",
    "https://api.z.ai/v1/models",
    "https://api.z.ai/models",
  ]);
});

test("buildModelFetchUrlCandidates 空 Base URL 返回空列表", () => {
  assert.deepEqual(buildModelFetchUrlCandidates("   "), []);
});

test("buildModelFetchHeaders 按 apiFormat 选择鉴权头", () => {
  assert.equal(buildModelFetchHeaders(TEST_CRED, "anthropic-messages").get("x-api-key"), TEST_CRED);
  assert.equal(
    buildModelFetchHeaders(TEST_CRED, "openai-chat-completions").get("Authorization"),
    `Bearer ${TEST_CRED}`,
  );
  assert.equal(
    buildModelFetchHeaders(TEST_CRED, "openai-responses").get("Authorization"),
    `Bearer ${TEST_CRED}`,
  );
  assert.equal(
    buildModelFetchHeaders(TEST_CRED, undefined).get("Authorization"),
    `Bearer ${TEST_CRED}`,
  );
});

test("createProviderModelFetcher 解析 OpenAI data[] 并排序去重", async () => {
  const fetch = async () =>
    new Response(
      JSON.stringify({
        object: "list",
        data: [
          { id: "b-model", owned_by: "vendor-b" },
          { id: "a-model", owned_by: "vendor-a" },
          { id: "a-model", owned_by: "vendor-a" },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const fetcher = createProviderModelFetcher({ fetch: fetch as typeof fetch });
  const result = await fetcher({
    providerId: "p",
    baseUrl: "https://api.example.com/v1",
    apiKey: TEST_CRED,
    apiFormat: "openai-chat-completions",
  });
  assert.deepEqual(result.models, [
    { id: "a-model", ownedBy: "vendor-a" },
    { id: "b-model", ownedBy: "vendor-b" },
  ]);
});

test("createProviderModelFetcher 解析智谱 models[].slug", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ models: [{ slug: "glm-4.7" }, { slug: "glm-4.5" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetcher = createProviderModelFetcher({ fetch: fetch as typeof fetch });
  const result = await fetcher({
    providerId: "p",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    apiKey: TEST_CRED,
    apiFormat: "anthropic-messages",
  });
  assert.deepEqual(result.models, [{ id: "glm-4.5" }, { id: "glm-4.7" }]);
});

test("createProviderModelFetcher 解析 Anthropic data[]（无 owned_by）", async () => {
  const fetch = async () =>
    new Response(JSON.stringify({ data: [{ id: "claude-3-5-sonnet" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  const fetcher = createProviderModelFetcher({ fetch: fetch as typeof fetch });
  const result = await fetcher({
    providerId: "p",
    baseUrl: "https://api.anthropic.com",
    apiKey: TEST_CRED,
    apiFormat: "anthropic-messages",
  });
  assert.deepEqual(result.models, [{ id: "claude-3-5-sonnet" }]);
});

test("createProviderModelFetcher 401 归类为 auth 且不泄漏密钥", async () => {
  const fetch = async () => new Response(`invalid key: ${TEST_CRED}`, { status: 401 });
  const fetcher = createProviderModelFetcher({ fetch: fetch as typeof fetch });
  await assert.rejects(
    fetcher({
      providerId: "p",
      baseUrl: "https://api.example.com",
      apiKey: TEST_CRED,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderModelFetchError);
      assert.equal(error.code, "auth");
      assert.equal(error.message.includes(TEST_CRED), false);
      return true;
    },
  );
});

test("createProviderModelFetcher 全部候选 404 归类为 not-found", async () => {
  const fetch = async () => new Response("nope", { status: 404 });
  const fetcher = createProviderModelFetcher({ fetch: fetch as typeof fetch });
  await assert.rejects(
    fetcher({
      providerId: "p",
      baseUrl: "https://api.example.com/anthropic",
      apiKey: TEST_CRED,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderModelFetchError);
      assert.equal(error.code, "not-found");
      return true;
    },
  );
});

test("createProviderModelFetcher 响应解析失败归类为 parse", async () => {
  const fetch = async () => new Response("<html>not json</html>", { status: 200 });
  const fetcher = createProviderModelFetcher({ fetch: fetch as typeof fetch });
  await assert.rejects(
    fetcher({ providerId: "p", baseUrl: "https://api.example.com", apiKey: TEST_CRED }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderModelFetchError);
      assert.equal(error.code, "parse");
      return true;
    },
  );
});

test("createProviderModelFetcher 超时归类为 timeout", async () => {
  const abortableFetch = ((_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        reject(error);
      });
    })) as unknown as typeof fetch;
  const fetcher = createProviderModelFetcher({ fetch: abortableFetch, timeoutMs: 20 });
  await assert.rejects(
    fetcher({ providerId: "p", baseUrl: "https://api.example.com", apiKey: TEST_CRED }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderModelFetchError);
      assert.equal(error.code, "timeout");
      return true;
    },
  );
});

test("createProviderModelFetcher 缺 Base URL 或 API Key 归类为 missing-config", async () => {
  const fetcher = createProviderModelFetcher({
    fetch: (async () => new Response()) as typeof fetch,
  });
  await assert.rejects(
    fetcher({ providerId: "p", baseUrl: "   ", apiKey: TEST_CRED }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderModelFetchError);
      assert.equal(error.code, "missing-config");
      return true;
    },
  );
  await assert.rejects(
    fetcher({ providerId: "p", baseUrl: "https://api.example.com", apiKey: "  " }),
    (error: unknown) => {
      assert.ok(error instanceof ProviderModelFetchError);
      assert.equal(error.code, "missing-config");
      return true;
    },
  );
});
