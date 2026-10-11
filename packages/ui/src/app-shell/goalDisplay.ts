import type { ZCodeSessionGoal } from "@zcode/shared";
import type { IntlInstance } from "@/i18n/IntlProvider.js";

/**
 * 任务面板的纯展示派生：只读 DB 权威状态，永不写库、不发请求。
 * 拆成独立模块是为了让「状态映射」这一唯一口径能被单独引用与推敲。
 */

export type GoalFilter = "all" | "active" | "paused" | "stopped" | "complete";

export const GOAL_FILTERS: readonly GoalFilter[] = [
  "all",
  "active",
  "paused",
  "stopped",
  "complete",
];

/**
 * 派生显示态：`deadlineReached` = 已过点待收尾（graceUsed=false，服务端还会给一轮收尾）；
 * `deadlinePending` = 收尾轮已发出、等待结算。
 */
export type GoalDisplayStatus =
  | "active"
  | "paused"
  | "deadlineReached"
  | "deadlinePending"
  | "stopped"
  | "complete";

export const GOAL_STATUS_TEXT_CLASS: Record<GoalDisplayStatus, string> = {
  active: "text-success",
  paused: "text-foreground-subtle",
  deadlineReached: "text-warning",
  deadlinePending: "text-warning",
  stopped: "text-foreground-subtlest",
  complete: "text-foreground-subtle",
};

/** 与 OffPeakTaskList 同口径：最多露出 8 张卡片，超出由容器自身滚动。 */
export const GOAL_LIST_SCROLL_THRESHOLD = 8;
export const GOAL_LIST_GRID_CLASS = "grid grid-cols-1 gap-4 lg:grid-cols-2";

/**
 * D5 派生显示：状态权威值只认 DB；这里只把「已过点但尚未结算」的 active 目标细分为两种收尾态。
 */
export function resolveGoalDisplayStatus(goal: ZCodeSessionGoal, now: number): GoalDisplayStatus {
  if (goal.status === "active" && goal.endAtMs != null && now >= goal.endAtMs) {
    return goal.deadlineGraceUsed ? "deadlinePending" : "deadlineReached";
  }
  switch (goal.status) {
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "complete":
      return "complete";
    // deadline_reached 与 budget_limited 都是自动停止，面板统一显示「已停止」。
    case "deadline_reached":
    case "budget_limited":
      return "stopped";
  }
}

export function matchesGoalFilter(displayStatus: GoalDisplayStatus, filter: GoalFilter): boolean {
  if (filter === "all") return true;
  if (filter === "stopped") return displayStatus === "stopped";
  // 「进行中」包含两种派生收尾态：它们的权威状态仍是 active。
  if (filter === "active") {
    return (
      displayStatus === "active" ||
      displayStatus === "deadlineReached" ||
      displayStatus === "deadlinePending"
    );
  }
  return displayStatus === filter;
}

export function goalTitle(goal: ZCodeSessionGoal): string {
  return goal.summaryTitle?.trim() || goal.objective;
}

/** 剩余时长文案：不足 1 分钟、只有小时、只有分钟、两者都有。 */
export function formatRemaining(intl: IntlInstance, remainingMs: number): string {
  const totalMinutes = Math.max(0, Math.round(remainingMs / 60_000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0 && minutes <= 0) {
    return intl.formatMessage({ id: "goals.duration.lessThanMinute" });
  }
  const hoursLabel = intl.formatMessage({ id: "goals.duration.hours" }, { count: hours });
  const minutesLabel = intl.formatMessage({ id: "goals.duration.minutes" }, { count: minutes });
  if (hours <= 0) return minutesLabel;
  if (minutes <= 0) return hoursLabel;
  return `${hoursLabel} ${minutesLabel}`;
}

export function goalDeadlineText(intl: IntlInstance, goal: ZCodeSessionGoal, now: number): string {
  const endAtMs = goal.endAtMs;
  if (endAtMs == null) return intl.formatMessage({ id: "goals.row.noDeadline" });
  if (now >= endAtMs) return intl.formatMessage({ id: "goals.row.deadlinePassed" });
  return intl.formatMessage(
    { id: "goals.row.remaining" },
    { time: formatRemaining(intl, endAtMs - now) },
  );
}

export function goalTokenText(intl: IntlInstance, goal: ZCodeSessionGoal): string {
  return goal.tokenBudget != null
    ? intl.formatMessage(
        { id: "goals.row.budget" },
        { used: goal.tokensUsed, budget: goal.tokenBudget },
      )
    : intl.formatMessage({ id: "goals.row.tokensUsed" }, { used: goal.tokensUsed });
}

/** 只有 active 能暂停；暂停/已截止/预算受限都能恢复。 */
export function canPauseGoal(goal: ZCodeSessionGoal): boolean {
  return goal.status === "active";
}

export function canResumeGoal(goal: ZCodeSessionGoal): boolean {
  return (
    goal.status === "paused" ||
    goal.status === "deadline_reached" ||
    goal.status === "budget_limited"
  );
}

/**
 * 恢复前是否必须先重新设定截止时间：
 * `deadline_reached` 由服务端强制要求；截止时间已经过期时沿用旧值会被立刻判停，同样要求用户重设。
 */
export function goalResumeNeedsNewDeadline(goal: ZCodeSessionGoal, now: number): boolean {
  return goal.status === "deadline_reached" || (goal.endAtMs != null && goal.endAtMs <= now);
}
