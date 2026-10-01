import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { LedgerSnapshot } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
  resolveModelLabel,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  formatLedgerCost,
  formatLedgerRelativeTime,
  shortenLedgerDirectory,
} from "./ledgerFormat.js";

// 三个明细视图：会话表（可排序）、错误分布、最近调用表。
// 表格遵守 DESIGN.md：text-ui-base、右对齐数值列、窄屏面板内横向滚动（不撑破页面）。

type SortKey = "title" | "calls" | "tokens" | "cost" | "lastActiveMs";

export function LedgerSessionsTable({
  snapshot,
  locale,
  currency,
  nowTick,
}: {
  snapshot: LedgerSnapshot;
  locale: string;
  currency: string;
  nowTick: number;
}) {
  const { intl } = useZCodeIntl();
  const [sortKey, setSortKey] = useState<SortKey>("tokens");
  const [sortDesc, setSortDesc] = useState(true);

  const rows = useMemo(() => {
    const sessions = [...snapshot.sessions];
    const value = (s: LedgerSnapshot["sessions"][number]): number | string => {
      switch (sortKey) {
        case "title":
          return (s.title ?? "").toLowerCase();
        case "calls":
          return s.calls;
        case "tokens":
          return s.inputTokens + s.outputTokens;
        case "cost":
          return s.cost ?? -1;
        case "lastActiveMs":
          return s.lastActiveMs ?? 0;
      }
    };
    sessions.sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      const result =
        typeof va === "string" || typeof vb === "string"
          ? String(va).localeCompare(String(vb))
          : va - vb;
      return sortDesc ? -result : result;
    });
    return sessions.slice(0, 50);
    // nowTick 变化触发相对时间重渲染
  }, [snapshot.sessions, sortKey, sortDesc, nowTick]);

  const toggleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
      return;
    }
    setSortKey(key);
    setSortDesc(true);
  };

  const header = (key: SortKey, labelId: string, align: "left" | "right" = "right") => (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 font-medium text-foreground-subtle ${
        align === "right" ? "text-right" : "text-left"
      }`}
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

  return (
    <section className="rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.ledger.sessionsTitle" })}
      </h3>
      {rows.length === 0 ? (
        <div className="mt-3">
          <UsageEmptyState
            title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
            description={intl.formatMessage({ id: "settings.usage.ledger.tableEmptyDescription" })}
          />
        </div>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-156 border-collapse text-ui-base">
            <thead>
              <tr className="border-b border-border">
                {header("title", "settings.usage.ledger.sessions.title", "left")}
                <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle">
                  {intl.formatMessage({ id: "settings.usage.ledger.sessions.project" })}
                </th>
                {header("calls", "settings.usage.ledger.sessions.calls")}
                {header("tokens", "settings.usage.ledger.sessions.tokens")}
                {header("cost", "settings.usage.ledger.sessions.cost")}
                {header("lastActiveMs", "settings.usage.ledger.sessions.lastActive")}
              </tr>
            </thead>
            <tbody>
              {rows.map((session) => (
                <tr
                  key={`${session.src ?? ""}:${session.sessionId}`}
                  className="border-b border-border/60 last:border-0"
                >
                  <td
                    className="max-w-72 truncate px-3 py-2"
                    title={session.title ?? session.sessionId}
                  >
                    {session.title ||
                      intl.formatMessage({ id: "settings.usage.ledger.sessions.untitled" })}
                  </td>
                  <td
                    className="max-w-52 truncate px-3 py-2 text-foreground-subtle"
                    title={session.directory ?? ""}
                  >
                    {shortenLedgerDirectory(session.directory)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactNumber(locale, session.calls)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {formatCompactTokenUsage(locale, session.inputTokens + session.outputTokens)}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                    {session.cost !== null
                      ? formatLedgerCost(locale, session.cost, currency)
                      : "--"}
                  </td>
                  <td
                    className="whitespace-nowrap px-3 py-2 text-right text-foreground-subtle"
                    title={
                      session.lastActiveMs !== null
                        ? new Date(session.lastActiveMs).toLocaleString(locale)
                        : undefined
                    }
                  >
                    {formatLedgerRelativeTime(locale, session.lastActiveMs)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

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
}: {
  snapshot: LedgerSnapshot;
  locale: string;
  currency: string;
}) {
  const { intl } = useZCodeIntl();
  const rows = snapshot.recent.slice(0, 100);
  if (rows.length === 0) {
    return null;
  }

  return (
    <section className="rounded-xl bg-surface p-4">
      <h3 className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.usage.ledger.recentTitle" })}
      </h3>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-220 border-collapse text-ui-base">
          <thead>
            <tr className="border-b border-border">
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.time" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.source" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.model" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.agent" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.status" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.input" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.output" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.recent.duration" })}
              </th>
              <th className="whitespace-nowrap px-3 py-2 text-right font-medium text-foreground-subtle">
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
    </section>
  );
}
