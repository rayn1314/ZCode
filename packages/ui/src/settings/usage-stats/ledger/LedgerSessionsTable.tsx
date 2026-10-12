import { useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import type { LedgerSnapshot } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  UsageEmptyState,
  formatCompactNumber,
  formatCompactTokenUsage,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  formatLedgerCost,
  formatLedgerRelativeTime,
  shortenLedgerDirectory,
} from "./ledgerFormat.js";
import { LedgerTablePagination } from "./LedgerTablePagination.js";
import {
  buildSessionForest,
  collectExpandableKeys,
  createSessionComparator,
  flattenSessionForest,
  toggleExpandedKey,
  type LedgerSessionSortKey,
} from "./sessionTree.js";

// 会话明细表：顶层会话之间按所选列排序，父子层级按需展开、默认全折叠。
// 表格遵守 DESIGN.md：text-ui-base、右对齐数值列、窄屏面板内横向滚动（不撑破页面），
// 滚动容器固定限高 + 内部滚动、表头吸顶——行数再多也不把整页撑长。
//
// 数据层给的 calls / tokens / cost 已经是「自身 + 全部后代」的子树合计，因此：
//   · 合计值原样展示，带子会话的行挂 tooltip 说明口径，避免被读成本会话自身的用量；
//   · 分页只按顶层会话数切页（子行跟随父行、不占页容量），顶层行相加即全量、不会双计。
// 层级判定交给 sessionTree：父会话不在本批快照里的行按顶层渲染，否则会挂到看不见的父下面。

const TABLE_SCROLL_CLASS = "mt-3 max-h-[32rem] overflow-auto";
const TH_STICKY_CLASS = "sticky top-0 z-1 bg-surface";

const EXPAND_ROW_LABEL_ID = "settings.usage.ledger.sessions.expandRow";
const COLLAPSE_ROW_LABEL_ID = "settings.usage.ledger.sessions.collapseRow";
const CHILD_COUNT_ONE_LABEL_ID = "settings.usage.ledger.sessions.childCount.one";
const CHILD_COUNT_OTHER_LABEL_ID = "settings.usage.ledger.sessions.childCount.other";

// 只给派生会话打标签；interactive 与未知类型不打，避免主会话行满屏徽标。
const SESSION_TYPE_LABEL_IDS: Record<string, string> = {
  subagent_child: "settings.usage.ledger.sessions.type.subagent",
  selection_side_chat: "settings.usage.ledger.sessions.type.sideChat",
  workflow_child: "settings.usage.ledger.sessions.type.workflow",
  fork: "settings.usage.ledger.sessions.type.fork",
};

// 有子会话的行的 Tokens / 费用是「自身 + 全部后代」的合计，容易和本会话自身混淆，挂 tooltip 说明口径。
function AggregateCell({ count, text, hint }: { count: number; text: string; hint: string }) {
  if (count === 0) {
    return text;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help underline decoration-dotted underline-offset-2">{text}</span>
      </TooltipTrigger>
      <TooltipContent side="top">{hint}</TooltipContent>
    </Tooltip>
  );
}

