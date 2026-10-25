import { describe, expect, it } from "vitest";
import { createProviderQuotaSharing } from "../src/app/provider-quota-wiring.js";
import { PROVIDER_QUOTA_SHARED_FILE_ENV } from "../src/app/provider-quota-shared-store.js";

describe("配额共享的装配", () => {
  it("环境里算得出账本位置才装账本；算不出来就不共享", () => {
    // 顺序有讲究：并发视图是**进程级单例**，「算不出位置就不共享」只在本文件第一次调用时成立。
    const unshared = createProviderQuotaSharing({ env: {} });
    expect(unshared.sharedStore).toBeUndefined();
    expect(unshared.concurrencyShared).toBeUndefined();

    const shared = createProviderQuotaSharing({
      env: { [PROVIDER_QUOTA_SHARED_FILE_ENV]: "/tmp/quota.json" },
    });
    expect(shared.sharedStore).toBeDefined();
    // 并发读数与账本同一个锚点：账本在 `/tmp/quota.json`，读数就落在它旁边的目录里。
    expect(shared.concurrencyShared).toBeDefined();
  });

  it("不认凭据与端点：装配只决定账本位置，桶键由限速器取 providerId（同名两端即共享）", () => {
    // 这条是装配层与限速器之间的分工契约：装配层不读 provider 配置，也就没有「按 Key 细分桶」
    // 的入口——同一 providerId 的不同 Key 合用一个桶是既定语义（多账号 = 多建 provider 配置）。
    const sharing = createProviderQuotaSharing({
      env: { [PROVIDER_QUOTA_SHARED_FILE_ENV]: "/tmp/quota.json" },
    });
    expect(sharing).toEqual({
      sharedStore: expect.anything(),
      concurrencyShared: expect.anything(),
    });
  });
});
