/**
 * 同机跨端的并发共享读数（provider-concurrency-shared.ts）：各进程只写自己的在飞数，对方按
 * `N − 别人` 收窄。这里钉住的是这份共享态的**安全问题**：读不到就当没共享、过期条目要收回、
 * 自己的报告不能算成别人的份额、有在飞就必须保活（否则对方会把活进程当死进程）。
 *
 * 一个进程里造两个视图、注入不同的实例 id，就是在模拟 Windows 桌面与 WSL 两个进程。
 */

import { mkdtemp, readdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createProviderConcurrencySharedView,
  getProviderConcurrencySharedView,
} from "../src/app/provider-concurrency-shared.js";

const PROVIDER = "prov";

async function makeTempRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "zcode-concurrency-shared-"));
}

async function entryFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).filter((name) => name.endsWith(".json"));
  } catch {
    return [];
  }
}

/** `report` 是异步落盘的（fire-and-forget），等到文件真的出现再断言。 */
async function settleEntries(directory: string, expected: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await entryFiles(directory)).length === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `expected ${expected} report file(s), saw ${(await entryFiles(directory)).length}`,
  );
}

/** 保活重写也是异步的：等到 mtime 比 `afterMs` 新为止。 */
async function waitForFreshMtime(path: string, afterMs: number): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if ((await stat(path)).mtimeMs > afterMs) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("keepalive never refreshed the report file");
}

/** 保活定时器可注入：测试要手动让它到点，不能真等 1 秒。 */
function fakeScheduler() {
  let current = 0;
  const timers: Array<{ at: number; fire: () => void; cancelled: boolean }> = [];
  return {
    schedule: (callback: () => void, delayMs: number) => {
      const entry = { at: current + delayMs, fire: callback, cancelled: false };
      timers.push(entry);
      return () => {
        entry.cancelled = true;
      };
    },
    advance(ms: number) {
      current += ms;
      for (const entry of [...timers]) {
        if (entry.cancelled || entry.at > current) continue;
        timers.splice(timers.indexOf(entry), 1);
        entry.fire();
      }
    },
    pending: () => timers.filter((entry) => !entry.cancelled).length,
  };
}

