import { useMemo } from "react";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import type { LedgerSnapshot } from "@zcode/shared";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "@/components/ui/chart.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";

// Agent 分布横向条形图：按调用次数排序，tooltip 附带 token 与费用。

const chartConfig = {
  calls: { label: "calls", color: "var(--color-usage-chart-2)" },
} satisfies ChartConfig;

export function LedgerAgentBarChart({
  snapshot,
  currency,
}: {
  snapshot: LedgerSnapshot;
  currency: string;
}) {
  const { intl, locale } = useZCodeIntl();

  const rows = useMemo(
    () =>
      snapshot.agents
        .slice(0, 10)
        .map((agent) => ({
          name: agent.agent,
          calls: agent.calls,
          tokens: agent.inputTokens + agent.outputTokens,
          cost: agent.cost,
        }))
        .sort((a, b) => b.calls - a.calls),
    [snapshot.agents],
  );

  const formatCost = (value: number | null) => {
    if (value === null) {
      return null;
    }
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currency === "CNY" ? "CNY" : "USD",
      maximumFractionDigits: 2,
    }).format(value);
  };

  return (
    <section className="space-y-3 rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.ledger.agentTitle" })}
      </h3>
      {rows.length === 0 ? (
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.usage.ledger.chartEmptyDescription" })}
        />
      ) : (
        <ChartContainer config={chartConfig} className="h-64 w-full">
          <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 24, left: 8 }}>
            <CartesianGrid horizontal={false} strokeDasharray="3 3" />
            <XAxis type="number" hide />
            <YAxis
              type="category"
              dataKey="name"
              width={110}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 12 }}
            />
            <ChartTooltip
              cursor={{ fill: "var(--color-border)" }}
              content={
                <ChartTooltipContent
                  hideLabel
                  formatter={(
                    _value: unknown,
                    name: unknown,
                    item: { payload?: { name?: string } },
                  ) => {
                    const agentName = item.payload?.name ?? String(name);
                    const row = rows.find((r) => r.name === agentName);
                    return (
                      <div className="w-full space-y-0.5">
                        <div className="font-medium text-foreground">{agentName}</div>
                        <div className="flex justify-between gap-4 text-foreground-subtle">
                          <span>
                            {intl.formatMessage({ id: "settings.usage.ledger.series.calls" })}
                          </span>
                          <span className="font-mono tabular-nums">
                            {formatCompactNumber(locale, row?.calls ?? 0)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-4 text-foreground-subtle">
                          <span>
                            {intl.formatMessage({ id: "settings.usage.ledger.series.tokens" })}
                          </span>
                          <span className="font-mono tabular-nums">
                            {formatCompactTokenUsage(locale, row?.tokens ?? 0)}
                          </span>
                        </div>
                        {row?.cost != null ? (
                          <div className="flex justify-between gap-4 text-foreground-subtle">
                            <span>
                              {intl.formatMessage({ id: "settings.usage.ledger.series.cost" })}
                            </span>
                            <span className="font-mono tabular-nums">{formatCost(row.cost)}</span>
                          </div>
                        ) : null}
                      </div>
                    );
                  }}
                />
              }
            />
            <Bar
              dataKey="calls"
              fill={chartConfig.calls.color}
              radius={[0, 4, 4, 0]}
              barSize={14}
            />
          </BarChart>
        </ChartContainer>
      )}
    </section>
  );
}
