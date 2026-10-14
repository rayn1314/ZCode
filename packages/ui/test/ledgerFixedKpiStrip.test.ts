// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ledgerSnapshotSchema, type LedgerSnapshot } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { LedgerFixedKpiStrip } from "@/settings/usage-stats/ledger/LedgerKpiCards.js";

// 信息栏固定口径条：今日/本月 + 活跃天数 + 峰值日（峰值日在合并层推导，UI 只消费）。

afterEach(() => {
  cleanup();
});

function makeSnapshot(overview: Partial<LedgerSnapshot["overview"]> = {}): LedgerSnapshot {
  return ledgerSnapshotSchema.parse({
    range: { key: "all", fromMs: null, toMs: null },
    generatedAt: 0,
    overview: {
      calls: 0,
      completed: 0,
      errors: 0,
      cancelled: 0,
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheReadTokens: 0,
      avgDurationMs: null,
      avgTtftMs: null,
      activeDays: 0,
      todayCalls: 0,
      todayTokens: 0,
      todayCost: null,
      monthCalls: 0,
      monthTokens: 0,
      monthCost: null,
      ...overview,
    },
    hourlyToday: [],
    daily: [],
    models: [],
    agents: [],
    sessions: [],
    recent: [],
    errors: [],
    facets: { providers: [], models: [] },
    sources: [],
    pricesLoaded: false,
    priceMeta: null,
  });
}

function renderStrip(overview: Partial<LedgerSnapshot["overview"]> = {}) {
  return render(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(LedgerFixedKpiStrip, {
        snapshot: makeSnapshot(overview),
        locale: "zh-CN",
        currency: "USD",
      }),
    ),
  );
}

function peakPartText(): string {
  const span = screen.getByText(/峰值日/, { selector: "span" });
  return span.textContent ?? "";
}

describe("LedgerFixedKpiStrip 峰值日条目", () => {
  it("有数据时展示峰值日日期、调用数、token 与费用", () => {
    renderStrip({
      peakDayDate: "2026-10-13",
      peakDayCalls: 8312,
      peakDayTokens: 450_000_000,
      peakDayCost: 18.2,
    });
    const text = peakPartText();
    expect(text).toMatch(/峰值日（10月13日）：/);
    expect(text).toContain("次");
    expect(text).toMatch(/亿/);
    expect(text).toContain("US$18.2");
  });

  it("峰值日费用未定价时省略费用段", () => {
    renderStrip({
      peakDayDate: "2026-10-13",
      peakDayCalls: 8312,
      peakDayTokens: 450_000_000,
      peakDayCost: null,
    });
    const text = peakPartText();
    expect(text).toMatch(/峰值日（10月13日）：/);
    expect(text).not.toContain("US$");
  });

  it("范围内无调用时显示占位 --", () => {
    renderStrip();
    expect(screen.getByText("峰值日：--")).toBeTruthy();
  });
});
