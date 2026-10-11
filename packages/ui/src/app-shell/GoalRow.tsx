import { MoreHorizontal } from "lucide-react";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  GOAL_STATUS_TEXT_CLASS,
  canPauseGoal,
  canResumeGoal,
  goalDeadlineText,
  goalTitle,
  goalTokenText,
  resolveGoalDisplayStatus,
  type GoalDisplayStatus,
} from "./goalDisplay.js";
import { cn } from "@/components/lib/utils.js";

function GoalStatusBadge({ displayStatus }: { displayStatus: GoalDisplayStatus }) {
  const { intl } = useZCodeIntl();
  return (
    <span
      className={cn(
        "shrink-0 whitespace-nowrap text-ui-xs font-medium",
        GOAL_STATUS_TEXT_CLASS[displayStatus],
      )}
    >
      {intl.formatMessage({ id: `goals.status.${displayStatus}` })}
    </span>
  );
}

/**
 * 列表卡片：整行可点即打开承载会话；行尾「更多」是唯一入口承载暂停/恢复/编辑/清除。
 */
export function GoalRow({
  entry,
  now,
  readOnly,
  busy,
  onOpenSession,
  onEdit,
  onPause,
  onResume,
  onClear,
}: {
  entry: ZCodeSessionGoalListEntry;
  now: number;
  readOnly: boolean;
  busy: boolean;
  onOpenSession: () => void;
  onEdit: () => void;
  onPause: () => void;
  onResume: () => void;
  onClear: () => void;
}) {
  const { intl } = useZCodeIntl();
  const { goal } = entry;
  const displayStatus = resolveGoalDisplayStatus(goal, now);
  const title = goalTitle(goal);

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onOpenSession}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenSession();
        }
      }}
      className="group relative flex min-h-0 cursor-pointer flex-col gap-2 rounded-xl border border-card-border bg-card p-4 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused"
    >
      <div className="flex min-w-0 items-start gap-2">
        <span
          className="min-w-0 flex-1 truncate text-ui-base font-medium leading-5 text-foreground"
          title={title}
        >
          {title}
        </span>
        <GoalStatusBadge displayStatus={displayStatus} />
      </div>

      <div
        className="min-w-0 truncate text-ui-sm text-foreground-subtle"
        title={entry.sessionTitle}
      >
        {entry.sessionTitle}
      </div>

      <div className="flex items-end justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ui-xs tabular-nums text-foreground-subtle">
          <span className="whitespace-nowrap">{goalDeadlineText(intl, goal, now)}</span>
          <span className="whitespace-nowrap">{goalTokenText(intl, goal)}</span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              disabled={readOnly}
              aria-label={intl.formatMessage({ id: "goals.row.more" })}
              data-testid={`goals-row-menu-${entry.sessionId}`}
              className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-100 transition-colors hover:bg-hover data-[state=open]:bg-hover disabled:cursor-not-allowed disabled:opacity-40 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100"
              onClick={(event) => event.stopPropagation()}
            >
              <MoreHorizontal className="size-4 text-foreground-subtle" aria-hidden="true" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            sideOffset={4}
            onClick={(event) => event.stopPropagation()}
          >
            {canPauseGoal(goal) ? (
              <DropdownMenuItem className="gap-1" disabled={readOnly || busy} onSelect={onPause}>
                {intl.formatMessage({ id: "goals.row.pause" })}
              </DropdownMenuItem>
            ) : null}
            {canResumeGoal(goal) ? (
              <DropdownMenuItem className="gap-1" disabled={readOnly || busy} onSelect={onResume}>
                {intl.formatMessage({ id: "goals.row.resume" })}
              </DropdownMenuItem>
            ) : null}
            <DropdownMenuItem className="gap-1" disabled={readOnly || busy} onSelect={onEdit}>
              {intl.formatMessage({ id: "goals.row.edit" })}
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-1" onSelect={onOpenSession}>
              {intl.formatMessage({ id: "goals.row.openSession" })}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              className="gap-1 !text-destructive data-[highlighted]:!bg-menu-hover data-[highlighted]:!text-destructive focus:!text-destructive [&_svg]:!text-destructive"
              disabled={readOnly || busy}
              onSelect={onClear}
            >
              {intl.formatMessage({ id: "goals.row.clear" })}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
