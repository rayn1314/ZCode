import { describe, expect, it } from "vitest";

import { calcLedgerCost, expandLedgerPriceAliases, type LedgerPriceTable } from "./ledgerPrices.js";
import { MS_PER_DAY, resolveLedgerRange } from "./ledgerRange.js";
import {
  rollupSubtrees,
  selectLedgerSessionRows,
  type LedgerSessionFact,
} from "./ledgerSessionTree.js";

// 契约测试只 import 本模块的文件与 module 清单；断言的是 spec/usage-ledger.md 里那几条口径不变式，
// 不锁死实现细节（SQL、探测、缓存时长都不在这里）。

function price(input: number, output: number, cacheRead: number) {
  return { input, output, cacheRead };
}

function fact(sessionId: string, overrides: Partial<LedgerSessionFact> = {}): LedgerSessionFact {
  return {
    sessionId,
    title: null,
    directory: null,
    taskType: "interactive",
    parentSessionId: null,
    calls: 1,
    inputTokens: 0,
    outputTokens: 0,
    cost: null,
    lastActiveMs: null,
    ...overrides,
  };
}

describe("usage-ledger 计价口径", () => {
  it("把 cacheRead 从 input 里扣掉再计价，不双计费，未定价返回 null", () => {
    const table: LedgerPriceTable = {
      prices: new Map([["deepseek-v4-1-flash", price(1, 10, 0.1)]]),
      meta: null,
    };
    // 1M 输入里全部命中缓存：只按 cacheRead 价计一次。
    expect(calcLedgerCost(table, "DeepSeek-V4-1-Flash", 1_000_000, 0, 1_000_000)).toBeCloseTo(0.1);
    // 无命中：整个 input 按输入价计。
    expect(calcLedgerCost(table, "deepseek-v4-1-flash", 1_000_000, 0, 0)).toBeCloseTo(1);
    // 半命中：命中部分走缓存价，未命中部分走输入价。
    expect(calcLedgerCost(table, "deepseek-v4-1-flash", 1_000_000, 1_000, 500_000)).toBeCloseTo(
      0.5 + 0.01 + 0.05,
    );
    // 未定价模型不静默按 0 算。
    expect(calcLedgerCost(table, "unknown-model", 1, 1, 0)).toBeNull();
    expect(calcLedgerCost(null, "deepseek-v4-1-flash", 1, 1, 0)).toBeNull();
  });

  it("别名只在展开时生效：显式定价优先、链式可跟、成环中断且不抛错", () => {
    const prices = new Map([
      ["target", price(1, 1, 1)],
      ["explicit", price(9, 9, 9)],
    ]);
    const aliases = new Map([
      ["a", "target"],
      ["chain", "a"],
      ["explicit", "target"],
      ["loop-a", "loop-b"],
      ["loop-b", "loop-a"],
    ]);
    const { prices: expanded, aliasTargets } = expandLedgerPriceAliases(prices, aliases);

    expect(expanded.get("a")).toEqual(prices.get("target"));
    expect(aliasTargets.get("a")).toBe("target");
    expect(expanded.get("chain")).toEqual(prices.get("target"));
    expect(aliasTargets.get("chain")).toBe("target");
    // 别名键自己已有价：别名不覆盖它。
    expect(expanded.get("explicit")).toEqual(price(9, 9, 9));
    expect(aliasTargets.has("explicit")).toBe(false);
    // 成环：中断后保持未定价，不抛错、不产生半截映射。
    expect(expanded.has("loop-a")).toBe(false);
    expect(aliasTargets.has("loop-a")).toBe(false);
  });
});

describe("usage-ledger 会话层级", () => {
  it("每行 = 自身 + 全部后代，fork 断边不累加回来源会话", () => {
    const rows = rollupSubtrees([
      fact("p", { calls: 1, inputTokens: 100, outputTokens: 10, cost: 1, lastActiveMs: 100 }),
      fact("c1", {
        parentSessionId: "p",
        calls: 2,
        inputTokens: 200,
        outputTokens: 20,
        cost: 2,
        lastActiveMs: 300,
      }),
      fact("g", { parentSessionId: "c1", calls: 4, inputTokens: 400, outputTokens: 40 }),
      fact("fork", {
        taskType: "fork",
        parentSessionId: "p",
        calls: 8,
        inputTokens: 800,
        outputTokens: 80,
        cost: 8,
        lastActiveMs: 500,
      }),
    ]);
    const byId = new Map(rows.map((row) => [row.sessionId, row]));

    expect(byId.get("p")).toMatchObject({
      calls: 7,
      inputTokens: 700,
      outputTokens: 70,
      cost: 3,
      lastActiveMs: 300,
      childCount: 1,
    });
    expect(byId.get("c1")).toMatchObject({ calls: 6, inputTokens: 600, childCount: 1 });
    expect(byId.get("g")).toMatchObject({ calls: 4, childCount: 0, parentSessionId: "c1" });
    expect(byId.get("fork")).toMatchObject({
      parentSessionId: null,
      calls: 8,
      childCount: 0,
    });
  });

  it("截断按顶层会话数计，且被保留的子行其父必然也被保留", () => {
    const rows = selectLedgerSessionRows(
      rollupSubtrees([
        fact("big", { inputTokens: 10_000 }),
        fact("big-child", { parentSessionId: "big", inputTokens: 5_000 }),
        fact("small", { inputTokens: 1_000 }),
      ]),
      1,
    );
    expect(rows.map((row) => row.sessionId).sort()).toEqual(["big", "big-child"]);
    // 顶层配额只数顶层：子树随父一起进来，不额外占用配额。
    expect(rows.some((row) => row.sessionId === "small")).toBe(false);
  });
});

describe("usage-ledger 时间范围", () => {
  const now = Date.UTC(2026, 9, 23, 12, 0, 0);

  it("7d/30d 含今日，all 上界取 now（不能留 null），custom 起止可交换", () => {
    const today0 = Date.UTC(2026, 9, 23);
    expect(resolveLedgerRange({ range: "7d" }, now, 0)).toEqual({
      key: "7d",
      fromMs: today0 - 6 * MS_PER_DAY,
      toMs: now,
    });
    expect(resolveLedgerRange({ range: "all" }, now, 0)).toEqual({
      key: "all",
      fromMs: null,
      toMs: now,
    });
    const swapped = resolveLedgerRange(
      { range: "custom", customStart: "2026-10-05", customEnd: "2026-10-01" },
      now,
      0,
    );
    expect(swapped).toEqual({
      key: "custom",
      fromMs: Date.UTC(2026, 9, 1),
      toMs: Date.UTC(2026, 9, 5) + MS_PER_DAY - 1,
    });
    expect(() =>
      resolveLedgerRange(
        { range: "custom", customStart: "2026-13-01", customEnd: "2026-10-01" },
        now,
        0,
      ),
    ).toThrow("LEDGER_INVALID_CUSTOM_RANGE");
  });
});
