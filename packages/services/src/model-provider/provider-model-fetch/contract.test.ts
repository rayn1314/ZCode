import { describe, expect, it } from "vitest";
import {
  buildModelFetchHeaders,
  buildModelFetchUrlCandidates,
  createProviderModelFetcher,
  ProviderModelFetchError,
  type ProviderModelFetchRequest,
} from "./contract.js";
import { providerModelFetchModule } from "./module.js";

/** 测试用占位值；仅用于验证鉴权头与脱敏逻辑，不是真实凭据。 */
const TEST_CRED = "dummy-value";
const request: ProviderModelFetchRequest = {
  providerId: "relay",
  baseUrl: "https://relay.example/api/claudecode",
  apiKey: TEST_CRED,
};

/** 记录每次尝试的 URL 与鉴权头，并按脚本返回响应。 */
function createFakeFetch(respond: (url: string) => Response) {
  const attempts: { apiKeyHeader: string | null; authorization: string | null; url: string }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const headers = init?.headers as Headers;
    attempts.push({
      url,
      apiKeyHeader: headers.get("x-api-key"),
      authorization: headers.get("Authorization"),
    });
    return respond(url);
  }) as unknown as typeof fetch;
  return { attempts, fetchImpl };
}

describe("provider-model-fetch contract", () => {
  it("候选端点顺序固定：版本段用 {base}/models，兼容子路径剥离后再兜底", () => {
    expect(buildModelFetchUrlCandidates("https://open.bigmodel.cn/api/coding/paas/v4")).toEqual([
      "https://open.bigmodel.cn/api/coding/paas/v4/models",
      "https://open.bigmodel.cn/api/coding/paas/v4/v1/models",
    ]);
    expect(buildModelFetchUrlCandidates("https://relay.example/api/claudecode")).toEqual([
      "https://relay.example/api/claudecode/v1/models",
      "https://relay.example/v1/models",
      "https://relay.example/models",
    ]);

    // 鉴权头按协议选：Anthropic 用 x-api-key，其余用 Bearer。
    const anthropic = buildModelFetchHeaders(TEST_CRED, "anthropic-messages");
    expect(anthropic.get("x-api-key")).toBe(TEST_CRED);
    expect(anthropic.get("Authorization")).toBeNull();
    expect(buildModelFetchHeaders(TEST_CRED, undefined).get("Authorization")).toBe(
      `Bearer ${TEST_CRED}`,
    );
  });

  it("401 立即按 auth 失败且不继续候选，错误消息里看不到凭据", async () => {
    const { attempts, fetchImpl } = createFakeFetch(
      () => new Response(`invalid api key: ${TEST_CRED}`, { status: 401 }),
    );
    const error = await createProviderModelFetcher({ fetch: fetchImpl })(request).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ProviderModelFetchError);
    expect((error as ProviderModelFetchError).code).toBe("auth");
    expect((error as Error).message).not.toContain(TEST_CRED);
    expect((error as Error).message).toContain("[REDACTED]");
    // 换 URL 不会变好：auth 失败就停在第一个候选。
    expect(attempts).toHaveLength(1);
  });

  it("404 逐候选降级，全部失败归 not-found；命中候选时结果排序去重", async () => {
    const notFound = createFakeFetch(() => new Response("nope", { status: 404 }));
    const failure = await createProviderModelFetcher({ fetch: notFound.fetchImpl })(request).catch(
      (caught: unknown) => caught,
    );
    expect((failure as ProviderModelFetchError).code).toBe("not-found");
    expect(notFound.attempts.map((attempt) => attempt.url)).toEqual(
      buildModelFetchUrlCandidates(request.baseUrl),
    );

    const ok = createFakeFetch(
      () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "b-model", owned_by: "vendor-b" },
              { id: "a-model", owned_by: "vendor-a" },
              { id: "b-model" },
            ],
          }),
          { status: 200 },
        ),
    );
    const result = await createProviderModelFetcher({ fetch: ok.fetchImpl })(request);
    expect(result.models).toEqual([
      { id: "a-model", ownedBy: "vendor-a" },
      { id: "b-model", ownedBy: "vendor-b" },
    ]);
    // 第一个候选就命中：只发一次请求，且带上按协议选出的鉴权头（未声明协议 → Bearer）。
    expect(ok.attempts).toHaveLength(1);
    expect(ok.attempts[0]?.authorization).toBe(`Bearer ${TEST_CRED}`);
  });

  it("清单公开入口与契约文件一致", () => {
    expect(providerModelFetchModule.id).toBe("provider-model-fetch");
    expect(providerModelFetchModule.publicEntrypoints).toContain("contract.ts");
  });
});
