import { describe, expect, it } from "vitest";
import { createProviderQuotaSharing } from "../src/app/provider-quota-wiring.js";
import { PROVIDER_QUOTA_SHARED_FILE_ENV } from "../src/app/provider-quota-shared-store.js";
import {
  createAccountProviderConfig,
  createApiKeyProviderConfig,
} from "./provider-config-fixtures.js";

const RELAY_URL = "https://relay.example.test/v1";
/** 占位凭据：两个不同的假账号，用来验「同一 providerId 的不同 Key 分两个桶」。 */
const TEST_CRED_A = "test-account-one";
const TEST_CRED_B = "test-account-two";

/** 用真 `ProviderConfig` 造 reader，而不是手搓字面量：读错字段名（比如把 `api.baseUrl` 写成
 * `api.baseURL`）是这段装配最可能的错法，只有真配置类型才钉得住。 */
function readerOf(configs: Record<string, ReturnType<typeof createApiKeyProviderConfig>>) {
  return (providerId: string) => configs[providerId];
}

function relayConfig(apiKey: string, baseURL = RELAY_URL) {
  return createApiKeyProviderConfig({ apiFormat: "openai-chat", apiKey, baseURL });
}

describe("配额共享的装配", () => {
  it("环境里算得出账本位置才装账本；算不出来就不共享", () => {
    const configs = { relay: relayConfig(TEST_CRED_A) };
    const unshared = createProviderQuotaSharing({
      readProviderConfig: readerOf(configs),
      env: {},
    });
    expect(unshared.sharedStore).toBeUndefined();

    const shared = createProviderQuotaSharing({
      readProviderConfig: readerOf(configs),
      env: { [PROVIDER_QUOTA_SHARED_FILE_ENV]: "/tmp/quota.json" },
    });
    expect(shared.sharedStore).toBeDefined();
  });

  it("键是账号指纹：同一个 providerId 换 Key 或换端点都是另一个桶", () => {
    const keyOf = (config: ReturnType<typeof createApiKeyProviderConfig>): string =>
      createProviderQuotaSharing({
        readProviderConfig: readerOf({ relay: config }),
        env: {},
      }).resolveSharedBucketKey("relay")!;

    const first = keyOf(relayConfig(TEST_CRED_A));
    expect(first).toMatch(/^relay--[0-9a-f]{16}$/);
    expect(first).not.toBe(keyOf(relayConfig(TEST_CRED_B)));
    expect(first).not.toBe(keyOf(relayConfig(TEST_CRED_A, "https://other.example.test/v1")));
  });

  it("键里不含明文凭据——文件是落在共享盘上的", () => {
    const sharing = createProviderQuotaSharing({
      readProviderConfig: readerOf({ relay: relayConfig(TEST_CRED_A) }),
      env: {},
    });
    expect(sharing.resolveSharedBucketKey("relay")).not.toContain(TEST_CRED_A);
  });

  it("同一个配置每次都算出同一个键（两端各自算，必须一致）", () => {
    const configs = { relay: relayConfig(TEST_CRED_A) };
    const once = createProviderQuotaSharing({ readProviderConfig: readerOf(configs), env: {} });
    const twice = createProviderQuotaSharing({ readProviderConfig: readerOf(configs), env: {} });
    expect(once.resolveSharedBucketKey("relay")).toBe(twice.resolveSharedBucketKey("relay"));
  });

  it("账号型凭据也参与共享（凭据不在配置里，按账号型自身分桶）", () => {
    const accountSharing = createProviderQuotaSharing({
      readProviderConfig: readerOf({
        zai: createAccountProviderConfig({ apiFormat: "anthropic-messages" }),
      }),
      env: {},
    });
    expect(accountSharing.resolveSharedBucketKey("zai")).toMatch(/^zai--[0-9a-f]{16}$/);
  });

  it("读不到 provider 就答 undefined——配置还没解析出来时走进程内桶", () => {
    const sharing = createProviderQuotaSharing({ readProviderConfig: () => undefined, env: {} });
    expect(sharing.resolveSharedBucketKey("ghost")).toBeUndefined();
  });
});
