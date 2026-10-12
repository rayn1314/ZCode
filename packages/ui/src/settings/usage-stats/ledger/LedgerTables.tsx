import { useEffect, useState } from "react";
import type { LedgerSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  formatCompactNumber,
  formatCompactTokenUsage,
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import { formatLedgerCost, formatLedgerRelativeTime } from "./ledgerFormat.js";
import { LedgerTablePagination } from "./LedgerTablePagination.js";

// 两个明细视图：错误分布、最近调用表；会话表（可排序 + 父子层级展开）见 LedgerSessionsTable.tsx。
// 表格遵守 DESIGN.md：text-ui-base、右对齐数值列、窄屏面板内横向滚动（不撑破页面）。
// 分页统一（每页条数可调、偏好记忆），滚动容器固定限高 + 内部滚动、表头吸顶——
// 行数再多也不把整页撑长，翻页与页内滚动各管一层。

const TABLE_SCROLL_CLASS = "mt-3 max-h-[32rem] overflow-auto";
const TH_STICKY_CLASS = "sticky top-0 z-1 bg-surface";

export function LedgerErrorSummary({ snapshot }: { snapshot: LedgerSnapshot }) {
  const { intl, locale } = useZCodeIntl();
  if (snapshot.errors.length === 0) {
    return null;
  }
  return (
    <section className="rounded-xl bg-surface px-4 py-3">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.ledger.errorsTitle" })}
      </h3>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {snapshot.errors.slice(0, 12).map((error) => (
          <span
            key={error.type}
            className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-background px-2.5 py-1 text-ui-sm text-foreground-subtle"
            title={error.type}
          >
            <span className="size-1.5 shrink-0 rounded-full bg-destructive" />
            <span className="min-w-0 truncate">{error.type}</span>
            <span className="shrink-0 tabular-nums">
              {formatCompactNumber(locale, error.count)}
            </span>
          </span>
        ))}
      </div>
    </section>
  );
}

const STATUS_DOT_CLASS: Record<string, string> = {
  completed: "bg-emerald-500",
  error: "bg-destructive",
  cancelled: "bg-zinc-400",
  running: "bg-amber-500",
};

export function LedgerRecentTable({
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
  const [page, setPage] = useState(1);

  const total = snapshot.recent.length;
  // 快照或页大小变化回到第一页，避免停留在越界页
  useEffect(() => {
    setPage(1);
  }, [snapshot.generatedAt, pageSize]);

  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const rows = snapshot.recent.slice((current - 1) * pageSize, current * pageSize);
  if (total === 0) {
    return null;
  }

  return (
    <section className="rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.ledger.recentTitle" })}
      </h3>
      <div className={TABLE_SCROLL_CLASS}>
        <table className="w-full min-w-220 border-collapse text-ui-base">
          <thead>
            <tr className="border-b border-border">
              <th
                className={`whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.time" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.source" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.model" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.agent" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.status" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.input" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.output" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.duration" })}
              </th>
              <th
                className={`whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
              >
                {intl.formatMessage({ id: "settings.usage.ledger.recent.cost" })}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((call, index) => {
              const status = call.status ?? "";
              return (
                <tr
                  key={`${call.timeMs ?? 0}:${index}`}
                  className="border-b border-border/60 last:border-0"
                >
                  <td className="whitespace-nowrap px-3 py-2 text-foreground-subtle">
                    {call.timeMs !== null ? formatLedgerRelativeTime(locale, call.timeMs) : "--"}
                  </td>
                  <td
                    className="max-w-40 truncate px-3 py-2 text-foreground-subtle"
                    title={call.src}
                  >
                    {call.src ?? "--"}
                  </td>
                  <td className="max-w-56 truncate px-3 py-2" title={call.model ?? undefined}>
                    {resolveModelLabel(intl, call.model)}
                  </td>
                  <td
                    className="max-w-40 truncate px-3 py-2 text-foreground-subtle"
                    title={call.agent ?? undefined}
                  >
                    {call.agent ?? "--"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        className={`size-1.5 shrink-0 rounded-full ${STATUS_DOT_CLASS[status] ?? "bg-zinc-400"}`}
                      />
                      <span className="text-foreground-subtle">
                        {intl.formatMessage({
                          id: `settings.usage.ledger.status.${status || "unknown"}`,
                        })}
                      </span>
                      {call.errorType ? (
                        <span
                          className="max-w-40 truncate rounded bg-background px-1.5 py-0.5 text-ui-sm text-destructive"
                          title={call.errorType}
                        >
                          {call.errorType}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactTokenUsage(locale, call.inputTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactTokenUsage(locale, call.outputTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums text-foreground-subtle">
                    {call.durationMs !== null ? `${(call.durationMs / 1000).toFixed(1)}s` : "--"}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {call.cost !== null ? formatLedgerCost(locale, call.cost, currency) : "--"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <LedgerTablePagination
        total={total}
        page={current}
        pageSize={pageSize}
        onPage={setPage}
        onPageSize={onPageSizeChange}
      />
    </section>
  );
}
