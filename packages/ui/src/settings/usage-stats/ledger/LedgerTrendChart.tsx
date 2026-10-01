import { useCallback, useMemo } from "react";
import { Bar, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import type { LedgerSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  ChartLegend,
  ChartLegendContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
  formatDay,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import type { LedgerDailyMetric } from "./ledgerPrefs.js";

// 每日趋势三种维度（与账本工具一致）：
//   tokens：输入/缓存读（左轴）+ 输出/思考（右轴），非堆叠各自从底边起；
//   calls：调用柱 + 错误线；cost：费用柱。

const TOKEN_SERIES = [
  { key: "inputTokens", color: "var(--color-usage-chart-1)", axis: "left" },
  { key: "cacheReadTokens", color: "var(--color-usage-chart-2)", axis: "left" },
  { key: "outputTokens", color: "var(--color-usage-chart-3)", axis: "right" },
  { key: "reasoningTokens", color: "var(--color-usage-chart-4)", axis: "right" },
] as const;

const chartConfig = {
  inputTokens: { label: "inputTokens", color: "var(--color-usage-chart-1)" },
  cacheReadTokens: { label: "cacheReadTokens", color: "var(--color-usage-chart-2)" },
  outputTokens: { label: "outputTokens", color: "var(--color-usage-chart-3)" },
  reasoningTokens: { label: "reasoningTokens", color: "var(--color-usage-chart-4)" },
  calls: { label: "calls", color: "var(--color-usage-chart-1)" },
  errors: { label: "errors", color: "var(--color-usage-chart-5)" },
  cost: { label: "cost", color: "var(--color-usage-chart-6)" },
} satisfies ChartConfig;

export function LedgerTrendChart({
  snapshot,
  metric,
  onMetricChange,
}: {
  snapshot: LedgerSnapshot;
  metric: LedgerDailyMetric;
  onMetricChange: (metric: LedgerDailyMetric) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const daily = snapshot.daily;

  const chartData = useMemo(
    () =>
      daily.map((row) => ({
        label: formatDay(locale, row.date),
        inputTokens: row.inputTokens,
        cacheReadTokens: row.cacheReadTokens,
        outputTokens: row.outputTokens,
        reasoningTokens: row.reasoningTokens,
        calls: row.calls,
        errors: row.errors,
        cost: row.cost ?? 0,
      })),
    [daily, locale],
  );

  const seriesLabel = useCallback(
    (key: string) => {
      const id = `settings.usage.ledger.series.${key}`;
      const text = intl.formatMessage({ id });
      return text === id ? key : text;
    },
    [intl],
  );

  const formatValue = useCallback(
    (key: string, value: number) => {
      if (key === "cost") {
        return formatCompactNumber(locale, value);
      }
      if (key === "calls" || key === "errors") {
        return formatCompactNumber(locale, value);
      }
      return formatCompactTokenUsage(locale, value);
    },
    [locale],
  );

  const hasData = chartData.some((row) =>
    metric === "cost"
      ? row.cost > 0
      : metric === "calls"
        ? row.calls > 0
        : TOKEN_SERIES.some((s) => row[s.key] > 0),
  );

  const maxLeft = useMemo(() => {
    if (metric === "calls") {
      return Math.max(1, ...chartData.map((r) => r.calls));
    }
    if (metric === "cost") {
      return Math.max(1, ...chartData.map((r) => r.cost));
    }
    return Math.max(1, ...chartData.flatMap((r) => [r.inputTokens, r.cacheReadTokens]));
  }, [chartData, metric]);

  const maxRight = useMemo(() => {
    if (metric !== "tokens") {
      return 0;
    }
    return Math.max(1, ...chartData.flatMap((r) => [r.outputTokens, r.reasoningTokens]));
  }, [chartData, metric]);

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.ledger.trendTitle" })}
        </h3>
        <Tabs value={metric} onValueChange={(v) => onMetricChange(v as LedgerDailyMetric)}>
          <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
            {(["tokens", "calls", "cost"] as const).map((option) => (
              <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
                {intl.formatMessage({ id: `settings.usage.ledger.metric.${option}` })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {!hasData ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.usage.ledger.chartEmptyDescription" })}
        />
      ) : (
        <ChartContainer config={chartConfig} className="h-64 w-full">
          <ComposedChart
            data={chartData}
            margin={{ top: 8, right: metric === "tokens" ? 8 : 8, left: 0 }}
          >
            <CartesianGrid vertical={false} strokeDasharray="3 3" />
            <XAxis
              dataKey="label"
              tickLine={false}
              axisLine={false}
              tickMargin={8}
              minTickGap={24}
            />
            <YAxis yAxisId="left" hide domain={[0, maxLeft]} allowDataOverflow={false} />
            {metric === "tokens" ? (
              <YAxis yAxisId="right" orientation="right" hide domain={[0, maxRight]} />
            ) : null}
            <ChartTooltip
              cursor={{ strokeDasharray: "3 3" }}
              content={
                <ChartTooltipContent
                  formatter={(value: unknown, name: unknown, item: { color?: string }) => {
                    const key = String(name);
                    const numeric = typeof value === "number" ? value : Number(value);
                    if (!Number.isFinite(numeric) || numeric <= 0) {
                      return null;
                    }
                    return (
                      <div className="flex w-full items-center justify-between gap-3">
                        <span className="flex items-center gap-1.5">
                          <span
                            className="size-2 shrink-0 rounded-full"
                            style={{ backgroundColor: item.color }}
                          />
                          <span className="text-foreground-subtle">{seriesLabel(key)}</span>
                        </span>
                        <span className="font-mono font-medium tabular-nums">
                          {formatValue(key, numeric)}
                        </span>
                      </div>
                    );
                  }}
                />
              }
            />
            <ChartLegend
              content={<ChartLegendContent nameKey="name" />}
              formatter={(value) => seriesLabel(String(value))}
            />
            {metric === "tokens" ? (
              TOKEN_SERIES.map((series) => (
                <Bar
                  key={series.key}
                  yAxisId={series.axis}
                  dataKey={series.key}
                  fill={series.color}
                  fillOpacity={0.85}
                  radius={[2, 2, 0, 0]}
                />
              ))
            ) : metric === "calls" ? (
              <>
                <Bar
                  yAxisId="left"
                  dataKey="calls"
                  fill={chartConfig.calls.color}
                  fillOpacity={0.85}
                  radius={[2, 2, 0, 0]}
                />
                <Line
                  yAxisId="left"
                  dataKey="errors"
                  stroke={chartConfig.errors.color}
                  strokeWidth={2}
                  dot={false}
                />
              </>
            ) : (
              <Bar
                yAxisId="left"
                dataKey="cost"
                fill={chartConfig.cost.color}
                fillOpacity={0.85}
                radius={[2, 2, 0, 0]}
              />
            )}
          </ComposedChart>
        </ChartContainer>
      )}
    </section>
  );
}
