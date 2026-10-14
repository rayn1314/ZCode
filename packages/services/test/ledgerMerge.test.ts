import assert from "node:assert/strict";
import { test } from "vitest";
import type { LedgerDailyRow, LedgerRangeInfo } from "@zcode/shared";
import {
  emptyLedgerPayload,
  mergeLedgerPayloads,
  type LabelledLedgerPayload,
} from "../src/usage-ledger/ledgerMerge.js";

// 契约见 spec/usage-ledger.md「口径资产 7」：峰值日是所选范围内 token（input + output）最高的
// 那一天，只在合并层基于合并后的 daily 推导——单源各自的峰值在合并后无意义（aggregateFromDb/WSL 不产出）。

const RANGE: LedgerRangeInfo = { key: "all", fromMs: null, toMs: null };

function daily(date: string, calls: number, over: Partial<LedgerDailyRow> = {}): LedgerDailyRow {
  return {
    date,
    calls,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    avgDurationMs: null,
    cost: null,
    ...over,
  };
}

function payload(
  sourceKey: string,
  dailyRows: LedgerDailyRow[],
  opts: { stripPeakFields?: boolean } = {},
): LabelledLedgerPayload {
  const base = emptyLedgerPayload();
  const overview = { ...base.overview };
  if (opts.stripPeakFields) {
    // 模拟 WSL dump：源面不产出峰值字段，合并层仍能推导
    delete overview.peakDayDate;
    delete overview.peakDayCalls;
    delete overview.peakDayTokens;
    delete overview.peakDayCost;
  }
  return { ...base, sourceLabel: sourceKey, sourceKey, overview, daily: dailyRows };
}

test("峰值日按 token（input + output）取最大值，而非调用数或任一单源的峰值", () => {
  // 合并后：10-11 调用数最高（300），10-12 token 最高（2300）——峰值必须按 token 取
  const a = payload("windows", [
    daily("2026-10-11", 200, { inputTokens: 500, outputTokens: 100, cost: 1.5 }),
    daily("2026-10-12", 100, { inputTokens: 1500, outputTokens: 800, cost: 3 }),
  ]);
  const b = payload("windows@dev", [
    daily("2026-10-11", 100, { inputTokens: 300, outputTokens: 100, cost: 1.2 }),
  ]);
  const merged = mergeLedgerPayloads([a, b], [], RANGE);
  const { overview } = merged;
  assert.equal(overview.peakDayDate, "2026-10-12");
  assert.equal(overview.peakDayCalls, 100);
  // token 只计 input + output（缓存读是输入子集，不重复叠加）
  assert.equal(overview.peakDayTokens, 1500 + 800);
  assert.equal(overview.peakDayCost, 3);
  assert.equal(overview.activeDays, 2);
});

test("范围内无调用时峰值日为 0 / null", () => {
  const merged = mergeLedgerPayloads([], [], RANGE);
  const { overview } = merged;
  assert.equal(overview.peakDayCalls, 0);
  assert.equal(overview.peakDayDate, null);
  assert.equal(overview.peakDayTokens, 0);
  assert.equal(overview.peakDayCost, null);
});

test("未产出峰值字段的源（WSL 侧）照常参与合并推导", () => {
  const a = payload("windows", [daily("2026-10-13", 40, { inputTokens: 400, outputTokens: 100 })], {
    stripPeakFields: true,
  });
  const b = payload("wsl:Ubuntu", [
    daily("2026-10-13", 60, { inputTokens: 600, outputTokens: 200, cost: 2 }),
  ]);
  const merged = mergeLedgerPayloads([a, b], [], RANGE);
  const { overview } = merged;
  assert.equal(overview.peakDayDate, "2026-10-13");
  assert.equal(overview.peakDayCalls, 100);
  assert.equal(overview.peakDayTokens, 400 + 100 + 600 + 200);
  assert.equal(overview.peakDayCost, 2);
});

test("峰值日费用未定价时为 null", () => {
  const a = payload("windows", [
    daily("2026-10-14", 10, { inputTokens: 100, outputTokens: 50, cost: null }),
  ]);
  const merged = mergeLedgerPayloads([a], [], RANGE);
  assert.equal(merged.overview.peakDayCost, null);
});
