import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { LedgerSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { formatLedgerCost } from "./ledgerFormat.js";
import { LedgerTablePagination } from "./LedgerTablePagination.js";

// 模型 × 供应商明细表：还原原 zcode-usage 工具页脚 tabs 区的第一张表
// （模型 | 供应商 | 调用 | 输入 | 缓存读 | 输出 | 平均耗时 | 费用 | 费用占比）。
// 费用占比的分母是已计价费用合计，未定价调用不计入分母也不伪装成 0 元。

type ModelSortKey =
  | "model"
  | "calls"
  | "inputTokens"
  | "cacheReadTokens"
  | "outputTokens"
  | "avgDurationMs"
  | "cost"
  | "costShare";

const TABLE_SCROLL_CLASS = "mt-3 max-h-[32rem] overflow-auto";
const TH_STICKY_CLASS = "sticky top-0 z-1 bg-surface";

export function LedgerModelsTable({
  snapshot,
  locale,
  currency,
  pageSize,
  onPageSizeChange,
}: {
  snapshot: LedgerSnapshot;
  locale: string;
  currency: string;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const [sortKey, setSortKey] = useState<ModelSortKey>("calls");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);

  const hasCost = useMemo(() => snapshot.models.some((m) => m.cost !== null), [snapshot.models]);
  // 费用占比的分母：已计价费用合计（未定价调用不计入，也不伪装成 0 元）
  const pricedTotal = useMemo(
    () => snapshot.models.reduce((sum, m) => sum + (m.cost ?? 0), 0),
    [snapshot.models],
  );

  const sorted = useMemo(() => {
    const rows = snapshot.models.map((m) => ({
      ...m,
      costShare: m.cost !== null && pricedTotal > 0 ? m.cost / pricedTotal : null,
    }));
    const value = (row: (typeof rows)[number]): number | string => {
      switch (sortKey) {
        case "model":
          return (row.model ?? "").toLowerCase();
        case "calls":
          return row.calls;
        case "inputTokens":
          return row.inputTokens;
        case "cacheReadTokens":
          return row.cacheReadTokens;
        case "outputTokens":
          return row.outputTokens;
        case "avgDurationMs":
          return row.avgDurationMs ?? -1;
        case "cost":
          return row.cost ?? -1;
        case "costShare":
          return row.costShare ?? -1;
      }
    };
    rows.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const result =
        typeof va === "string" || typeof vb === "string"
          ? String(va).localeCompare(String(vb))
          : va - vb;
      return sortDesc ? -result : result;
    });
    return rows;
  }, [snapshot.models, sortKey, sortDesc]);

  useEffect(() => {
    setPage(1);
  }, [snapshot.generatedAt, sortKey, sortDesc, pageSize]);

  const pageCount = Math.max(1, Math.ceil(sorted.length / pageSize));
  const current = Math.min(page, pageCount);
  const rows = sorted.slice((current - 1) * pageSize, current * pageSize);

  const toggleSort = (key: ModelSortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
      return;
    }
    setSortKey(key);
    setSortDesc(true);
  };

  const header = (key: ModelSortKey, labelId: string) => (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
    >
      <button
        type="button"
        className="inline-flex items-center gap-1 hover:text-foreground"
        onClick={() => toggleSort(key)}
      >
        {intl.formatMessage({ id: labelId })}
        {sortKey === key ? (
          sortDesc ? (
            <ArrowDown className="size-3" />
          ) : (
            <ArrowUp className="size-3" />
          )
        ) : null}
      </button>
    </th>
  );

  const staticHeader = (labelId: string, align: "left" | "right") => (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 font-medium text-foreground-subtle ${TH_STICKY_CLASS} ${
        align === "right" ? "text-right" : "text-left"
      }`}
    >
      {intl.formatMessage({ id: labelId })}
    </th>
  );

  return (
    <section className="rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.ledger.modelsTitle" })}
      </h3>
      {sorted.length === 0 ? (
        <div className="mt-3">
          <UsageEmptyState
            title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
            description={intl.formatMessage({ id: "settings.usage.ledger.tableEmptyDescription" })}
          />
        </div>
      ) : (
        <div className={TABLE_SCROLL_CLASS}>
          <table className="w-full min-w-180 border-collapse text-ui-base">
            <thead>
              <tr className="border-b border-border">
                {header("model", "settings.usage.ledger.models.model")}
                {staticHeader("settings.usage.ledger.models.provider", "left")}
                {header("calls", "settings.usage.ledger.models.calls")}
                {header("inputTokens", "settings.usage.ledger.models.input")}
                {header("cacheReadTokens", "settings.usage.ledger.models.cacheRead")}
                {header("outputTokens", "settings.usage.ledger.models.output")}
                {header("avgDurationMs", "settings.usage.ledger.models.avgDuration")}
                {hasCost ? header("cost", "settings.usage.ledger.models.cost") : null}
                {hasCost ? header("costShare", "settings.usage.ledger.models.costShare") : null}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={`${row.provider}:${row.model ?? ""}`}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="max-w-64 truncate px-3 py-2" title={row.model ?? undefined}>
                    {row.model ?? intl.formatMessage({ id: "settings.usage.unknownModel" })}
                  </td>
                  <td
                    className="max-w-48 truncate px-3 py-2 text-foreground-subtle"
                    title={row.provider}
                  >
                    {row.provider}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactNumber(locale, row.calls)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactTokenUsage(locale, row.inputTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground-subtle">
                    {formatCompactTokenUsage(locale, row.cacheReadTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactTokenUsage(locale, row.outputTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground-subtle">
                    {row.avgDurationMs !== null
                      ? `${(row.avgDurationMs / 1000).toFixed(1)}s`
                      : "--"}
                  </td>
                  {hasCost ? (
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                      {row.cost !== null ? formatLedgerCost(locale, row.cost, currency) : "--"}
                    </td>
                  ) : null}
                  {hasCost ? (
                    <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground-subtle">
                      {row.costShare !== null ? `${(row.costShare * 100).toFixed(1)}%` : "--"}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sorted.length > 0 ? (
        <LedgerTablePagination
          total={sorted.length}
          page={current}
          pageSize={pageSize}
          onPage={setPage}
          onPageSize={onPageSizeChange}
        />
      ) : null}
    </section>
  );
}
