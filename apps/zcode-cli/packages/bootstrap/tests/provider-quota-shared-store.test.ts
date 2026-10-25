import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
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
    /** 直接把时钟跳到未来（模拟 WSL 与 NTFS 之间的时钟漂移）。 */
    jumpBy: (ms: number) => {
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

  it("本端时钟与文件系统时钟漂移时不偷活锁：判年龄只用文件系统时钟", async () => {
    // WSL2 的内核时钟与 NTFS 时钟存在漂移。旧实现拿本端 now() 减锁的 mtime：漂移超过阈值时，
    // 一把刚被活人持有的锁会立刻被判成僵尸、两端同时进临界区。新实现「现在」取自探针文件的
    // mtime（与锁同一个文件系统时钟），本端时钟漂移多远都偷不走。
    const clock = createClock();
    clock.jumpBy(3_600_000); // 本端时钟快了一个小时——模拟漂移，锁其实刚被活人拿到。
    const filePath = join(tempRoot, "skew.json");
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
