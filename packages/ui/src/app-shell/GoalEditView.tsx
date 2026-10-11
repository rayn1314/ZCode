import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft } from "lucide-react";
import type { ZCodeSessionGoalListEntry, ZCodeSessionInfo } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Spinner } from "@/components/ui/spinner.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { logger } from "@/logger.js";

/** 表单提交结果；`sessionId` 缺省表示「新建会话」承载。 */
export interface GoalEditSubmit {
  sessionId?: string;
  objective: string;
  endAtMs: number | null;
  tokenBudget: number | null;
}

interface GoalEditViewProps {
  /** null = 新建；否则编辑已存在的目标（承载会话锁定）。 */
  editing: ZCodeSessionGoalListEntry | null;
  workspacePath: string;
  workspaceIdentity?: string;
  saving: boolean;
  readOnly: boolean;
  onSubmit: (params: GoalEditSubmit) => Promise<boolean>;
  onBack: () => void;
}

/** 已有的承载会话候选（新建模式下可选）。 */
type HostMode = "new" | "existing";

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * epoch ms → `<input type="datetime-local">` 期望的本地时间串。
 * 绝不能用 toISOString()：它输出 UTC，会凭空差出一个时区。
 */
export function toDateTimeLocalValue(ms: number): string {
  const date = new Date(ms);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}T${pad2(
    date.getHours(),
  )}:${pad2(date.getMinutes())}`;
}

/** datetime-local 串 → epoch ms；空串或非法值返回 null。 */
export function parseDateTimeLocalValue(value: string): number | null {
  if (!value) return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function Field({
  label,
  hint,
  error,
  htmlFor,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-ui-base leading-5 text-foreground">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-ui-sm text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-ui-sm text-foreground-subtle">{hint}</p>
      ) : null}
    </div>
  );
}

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

/** 会话选择器的触发框高度：与仓库其它表单保持一致。 */
const SELECT_TRIGGER_CLASSNAME = "h-9";

export function GoalEditView({
  editing,
  workspacePath,
  workspaceIdentity,
  saving,
  readOnly,
  onSubmit,
  onBack,
}: GoalEditViewProps) {
  const { intl } = useZCodeIntl();
  const { zcodeAgentService } = useServices();

  const [objective, setObjective] = useState("");
  const [deadlineValue, setDeadlineValue] = useState("");
  const [budgetValue, setBudgetValue] = useState("");
  const [hostMode, setHostMode] = useState<HostMode>("new");
  const [existingSessionId, setExistingSessionId] = useState<string>("");
  const [sessions, setSessions] = useState<ZCodeSessionInfo[] | null>(null);
  const [sessionsLoading, setSessionsLoading] = useState(false);

  // 打开/切换编辑对象时重置表单。
  useEffect(() => {
    if (editing) {
      setObjective(editing.goal.objective);
      setDeadlineValue(
        editing.goal.endAtMs != null ? toDateTimeLocalValue(editing.goal.endAtMs) : "",
      );
      setBudgetValue(editing.goal.tokenBudget != null ? String(editing.goal.tokenBudget) : "");
      setHostMode("existing");
      setExistingSessionId(editing.sessionId);
      return;
    }
    setObjective("");
    setDeadlineValue("");
    setBudgetValue("");
    setHostMode("new");
    setExistingSessionId("");
  }, [editing]);

  // 选择已有会话时才拉候选列表；用只读查询，避免仅打开表单就拉起 runtime。
  useEffect(() => {
    if (editing || hostMode !== "existing") return;
    let cancelled = false;
    setSessionsLoading(true);
    void zcodeAgentService
      .listSessions({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
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
  }, [editing, hostMode, workspacePath, workspaceIdentity, zcodeAgentService]);

  const deadlineMs = parseDateTimeLocalValue(deadlineValue);
  const deadlineInvalid = deadlineValue !== "" && (deadlineMs === null || deadlineMs <= Date.now());
  const trimmedBudget = budgetValue.trim();
  const budgetInvalid = trimmedBudget !== "" && !/^[1-9]\d*$/.test(trimmedBudget);
  const objectiveValid = objective.trim().length > 0;
  const sessionValid = editing ? true : hostMode === "new" || existingSessionId !== "";
  const canSubmit =
    objectiveValid && !deadlineInvalid && !budgetInvalid && sessionValid && !saving && !readOnly;

  const sessionOptions = useMemo(() => sessions ?? [], [sessions]);

  const handleSubmit = useCallback(
    async (event: FormEvent) => {
      event.preventDefault();
      if (!canSubmit) return;
      // 客户端是截止时间的唯一校验点（服务端不兜底），提交瞬间再确认一次。
      const submitDeadlineMs = parseDateTimeLocalValue(deadlineValue);
      if (deadlineValue !== "" && (submitDeadlineMs === null || submitDeadlineMs <= Date.now())) {
        return;
      }
      // 成功后的关闭/跳转由调用方负责；这里只负责把表单值交给它。
      await onSubmit({
        ...(editing
          ? { sessionId: editing.sessionId }
          : hostMode === "existing" && existingSessionId
            ? { sessionId: existingSessionId }
            : {}),
        objective: objective.trim(),
        endAtMs: submitDeadlineMs,
        tokenBudget: trimmedBudget === "" ? null : Number(trimmedBudget),
      });
    },
    [
      canSubmit,
      deadlineValue,
      editing,
      existingSessionId,
      hostMode,
      objective,
      onSubmit,
      trimmedBudget,
    ],
  );

  return (
    <div className="flex flex-col gap-6" data-testid="goal-edit-view">
      {/* 面包屑：编辑态显示一行「编辑任务」，点它回到列表；新建态不额外占位。 */}
      <SettingsBreadcrumbReporter
        items={editing ? [{ label: intl.formatMessage({ id: "goals.form.editTitle" }) }] : []}
        onSectionSelect={onBack}
      />

      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label={intl.formatMessage({ id: "goals.form.cancel" })}
        >
          <ArrowLeft className="size-4" aria-hidden="true" />
        </Button>
        <h1 className="text-ui-xl font-medium leading-7 text-foreground">
          {intl.formatMessage({ id: editing ? "goals.form.editTitle" : "goals.form.title" })}
        </h1>
      </div>

      <form
        className="flex max-w-2xl flex-col gap-5"
        onSubmit={(event) => void handleSubmit(event)}
      >
        <Field label={intl.formatMessage({ id: "goals.form.objective" })} htmlFor="goal-objective">
          <Textarea
            id="goal-objective"
            value={objective}
            autoFocus
            rows={4}
            placeholder={intl.formatMessage({ id: "goals.form.objectivePlaceholder" })}
            onChange={(event) => setObjective(event.target.value)}
          />
        </Field>

        <Field
          label={intl.formatMessage({ id: "goals.form.deadline" })}
          htmlFor="goal-deadline"
          error={
            deadlineInvalid
              ? intl.formatMessage({ id: "goals.form.deadlineMustBeFuture" })
              : undefined
          }
          hint={intl.formatMessage({ id: "goals.form.deadlineHint" })}
        >
          <Input
            id="goal-deadline"
            type="datetime-local"
            value={deadlineValue}
            aria-invalid={deadlineInvalid}
            className="w-fit"
            onChange={(event) => setDeadlineValue(event.target.value)}
          />
        </Field>

        <Field
          label={intl.formatMessage({ id: "goals.form.tokenBudget" })}
          htmlFor="goal-token-budget"
          error={
            budgetInvalid
              ? intl.formatMessage({ id: "goals.form.tokenBudgetMustBePositive" })
              : undefined
          }
          hint={intl.formatMessage({ id: "goals.form.tokenBudgetHint" })}
        >
          <Input
            id="goal-token-budget"
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={budgetValue}
            aria-invalid={budgetInvalid}
            className="w-40"
            onChange={(event) => {
              const value = event.target.value;
              // number 输入允许空值便于编辑，但只接收正整数文本，避免把无效值写进预算。
              if (value === "" || /^\d+$/.test(value)) setBudgetValue(value);
            }}
          />
        </Field>

        {editing ? (
          <Field label={intl.formatMessage({ id: "goals.form.session" })}>
            <div className="text-ui-base leading-5 text-foreground-subtle">
              {editing.sessionTitle}
            </div>
          </Field>
        ) : (
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
                onClick={() => setHostMode("new")}
                className="flex h-9 w-fit items-center gap-2 rounded-[8px] px-2 text-ui-base leading-5 text-foreground transition-colors hover:bg-surface-hover"
              >
                <RadioDot active={hostMode === "new"} />
                {intl.formatMessage({ id: "goals.form.sessionNew" })}
              </button>
              <button
                type="button"
                role="radio"
                aria-checked={hostMode === "existing"}
                onClick={() => setHostMode("existing")}
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
                    <Select value={existingSessionId} onValueChange={setExistingSessionId}>
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
        )}

        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "goals.form.deadlineNotice" })}
        </p>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={!canSubmit}>
            {intl.formatMessage({ id: "goals.form.submit" })}
          </Button>
          <Button type="button" variant="outline" onClick={onBack}>
            {intl.formatMessage({ id: "goals.form.cancel" })}
          </Button>
        </div>
      </form>
    </div>
  );
}
