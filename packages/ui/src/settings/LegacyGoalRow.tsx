import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { goalTitle } from "@/app-shell/goalDisplay.js";
import { AutomationGoalBadge } from "@/settings/AutomationGoalBadge.js";

/**
 * 遗留目标任务行（sessionId 未被任何目标形态 automation 的 targetTaskId 引用）：
 * 只读展示目标描述 + 状态徽标，行内三个操作（打开详情 / 打开会话 / 清除）。
 * 不承载暂停/恢复等深层编辑——那些能力仍由 goals 主视图（GoalsPanel）提供。
 */
export function LegacyGoalRow({
  entry,
  now,
  busy,
  onOpenGoals,
  onOpenSession,
  onClear,
}: {
  entry: ZCodeSessionGoalListEntry;
  now: number;
  busy: boolean;
  onOpenGoals: () => void;
  onOpenSession: () => void;
  onClear: () => void;
}) {
  const { intl } = useZCodeIntl();
  const title = goalTitle(entry.goal);
  return (
    <div className="flex w-full flex-col gap-2 rounded-xl border border-card-border bg-background p-3">
      <div className="flex min-w-0 items-start gap-2">
        <span
          className="min-w-0 flex-1 truncate text-ui-base font-medium leading-5 text-foreground"
          title={title}
        >
          {title}
        </span>
        <AutomationGoalBadge goal={entry.goal} now={now} />
      </div>
      <div
        className="min-w-0 truncate text-ui-sm text-foreground-subtle"
        title={entry.sessionTitle}
      >
        {entry.sessionTitle}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          onClick={onOpenGoals}
        >
          {intl.formatMessage({ id: "automations.legacyGoals.open" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={busy}
          onClick={onOpenSession}
        >
          {intl.formatMessage({ id: "automations.legacyGoals.openSession" })}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="shrink-0 !text-destructive hover:!bg-destructive/10"
          disabled={busy}
          onClick={onClear}
        >
          {intl.formatMessage({ id: "automations.legacyGoals.clear" })}
        </Button>
      </div>
    </div>
  );
}
