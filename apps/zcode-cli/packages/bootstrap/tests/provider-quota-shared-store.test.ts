import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  computeSharedQuotaKey,
  createFileProviderQuotaStore,
  PROVIDER_QUOTA_SHARED_FILE_ENV,
  resolveProviderQuotaSharedFilePath,
} from "../src/app/provider-quota-shared-store.js";

const KEY = "provider-a--0123456789abcdef";

/**
 * 受控时钟：**每次读都前进 1ms**。这一点是必需的——抢锁的重试循环靠 `now()` 推进来撞到总时限，
 * 否则测试要真等 2 秒。起点取真实时间，好让「锁文件的 mtime 有没有过期」这类判断仍然成立。
 */
function createClock() {
  let current = Date.now();
  return {
    now: () => (current += 1),
    advanceBy: (ms: number) => {
      current += ms;
    },
  };
}

describe("共享账本的位置", () => {
  it("Windows 用 %ProgramData%", () => {
    expect(resolveProviderQuotaSharedFilePath({ ProgramData: "D:\\ProgramData" }, "win32")).toBe(
      join("D:\\ProgramData", "zcode", "provider-quota.json"),
    );
  });

  it("读不到锚点就不共享——不回落到硬编码的 C:\\ProgramData（否则注入的空 env 会写到真机）", () => {
    expect(resolveProviderQuotaSharedFilePath({}, "win32")).toBeUndefined();
  });

  it("WSL 落到 /mnt/c/ProgramData，与桌面端同一个文件", () => {
    expect(resolveProviderQuotaSharedFilePath({ WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toBe(
      "/mnt/c/ProgramData/zcode/provider-quota.json",
    );
  });

  it("纯 Linux / macOS 不猜位置——多用户机器上猜错会让两个用户互相限流", () => {
    expect(resolveProviderQuotaSharedFilePath({ HOME: "/home/someone" }, "linux")).toBeUndefined();
    expect(resolveProviderQuotaSharedFilePath({}, "darwin")).toBeUndefined();
  });

  it("环境变量可显式指定位置，也可显式关掉", () => {
    expect(
      resolveProviderQuotaSharedFilePath(
        { [PROVIDER_QUOTA_SHARED_FILE_ENV]: "/tmp/x/quota.json" },
        "linux",
      ),
    ).toBe("/tmp/x/quota.json");
    for (const off of ["off", "0", "false", "none"]) {
      expect(
        resolveProviderQuotaSharedFilePath({ [PROVIDER_QUOTA_SHARED_FILE_ENV]: off }, "win32"),
      ).toBeUndefined();
    }
  });
});

describe("账号指纹", () => {
  it("同一个 providerId 配不同 Key 是两个账号，分两个桶", () => {
    const first = computeSharedQuotaKey({ providerId: "relay", apiKey: "key-one" });
    const second = computeSharedQuotaKey({ providerId: "relay", apiKey: "key-two" });
    expect(first).not.toBe(second);
  });

  it("同一个 Key 换了端点也算两个账号", () => {
    const first = computeSharedQuotaKey({ providerId: "relay", apiKey: "k", baseUrl: "https://a" });
    const second = computeSharedQuotaKey({
      providerId: "relay",
      apiKey: "k",
      baseUrl: "https://b",
    });
    expect(first).not.toBe(second);
  });

  it("键里带 providerId 明文（排障要看），但不回显凭据", () => {
    const key = computeSharedQuotaKey({ providerId: "relay", apiKey: "super-secret-value" });
    expect(key.startsWith("relay--")).toBe(true);
    expect(key).not.toContain("super-secret-value");
  });

  it("没凭据的 provider 也稳定成键", () => {
    expect(computeSharedQuotaKey({ providerId: "local" })).toBe(
      computeSharedQuotaKey({ providerId: "local" }),
    );
  });
});

describe("文件共享账本", () => {
  let tempRoot = "";

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "zcode-quota-shared-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { force: true, recursive: true });
  });

  function createStore(options: {
    clock: ReturnType<typeof createClock>;
    filePath?: string;
    logger?: { warn?: (message: string, fields: unknown) => void };
  }) {
    return createFileProviderQuotaStore({
      filePath: options.filePath ?? join(tempRoot, "nested", "provider-quota.json"),
      now: options.clock.now,
      sleep: () => Promise.resolve(),
      ...(options.logger === undefined ? {} : { logger: options.logger as never }),
    });
  }

  it("前 N 次即刻放行，之后报出还要等多久", async () => {
    const clock = createClock();
    const store = createStore({ clock });
    for (let i = 0; i < 3; i += 1) {
      await expect(
        store.tryConsume({ key: KEY, requestsPerMinute: 3, atMs: clock.now() }),
      ).resolves.toEqual({ kind: "granted" });
    }
    const exhausted = await store.tryConsume({ key: KEY, requestsPerMinute: 3, atMs: clock.now() });
    expect(exhausted.kind).toBe("exhausted");
    if (exhausted.kind !== "exhausted") throw new Error("unreachable");
    expect(exhausted.retryInMs).toBeGreaterThan(0);
    expect(exhausted.retryInMs).toBeLessThanOrEqual(20_000);
  });

  it("按时间补齐令牌后又能放行", async () => {
    const clock = createClock();
    const store = createStore({ clock });
    await store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() });
    expect(
      (await store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() })).kind,
    ).toBe("exhausted");
    clock.advanceBy(60_000);
    expect(
      (await store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() })).kind,
    ).toBe("granted");
  });

  it("两个实例指向同一个文件 = 两个进程共用一份额度", async () => {
    const clock = createClock();
    const filePath = join(tempRoot, "shared.json");
    const first = createStore({ clock, filePath });
    const second = createStore({ clock, filePath });
    const keys = [KEY];
    let granted = 0;
    for (let i = 0; i < 6; i += 1) {
      const store = i % 2 === 0 ? first : second;
      const outcome = await store.tryConsume({
        key: keys[0]!,
        requestsPerMinute: 2,
        atMs: clock.now(),
      });
      if (outcome.kind === "granted") granted += 1;
    }
    expect(granted).toBe(2);
  });

  it("不同账号各算各的：一个耗光不影响另一个", async () => {
    const clock = createClock();
    const store = createStore({ clock });
    await store.tryConsume({ key: "a--1", requestsPerMinute: 1, atMs: clock.now() });
    expect(
      (await store.tryConsume({ key: "a--1", requestsPerMinute: 1, atMs: clock.now() })).kind,
    ).toBe("exhausted");
    expect(
      (await store.tryConsume({ key: "b--2", requestsPerMinute: 1, atMs: clock.now() })).kind,
    ).toBe("granted");
  });

  it("文件内容损坏时按空账本继续，并把原因记下来（下一次写就修好）", async () => {
    const clock = createClock();
    const filePath = join(tempRoot, "broken.json");
    await writeFile(filePath, "{ this is not json", "utf-8");
    const warn = vi.fn();
    const store = createStore({ clock, filePath, logger: { warn } });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() }),
    ).resolves.toEqual({ kind: "granted" });
    expect(warn).toHaveBeenCalled();
    expect(JSON.parse(await readFile(filePath, "utf-8"))).toMatchObject({ version: 1 });
  });

  it("目录不存在也能自建", async () => {
    const clock = createClock();
    const filePath = join(tempRoot, "deep", "deeper", "quota.json");
    const store = createStore({ clock, filePath });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() }),
    ).resolves.toEqual({ kind: "granted" });
  });

  it("崩溃留下的僵尸锁会被接管（判据只有 mtime 年龄）", async () => {
    const clock = createClock();
    const filePath = join(tempRoot, "stale.json");
    // 僵尸锁：内容无所谓，关键是把 mtime 推到很久以前。跨环境不能信 pid——Windows 的进程号在
    // WSL 里毫无意义，按 pid 判活会把别人的**活锁**偷走。
    await writeFile(`${filePath}.lock`, "{}", "utf-8");
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(`${filePath}.lock`, longAgo, longAgo);
    const store = createStore({ clock, filePath });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() }),
    ).resolves.toEqual({ kind: "granted" });
  });

  it("锁被活人持着时超时报错（由调用方降级，不是无限等）", async () => {
    const clock = createClock();
    const filePath = join(tempRoot, "held.json");
    await writeFile(`${filePath}.lock`, "{}", "utf-8");
    const store = createStore({ clock, filePath });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: 1, atMs: clock.now() }),
    ).rejects.toThrow(/lock timeout/);
  });

  it("放锁之后别人能进（锁不是一次性的）", async () => {
    const clock = createClock();
    const filePath = join(tempRoot, "reuse.json");
    const store = createStore({ clock, filePath });
    await store.tryConsume({ key: KEY, requestsPerMinute: 5, atMs: clock.now() });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: 5, atMs: clock.now() }),
    ).resolves.toEqual({ kind: "granted" });
  });

  it("配额非法（0 / 负数）等价于不限制——不能把请求永久挂起", async () => {
    const clock = createClock();
    const store = createStore({ clock });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: 0, atMs: clock.now() }),
    ).resolves.toEqual({ kind: "granted" });
    await expect(
      store.tryConsume({ key: KEY, requestsPerMinute: -5, atMs: clock.now() }),
    ).resolves.toEqual({ kind: "granted" });
  });
});