describe("跨进程并发共享读数", () => {
  let directory = "";

  beforeEach(async () => {
    directory = await makeTempRoot();
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  function makeView(instanceId: string, scheduler = fakeScheduler()) {
    const view = createProviderConcurrencySharedView({
      directory,
      instanceId,
      // 节流在测试里没有意义（会挡住「改了文件再重读」的断言）：全部走磁盘。
      refreshMinIntervalMs: 0,
      schedule: scheduler.schedule,
      registerExitHook: false,
    });
    return { view, scheduler };
  }

  it("另一端的报告能被读到；自己的报告不算「别人」", async () => {
    const a = makeView("A");
    const b = makeView("B");
    a.view.report(PROVIDER, 3);
    await settleEntries(directory, 1);

    // 没重读之前只有缓存的 0——读盘是显式动作，不是每个请求都做。
    expect(b.view.othersInFlight(PROVIDER)).toBe(0);
    expect(await b.view.refresh(PROVIDER)).toBe(3);
    expect(b.view.othersInFlight(PROVIDER)).toBe(3);

    // A 自己看自己：报告里有 3 个在飞，但那是自己的，不该扣自己的额度。
    expect(await a.view.refresh(PROVIDER)).toBe(0);
  });

  it("两端各报各的，读到的别人是两边之和（不含自己）", async () => {
    const a = makeView("A");
    const b = makeView("B");
    const c = makeView("C");
    a.view.report(PROVIDER, 2);
    b.view.report(PROVIDER, 1);
    await settleEntries(directory, 2);

    expect(await c.view.refresh(PROVIDER)).toBe(3);
    expect(await a.view.refresh(PROVIDER)).toBe(1);
    expect(await b.view.refresh(PROVIDER)).toBe(2);
  });

  it("报告 0 = 删掉自己的报告：对方重读后份额全放掉", async () => {
    const a = makeView("A");
    const b = makeView("B");
    a.view.report(PROVIDER, 2);
    await settleEntries(directory, 1);
    expect(await b.view.refresh(PROVIDER)).toBe(2);

    a.view.report(PROVIDER, 0);
    await settleEntries(directory, 0);
    expect(await b.view.refresh(PROVIDER)).toBe(0);
  });

  it("过期条目被收回并清掉：崩掉的进程不该一直占着份额", async () => {
    const a = makeView("A");
    const b = makeView("B");
    a.view.report(PROVIDER, 4);
    await settleEntries(directory, 1);

    // 把 A 的报告推老到存活期之外（模拟崩溃 / 休眠）。
    const [name] = await entryFiles(directory);
    const longAgo = new Date(Date.now() - 60_000);
    await utimes(join(directory, name), longAgo, longAgo);

    expect(await b.view.refresh(PROVIDER)).toBe(0);
    expect(await entryFiles(directory)).toEqual([]);
  });

  it("保活：有在飞的进程报告被推老后会重写，不会被对方当成死进程", async () => {
    const a = makeView("A");
    const b = makeView("B");
    a.view.report(PROVIDER, 2);
    await settleEntries(directory, 1);

    const [name] = await entryFiles(directory);
    const longAgoMs = Date.now() - 60_000;
    await utimes(join(directory, name), new Date(longAgoMs), new Date(longAgoMs));

    // 保活到点：重写报告 = 刷 mtime（rename 保留 mtime，所以是重写而不是 utimes）。
    a.scheduler.advance(1_000);
    await waitForFreshMtime(join(directory, name), longAgoMs);
    // mtime 新鲜 ⇒ 对方仍然把我们的 2 个在飞算进去。
    expect(await b.view.refresh(PROVIDER)).toBe(2);
  });

  it("读不动的条目一律跳过：垃圾 JSON、半截内容、别家 provider、非法 count", async () => {
    const a = makeView("A");
    a.view.report(PROVIDER, 1);
    await settleEntries(directory, 1);
    const [name] = await entryFiles(directory);
    const prefix = name.split(".")[0]!;

    await writeFile(join(directory, "garbage.json"), "{ not json", "utf-8");
    await writeFile(join(directory, `${prefix}.ghost.json`), "{ half", "utf-8");
    await writeFile(
      join(directory, `${prefix}.other-provider.json`),
      JSON.stringify({ version: 1, providerId: "someone-else", count: 9 }),
      "utf-8",
    );
    await writeFile(
      join(directory, `${prefix}.bad-count.json`),
      JSON.stringify({ version: 1, providerId: PROVIDER, count: -2 }),
      "utf-8",
    );

    // 只有 A 那一条合法：别家 provider 的 9 与非法 count 都不算进来。
    expect(await a.view.refresh(PROVIDER)).toBe(0);
    const b = makeView("B");
    expect(await b.view.refresh(PROVIDER)).toBe(1);
  });

  it("目录还不存在（首次运行）或读不到：按 0 算、不抛错", async () => {
    const missing = join(directory, "not-created-yet");
    const view = createProviderConcurrencySharedView({
      directory: missing,
      instanceId: "A",
      refreshMinIntervalMs: 0,
      registerExitHook: false,
    });
    expect(await view.refresh(PROVIDER)).toBe(0);
    expect(view.othersInFlight(PROVIDER)).toBe(0);
    // 报告也不会抛：写不进去就等于没开共享。
    view.report(PROVIDER, 2);
    await settleEntries(missing, 1);
  });

  it("dispose 删掉自己的报告：对方的份额立刻回来", async () => {
    const a = makeView("A");
    const b = makeView("B");
    a.view.report(PROVIDER, 3);
    await settleEntries(directory, 1);
    expect(await b.view.refresh(PROVIDER)).toBe(3);

    await a.view.dispose();
    expect(await entryFiles(directory)).toEqual([]);
    expect(await b.view.refresh(PROVIDER)).toBe(0);
  });

  it("文件名不含 providerId、内容含：文件名要跨环境安全，原值留给排障", async () => {
    const a = makeView("A");
    a.view.report("供应商/带 空格", 1);
    await settleEntries(directory, 1);
    const [name] = await entryFiles(directory);
    expect(name).not.toContain("供应商");
    expect(name).not.toContain("/");
    const raw = JSON.parse(await readFile(join(directory, name), "utf-8")) as {
      providerId: string;
      count: number;
    };
    expect(raw).toEqual({ version: 1, providerId: "供应商/带 空格", count: 1 });
  });

  it("进程级单例：同一个进程里多个 app 共用一份读数（各造一份会把同一批请求数重复加）", () => {
    const first = getProviderConcurrencySharedView({ directory });
    expect(first).toBeDefined();
    expect(getProviderConcurrencySharedView({ directory })).toBe(first);
    // 「算不出目录 = 不共享」只在还没共享过时成立；一旦共享就是**进程级**状态，后一个 app 的
    // 环境算不出目录也不能把它悄悄关掉（那会让两个 app 的读数口径分叉）。
    expect(getProviderConcurrencySharedView({})).toBe(first);
  });
});
