import { useMemo } from "react";
import { Cell, Pie, PieChart } from "recharts";
import type { LedgerSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
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
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { getAppUsageModelChartColor } from "@/settings/usage-stats/appUsageChartPalette.js";
import type { LedgerDonutMetric } from "./ledgerPrefs.js";

// 模型占比环形图：top8 + 其他；费用模式剔除未定价模型（与账本工具一致）。
const TOP_N = 8;

const chartConfig = {
  model: { label: "model", color: "var(--color-usage-chart-1)" },
} satisfies ChartConfig;

export function LedgerModelDonutChart({
  snapshot,
  metric,
  onMetricChange,
}: {
  snapshot: LedgerSnapshot;
  metric: LedgerDonutMetric;
  onMetricChange: (metric: LedgerDonutMetric) => void;
}) {
  const { intl, locale } = useZCodeIntl();

  const rows = useMemo(() => {
    const usable = snapshot.models.filter((m) => {
      if (metric === "cost") {
        // 未定价模型在费用视图里没有可比数值，剔除而不是按 0 处理
        return m.cost !== null && m.cost > 0;
      }
      return true;
    });
    const valueOf = (m: LedgerSnapshot["models"][number]): number =>
      metric === "calls"
        ? m.calls
        : metric === "cost"
          ? (m.cost ?? 0)
          : m.inputTokens + m.outputTokens;
    const sorted = [...usable]
      .map((m) => ({
        name: resolveModelLabel(intl, m.model),
        value: valueOf(m),
        color: getAppUsageModelChartColor(0),
      }))
      .sort((a, b) => b.value - a.value);
    const top = sorted.slice(0, TOP_N).map((row, index) => ({
      ...row,
      color: getAppUsageModelChartColor(index),
    }));
    const rest = sorted.slice(TOP_N).reduce((sum, row) => sum + row.value, 0);
    if (rest > 0) {
      top.push({
        name: intl.formatMessage({ id: "settings.usage.ledger.donutOthers" }),
        value: rest,
        color: "var(--color-usage-chart-8)",
      });
    }
    return top;
  }, [snapshot.models, metric, intl]);

  const total = rows.reduce((sum, row) => sum + row.value, 0);
  const formatValue = (value: number) =>
    metric === "cost"
      ? formatCompactNumber(locale, value)
      : metric === "tokens"
        ? formatCompactTokenUsage(locale, value)
        : formatCompactNumber(locale, value);

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-ui-base font-medium text-foreground">
          {intl.formatMessage({ id: "settings.usage.ledger.donutTitle" })}
        </h3>
        <Tabs value={metric} onValueChange={(v) => onMetricChange(v as LedgerDonutMetric)}>
          <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
            {(["calls", "tokens", "cost"] as const).map((option) => (
              <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
                {intl.formatMessage({ id: `settings.usage.ledger.metric.${option}` })}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {total <= 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.usage.ledger.chartEmptyDescription" })}
        />
      ) : (
        <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
          <ChartContainer config={chartConfig} className="aspect-square h-48 w-48 shrink-0">
            <PieChart>
              <ChartTooltip
                content={
                  <ChartTooltipContent
                    hideLabel
                    formatter={(value: unknown, name: unknown, item: { color?: string }) => {
                      const numeric = typeof value === "number" ? value : Number(value);
                      const share = total > 0 && Number.isFinite(numeric) ? numeric / total : 0;
                      return (
                        <div className="flex w-full items-center justify-between gap-3">
                          <span className="flex min-w-0 items-center gap-1.5">
                            <span
                              className="size-2 shrink-0 rounded-full"
                              style={{ backgroundColor: item.color }}
                            />
                            <span className="truncate text-foreground-subtle">{String(name)}</span>
                          </span>
                          <span className="font-mono font-medium tabular-nums">
                            {formatValue(numeric)} · {Math.round(share * 100)}%
                          </span>
                        </div>
                      );
                    }}
                  />
                }
              />
              <Pie
                data={rows}
                dataKey="value"
                nameKey="name"
                innerRadius="60%"
                outerRadius="90%"
                paddingAngle={1}
                strokeWidth={0}
              >
                {rows.map((row) => (
                  <Cell key={row.name} fill={row.color} />
                ))}
              </Pie>
            </PieChart>
          </ChartContainer>
          <ul className="grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-1 text-ui-sm sm:grid-cols-2">
            {rows.map((row) => (
              <li key={row.name} className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2.5 shrink-0 rounded-sm"
                  style={{ backgroundColor: row.color }}
                />
                <span className="min-w-0 flex-1 truncate text-foreground-subtle" title={row.name}>
                  {row.name}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {Math.round(total > 0 ? (row.value / total) * 100 : 0)}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
