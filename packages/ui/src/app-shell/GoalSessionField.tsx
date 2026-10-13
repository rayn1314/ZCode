import { useEffect, useState } from "react";
import type { ZCodeSessionGoalListEntry, ZCodeSessionInfo } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Spinner } from "@/components/ui/spinner.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";
import { Field } from "./GoalFormField.js";

/** 已有的承载会话候选（新建模式下可选）。 */
export type GoalHostMode = "new" | "existing";

/** 会话选择器的触发框高度：与仓库其它表单保持一致。 */
const SELECT_TRIGGER_CLASSNAME = "h-9";

function RadioDot({ active }: { active: boolean }) {
  return (
    <span
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full border-[1.33px]",
        active ? "border-primary bg-primary" : "border-border",
      )}
      aria-hidden="true"
    >
      {active ? <span className="size-1.5 rounded-full bg-primary-foreground" /> : null}
    </span>
  );
}

/**
 * 承载会话选择器：编辑态锁定展示目标所属会话；新建态可选「新建会话」或在
 * 目标任务项目下复用已有会话（只读查询，避免仅打开表单就拉起 runtime）。
 */
export function GoalSessionField({
  editing,
  listWorkspacePath,
  listWorkspaceIdentity,
  hostMode,
  sessionId,
  onHostModeChange,
  onSessionIdChange,
}: {
  editing: ZCodeSessionGoalListEntry | null;
  /** 会话候选的查询工作区：跟随目标任务项目。 */
  listWorkspacePath: string;
  listWorkspaceIdentity?: string;
  hostMode: GoalHostMode;
  sessionId: string;
  onHostModeChange: (mode: GoalHostMode) => void;
  onSessionIdChange: (id: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const { zcodeAgentService } = useServices();

  const [sessions, setSessions] = useState<ZCodeSessionInfo[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // 选择已有会话时才拉候选列表；用只读查询，避免仅打开表单就拉起 runtime。
  useEffect(() => {
    if (editing || hostMode !== "existing") return;
    let cancelled = false;
    setSessionsLoading(true);
    void zcodeAgentService
      .listSessions({
        workspacePath: listWorkspacePath,
        ...(listWorkspaceIdentity ? { workspaceIdentity: listWorkspaceIdentity } : {}),
      })
      .then((result) => {
        if (cancelled) return;
        setSessions(result);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        logger.warn("[goals] list sessions failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        setSessions([]);
      })
      .finally(() => {
        if (!cancelled) setSessionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [editing, hostMode, listWorkspaceIdentity, listWorkspacePath, zcodeAgentService]);

  const sessionOptions = sessions ?? [];

  if (editing) {
    return (
      <Field label={intl.formatMessage({ id: "goals.form.session" })}>
        <div className="text-ui-base leading-5 text-foreground-subtle">{editing.sessionTitle}</div>
      </Field>
    );
  }

  return (
    <Field label={intl.formatMessage({ id: "goals.form.session" })}>
      <div
        className="flex flex-col gap-2"
        role="radiogroup"
        aria-label={intl.formatMessage({ id: "goals.form.session" })}
      >
        <button
          type="button"
          role="radio"
          aria-checked={hostMode === "new"}
          onClick={() => onHostModeChange("new")}
          className="flex h-9 w-fit items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 text-foreground transition-colors hover:bg-surface-hover"
        >
          <RadioDot active={hostMode === "new"} />
          {intl.formatMessage({ id: "goals.form.sessionNew" })}
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={hostMode === "existing"}
          onClick={() => onHostModeChange("existing")}
          className="flex h-9 w-fit items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 text-foreground transition-colors hover:bg-surface-hover"
        >
          <RadioDot active={hostMode === "existing"} />
          {intl.formatMessage({ id: "goals.form.sessionExisting" })}
        </button>
        {hostMode === "existing" ? (
          <div className="pl-6">
            {sessionsLoading ? (
              <div className="flex h-9 items-center">
                <Spinner className="size-4" />
              </div>
            ) : sessionOptions.length === 0 ? (
              <p className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "goals.form.noSessions" })}
              </p>
            ) : (
              <Select value={sessionId} onValueChange={onSessionIdChange}>
                <SelectTrigger className={cn(SELECT_TRIGGER_CLASSNAME, "w-full max-w-md")}>
                  <SelectValue
                    placeholder={intl.formatMessage({ id: "goals.form.sessionExisting" })}
                  />
                </SelectTrigger>
                <SelectContent>
                  {sessionOptions.map((session) => (
                    <SelectItem key={session.sessionId} value={session.sessionId}>
                      {session.title || session.sessionId}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        ) : null}
      </div>
    </Field>
  );
}
