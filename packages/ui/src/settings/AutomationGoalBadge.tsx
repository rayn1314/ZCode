import type { ZCodeSessionGoal } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  GOAL_STATUS_TEXT_CLASS,
  isGoalApproachingDeadline,
  resolveGoalDisplayStatus,
} from "@/app-shell/goalDisplay.js";

/**
 * 自动化卡片 / 遗留目标任务行共用的目标状态徽标：只读展示 resolveGoalDisplayStatus
 * 的文案与色系，不承载任何写操作；dimmed 用于编辑页 / 弱化上下文。
 */
export function AutomationGoalBadge({
  goal,
  now,
  dimmed = false,
}: {
  goal: ZCodeSessionGoal;
  now: number;
  dimmed?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const displayStatus = resolveGoalDisplayStatus(goal, now);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-md bg-surface px-1.5 py-0.5 text-ui-xs font-medium",
        GOAL_STATUS_TEXT_CLASS[displayStatus],
        dimmed && "opacity-40",
      )}
    >
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          displayStatus === "active" ? "bg-success" : "bg-foreground-subtlest",
        )}
        aria-hidden="true"
      />
      {intl.formatMessage({ id: `goals.status.${displayStatus}` })}
      {isGoalApproachingDeadline(goal) ? (
        <span className="font-medium text-warning">
          {intl.formatMessage({ id: "goals.status.approaching" })}
        </span>
      ) : null}
    </span>
  );
}