export function LedgerSessionsTable({
  snapshot,
  locale,
  currency,
  nowTick,
  pageSize,
  onPageSizeChange,
}: {
  snapshot: LedgerSnapshot;
  locale: string;
  currency: string;
  nowTick: number;
  pageSize: number;
  onPageSizeChange: (size: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const [sortKey, setSortKey] = useState<LedgerSessionSortKey>("tokens");
  const [sortDesc, setSortDesc] = useState(true);
  const [page, setPage] = useState(1);
  // 展开集合是「哪一行展开」的唯一来源，默认全折叠；快照刷新或改排序都不重置它，
  // 否则自动刷新会把用户手动展开的层级收回去。
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => new Set());

  const forest = useMemo(
    // nowTick 变化触发相对时间重渲染
    () => buildSessionForest(snapshot.sessions, createSessionComparator(sortKey, sortDesc)),
    [snapshot.sessions, sortKey, sortDesc, nowTick],
  );
  const canExpand = forest.children.size > 0;
  const sessionsTitle = intl.formatMessage({ id: "settings.usage.ledger.sessionsTitle" });
  const scopeSummary = intl.formatMessage(
    { id: "settings.usage.ledger.sessions.scopeSummary" },
    { topLevel: forest.roots.length, total: snapshot.sessions.length },
  );
  const expandAllLabel = intl.formatMessage({ id: "settings.usage.ledger.sessions.expandAll" });
  const collapseAllLabel = intl.formatMessage({ id: "settings.usage.ledger.sessions.collapseAll" });
  const aggregateHint = intl.formatMessage({
    id: "settings.usage.ledger.sessions.includingChildren",
  });

  // 快照、排序或页大小变化都回到第一页，避免停留在越界页
  useEffect(() => {
    setPage(1);
  }, [snapshot.generatedAt, sortKey, sortDesc, pageSize]);

  // 分页按顶层会话数：子行不占页容量，否则同一条链会被拆到两页，看着像丢数据。
  const pageCount = Math.max(1, Math.ceil(forest.roots.length / pageSize));
  const current = Math.min(page, pageCount);
  const pageRoots = forest.roots.slice((current - 1) * pageSize, current * pageSize);
  const visibleRows = flattenSessionForest({ ...forest, roots: pageRoots }, expandedKeys);

  const toggleSort = (key: LedgerSessionSortKey) => {
    if (sortKey === key) {
      setSortDesc((d) => !d);
      return;
    }
    setSortKey(key);
    setSortDesc(true);
  };

  const toggleExpanded = (key: string) => {
    setExpandedKeys((keys) => toggleExpandedKey(keys, key));
  };

  const header = (
    key: LedgerSessionSortKey,
    labelId: string,
    align: "left" | "right" = "right",
  ) => (
    <th
      scope="col"
      className={`whitespace-nowrap px-3 py-2 font-medium text-foreground-subtle ${TH_STICKY_CLASS} ${
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
  const expandAll = () => setExpandedKeys(collectExpandableKeys(forest));
  const collapseAll = () => setExpandedKeys(new Set<string>());

  return (
    // 本表自己兜住 TooltipProvider：radix 的 Tooltip 没有 Provider 会直接抛错，
    // 而这里每页最多几十行、每行两个 tooltip，按表建一个 Provider 比按 tooltip 建更省。
    <TooltipProvider>
      <section className="rounded-xl bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="text-ui-base font-medium text-foreground">{sessionsTitle}</h3>
            <p className="mt-0.5 text-ui-sm text-foreground-subtle">{scopeSummary}</p>
          </div>
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!canExpand}
              onClick={expandAll}
            >
              {expandAllLabel}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={!canExpand}
              onClick={collapseAll}
            >
              {collapseAllLabel}
            </Button>
          </div>
        </div>
        {snapshot.sessions.length === 0 ? (
          <div className="mt-3">
            <UsageEmptyState
              title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
              description={intl.formatMessage({
                id: "settings.usage.ledger.tableEmptyDescription",
              })}
            />
          </div>
        ) : (
          <div className={TABLE_SCROLL_CLASS}>
            <table className="w-full min-w-156 border-collapse text-ui-base">
              <thead>
                <tr className="border-b border-border">
                  {header("title", "settings.usage.ledger.sessions.title", "left")}
                  <th
                    className={`whitespace-nowrap px-3 py-2 text-left font-medium text-foreground-subtle ${TH_STICKY_CLASS}`}
                  >
                    {intl.formatMessage({ id: "settings.usage.ledger.sessions.project" })}
                  </th>
                  {header("calls", "settings.usage.ledger.sessions.calls")}
                  {header("tokens", "settings.usage.ledger.sessions.tokens")}
                  {header("cost", "settings.usage.ledger.sessions.cost")}
                  {header("lastActiveMs", "settings.usage.ledger.sessions.lastActive")}
                </tr>
              </thead>
              <tbody>
                {visibleRows.map((node) => {
                  const session = node.row;
                  const aggregates = session.childCount > 0;
                  const typeLabelId = SESSION_TYPE_LABEL_IDS[session.taskType ?? ""];
                  const toggleLabelId = node.expanded ? COLLAPSE_ROW_LABEL_ID : EXPAND_ROW_LABEL_ID;
                  const childCountLabelId =
                    session.childCount === 1
                      ? CHILD_COUNT_ONE_LABEL_ID
                      : CHILD_COUNT_OTHER_LABEL_ID;
                  return (
                    <tr key={node.key} className="border-b border-border/60 last:border-0">
                      <td className="max-w-72 px-3 py-2">
                        <div
                          className="flex min-w-0 items-center gap-1.5"
                          style={{ paddingLeft: 12 + node.depth * 16 }}
                        >
                          {node.hasChildren ? (
                            <button
                              type="button"
                              aria-expanded={node.expanded}
                              aria-label={intl.formatMessage({ id: toggleLabelId })}
                              className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-foreground-subtle hover:bg-hover hover:text-foreground"
                              onClick={() => toggleExpanded(node.key)}
                            >
                              <ChevronRight
                                className={cn(
                                  "size-3.5 transition-transform",
                                  node.expanded && "rotate-90",
                                )}
                              />
                            </button>
                          ) : (
                            // 等宽占位（与 chevron 按钮同宽）：没有子会话的行也要和同级有子会话行的标题左边缘对齐
                            <span className="w-4 shrink-0" aria-hidden="true" />
                          )}
                          <div
                            className={cn(
                              "flex min-w-0 items-center gap-1.5",
                              node.depth >= 1 && "border-l border-border/60 pl-2",
                            )}
                          >
                            <span
                              className={cn(
                                "min-w-0 truncate",
                                node.depth === 0 && "font-medium text-foreground",
                              )}
                              title={session.title ?? session.sessionId}
                            >
                              {session.title ||
                                intl.formatMessage({
                                  id: "settings.usage.ledger.sessions.untitled",
                                })}
                            </span>
                            {typeLabelId ? (
                              <Badge variant="secondary" className="text-ui-xs">
                                {intl.formatMessage({ id: typeLabelId })}
                              </Badge>
                            ) : null}
                            {aggregates ? (
                              <span className="shrink-0 text-ui-xs text-foreground-subtle">
                                {intl.formatMessage(
                                  { id: childCountLabelId },
                                  { count: session.childCount },
                                )}
                              </span>
                            ) : null}
                          </div>
                        </div>
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
                        <AggregateCell
                          count={session.childCount}
                          text={formatCompactTokenUsage(
                            locale,
                            session.inputTokens + session.outputTokens,
                          )}
                          hint={aggregateHint}
                        />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                        <AggregateCell
                          count={session.childCount}
                          text={
                            session.cost !== null
                              ? formatLedgerCost(locale, session.cost, currency)
                              : "--"
                          }
                          hint={aggregateHint}
                        />
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
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {forest.roots.length > 0 ? (
          <LedgerTablePagination
            total={forest.roots.length}
            page={current}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={onPageSizeChange}
          />
        ) : null}
      </section>
    </TooltipProvider>
  );
}
