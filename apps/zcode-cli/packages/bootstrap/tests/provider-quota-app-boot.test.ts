import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import { describe, expect, it } from "vitest";
import { getProviderRateLimiter } from "../src/app/provider-rate-limiter.js";
import { PROVIDER_QUOTA_SHARED_FILE_ENV } from "../src/app/provider-quota-shared-store.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

/**
 * 装配的端到端取证：`create-app` 是不是**真的**把共享账本交给了进程级限速器。
 *
 * 为什么只能在 app 启动之后、从进程单例上取证：账本位置在单例**首次构造**时定住（它读环境变量），
 * 而唯一构造它的地方就是 create-app。所以这一段只能用「先起 app、再用同一个单例发一次配额请求、
 * 看共享文件有没有出现」来钉。单例在这个文件里首次构造，故本文件不能出现第二个 app 启动。
 *
 * 键由探针给（探针只关心「扣减落没落到共享文件」）；账号指纹那部分由
 * provider-quota-wiring.test.ts 覆盖。
 */

const PROBE_KEY = "probe-account--0000000000000000";
const PROBE_RPM = 3;

interface StoredQuotaFile {
  buckets: Record<string, { requestsPerMinute: number; tokens: number; updatedAtMs: number }>;
}

async function readQuotaFile(filePath: string): Promise<StoredQuotaFile> {
  return JSON.parse(await readFile(filePath, "utf-8")) as StoredQuotaFile;
}

describe("create-app 装配跨进程共享账本", () => {
  it("一次限速请求的扣减落在共享文件里（账本由 create-app 装进进程单例）", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-quota-app-"));
    const quotaFile = join(tempRoot, "shared", "provider-quota.json");
    const sessionStore = createSqliteSessionStore({ dbPath: ":memory:" });
    try {
      const app = await createRegistryBackedTestApp({
        // 位置写进 env 才会被 create-app 采纳；这里用显式路径而不是 %ProgramData%，
        // 好让用例在三个平台上同形。
        env: { [PROVIDER_QUOTA_SHARED_FILE_ENV]: quotaFile },
        runtimeConfig: {
          mcp: { enabled: false },
          modelSelection: {
            providerId: "zai",
            modelId: "glm-4.6",
            options: { reasoningLevel: "medium" },
          },
          workingDirectory: tempRoot,
        },
        sessionStore,
        skipUserConfig: true,
      });
      try {
        // 启动本身不该碰磁盘：账本是懒的，位置算出来就算完。
        await expect(readQuotaFile(quotaFile)).rejects.toThrow();

        const port = getProviderRateLimiter({
          resolveRequestsPerMinute: () => PROBE_RPM,
          resolveSharedBucketKey: () => PROBE_KEY,
        });
        await port.awaitRateLimit({ model: { providerId: "probe", modelId: "model-a" } });
        let stored = await readQuotaFile(quotaFile);
        expect(Object.keys(stored.buckets)).toEqual([PROBE_KEY]);
        expect(stored.buckets[PROBE_KEY]).toMatchObject({
          requestsPerMinute: PROBE_RPM,
          tokens: PROBE_RPM - 1,
        });

        // 第二次仍在同一个桶里递减：证明读的不是「每次新建」的账本。
        // 用 toBeCloseTo 是因为两次扣减之间桶会按真实时钟补一点点令牌（这里没有可注入的时钟）。
        await port.awaitRateLimit({ model: { providerId: "probe", modelId: "model-a" } });
        stored = await readQuotaFile(quotaFile);
        expect(Object.keys(stored.buckets)).toEqual([PROBE_KEY]);
        expect(stored.buckets[PROBE_KEY]!.tokens).toBeCloseTo(PROBE_RPM - 2, 1);
      } finally {
        await app.close?.();
      }
    } finally {
      sessionStore.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  }, 30_000);
});
