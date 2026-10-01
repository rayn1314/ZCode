import { useMemo } from "react";
import type { LedgerSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCompactNumber,
  formatSummaryCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { formatLedgerCost, formatLedgerHourLabel } from "./ledgerFormat.js";

// KPI 卡行 + 今日/本月固定口径条 + 今日小时密度条。
// 卡片样式对齐 App Usage 的 surface 摘要条：bg-surface 圆角卡、主值 text-ui-lg、副行 subtle。

function percentText(value: number): string {
  if (!Number.isFinite(value) || value <= 0) {
    return "--";
  }
  return `${Math.round(value * 100)}%`;
}

export function LedgerKpiCards({
  overview,
  currency,
  locale,
  formatDuration,
}: {
  overview: LedgerSnapshot["overview"];
  currency: string;
  locale: string;
  formatDuration: (ms: number | null) => string;
}) {
  const { intl } = useZCodeIntl();
  const cacheReadShare =
    overview.inputTokens > 0 ? overview.cacheReadTokens / overview.inputTokens : 0;
  const hasCost = overview.cost !== null && overview.cost !== undefined;
  const unpricedCalls = overview.unpricedCalls ?? 0;

  const cards = [
    {
      label: intl.formatMessage({ id: "settings.usage.ledger.kpi.calls" }),
      value: formatCompactNumber(locale, overview.calls),
      sub: `${intl.formatMessage({ id: "settings.usage.ledger.status.completed" })} ${formatCompactNumber(locale, overview.completed)} · ${intl.formatMessage({ id: "settings.usage.ledger.status.error" })} ${formatCompactNumber(locale, overview.errors)} · ${intl.formatMessage({ id: "settings.usage.ledger.status.cancelled" })} ${formatCompactNumber(locale, overview.cancelled)}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.ledger.kpi.inputTokens" }),
      value: formatSummaryCompactTokenUsage(locale, overview.inputTokens),
      sub: `${intl.formatMessage({ id: "settings.usage.ledger.kpi.cacheReadShare" })} ${percentText(cacheReadShare)}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.ledger.kpi.outputTokens" }),
      value: formatSummaryCompactTokenUsage(locale, overview.outputTokens),
      sub: `${intl.formatMessage({ id: "settings.usage.ledger.kpi.reasoning" })} ${formatSummaryCompactTokenUsage(locale, overview.reasoningTokens)}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.ledger.kpi.cacheRead" }),
      value: formatSummaryCompactTokenUsage(locale, overview.cacheReadTokens),
      sub: `${intl.formatMessage({ id: "settings.usage.ledger.kpi.ofInput" })} ${percentText(overview.inputTokens > 0 ? overview.cacheReadTokens / overview.inputTokens : 0)}`,
    },
    {
      label: intl.formatMessage({ id: "settings.usage.ledger.kpi.avgDuration" }),
      value: formatDuration(overview.avgDurationMs),
      sub: "",
    },
    {
      label: intl.formatMessage({ id: "settings.usage.ledger.kpi.avgTtft" }),
      value: formatDuration(overview.avgTtftMs),
      sub: "",
    },
    hasCost
      ? {
          label: intl.formatMessage({ id: "settings.usage.ledger.kpi.cost" }),
          value: formatLedgerCost(locale, overview.cost ?? 0, currency),
          sub:
            unpricedCalls > 0
              ? intl.formatMessage(
                  { id: "settings.usage.ledger.kpi.unpriced" },
                  { count: unpricedCalls },
                )
              : "",
        }
      : {
          label: intl.formatMessage({ id: "settings.usage.ledger.kpi.cost" }),
          value: "--",
          sub: intl.formatMessage({ id: "settings.usage.ledger.costDisabled" }),
        },
  ];

  return (
    <section className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-7">
      {cards.map((card) => (
        <div key={card.label} className="min-w-0 rounded-xl bg-surface px-3 py-3">
          <div className="truncate text-ui-sm text-foreground-subtle">{card.label}</div>
          <div className="mt-1 truncate text-ui-lg font-medium text-foreground" title={card.value}>
            {card.value}
          </div>
          <div className="mt-1 truncate text-ui-sm text-foreground-subtle" title={card.sub}>
            {card.sub || " "}
          </div>
        </div>
      ))}
    </section>
  );
}

/** 今日/本月固定口径 KPI（不随所选范围变化），一行细条。 */
export function LedgerFixedKpiStrip({
  snapshot,
  locale,
  currency,
}: {
  snapshot: LedgerSnapshot;
  locale: string;
  currency: string;
}) {
  const { intl } = useZCodeIntl();
  const { overview } = snapshot;
  const hasCost = overview.todayCost !== null && overview.todayCost !== undefined;
  const parts = [
    `${intl.formatMessage({ id: "settings.usage.ledger.kpi.today" })}：${formatCompactNumber(locale, overview.todayCalls)} ${intl.formatMessage({ id: "settings.usage.ledger.unit.calls" })} · ${formatSummaryCompactTokenUsage(locale, overview.todayTokens)}${hasCost ? ` · ${formatLedgerCost(locale, overview.todayCost ?? 0, currency)}` : ""}`,
    `${intl.formatMessage({ id: "settings.usage.ledger.kpi.month" })}：${formatCompactNumber(locale, overview.monthCalls)} ${intl.formatMessage({ id: "settings.usage.ledger.unit.calls" })} · ${formatSummaryCompactTokenUsage(locale, overview.monthTokens)}${overview.monthCost !== null && overview.monthCost !== undefined ? ` · ${formatLedgerCost(locale, overview.monthCost, currency)}` : ""}`,
    `${intl.formatMessage({ id: "settings.usage.ledger.kpi.activeDays" })}：${formatCompactNumber(locale, overview.activeDays)}`,
  ];
  return (
    <section className="flex flex-wrap gap-x-6 gap-y-1 rounded-xl bg-surface px-4 py-2.5 text-ui-sm text-foreground-subtle">
      {parts.map((part) => (
        <span key={part}>{part}</span>
      ))}
    </section>
  );
}

/** 今日各小时密度条：纯 CSS，24 段，当前小时高亮，每 3 小时刻度。 */
export function LedgerHourlyStrip({ snapshot }: { snapshot: LedgerSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  const buckets = snapshot.hourlyToday;
  const maxCalls = useMemo(() => Math.max(1, ...buckets.map((b) => b.calls)), [buckets]);
  const currentHour = new Date().getHours();
  const hasAny = buckets.some((b) => b.calls > 0);

  return (
    <section className="rounded-xl bg-surface p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.ledger.hourlyTitle" })}
        </h3>
        <span className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.usage.ledger.hourlyPeak" },
            {
              hour: formatLedgerHourLabel(
                buckets.reduce(
                  (best, b) => (b.calls > (buckets[best]?.calls ?? -1) ? b.hour : best),
                  0,
                ),
              ),
            },
          )}
        </span>
      </div>
      <div className="mt-3 flex h-16 items-end gap-[2px]">
        {buckets.map((bucket) => (
          <div
            key={bucket.hour}
            className="group relative flex h-full min-w-0 flex-1 items-end"
            title={`${formatLedgerHourLabel(bucket.hour)} · ${formatCompactNumber(locale, bucket.calls)}`}
          >
            <div
              className={`w-full rounded-t-sm transition-colors ${
                bucket.hour === currentHour
                  ? "bg-primary"
                  : "bg-primary/30 group-hover:bg-primary/60"
              }`}
              style={{
                height:
                  bucket.calls > 0 ? `${Math.max(8, (bucket.calls / maxCalls) * 100)}%` : "2px",
                minHeight: bucket.calls > 0 ? undefined : "2px",
              }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex text-ui-sm text-foreground-subtle">
        {[0, 3, 6, 9, 12, 15, 18, 21].map((hour) => (
          <span
            key={hour}
            className="flex-1 first:text-left last:text-right"
            style={{
              textAlign: hour === 0 ? "left" : hour === 21 ? "right" : "center",
              marginLeft: hour === 0 ? 0 : undefined,
              marginRight: hour === 21 ? 0 : undefined,
            }}
          >
            {formatLedgerHourLabel(hour)}
          </span>
        ))}
      </div>
      {!hasAny ? (
        <p className="mt-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "settings.usage.ledger.hourlyEmpty" })}
        </p>
      ) : null}
    </section>
  );
}
