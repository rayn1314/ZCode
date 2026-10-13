import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { ArrowLeft } from "lucide-react";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { SettingsBreadcrumbReporter } from "@/settings/SettingsHeaderBreadcrumb.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { workspaceLabelFromPath } from "./goalDisplay.js";
import { Field } from "./GoalFormField.js";
import { GoalProjectField, type GoalProjectSelection } from "./GoalProjectField.js";
import { GoalSessionField, type GoalHostMode } from "./GoalSessionField.js";

/** 表单提交结果；`sessionId` 缺省表示「新建会话」承载。 */
export interface GoalEditSubmit {
  sessionId?: string;
  objective: string;
  endAtMs: number | null;
  tokenBudget: number | null;
  /** false = 保存但不运行；true = 保存并运行（置 active 并立即续跑）。 */
  start: boolean;
  /** 目标任务项目：新建=选择器所选，编辑=该目标所属项目。 */
  workspacePath: string;
  workspaceIdentity?: string;
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

/**
 * 本次提交是「保存并运行」还是「保存」：两个提交按钮都带 `data-start`，
 * 通过 SubmitEvent.submitter 取点击的那个按钮（Enter 提交时浏览器默认命中的是
 * 第一个 submit 按钮「保存」，天然落到 start=false）。
 */
function readSubmitStart(event: FormEvent<HTMLFormElement>): boolean {
  const submitter = (event.nativeEvent as SubmitEvent).submitter;
  return submitter instanceof HTMLElement && submitter.dataset.start === "true";
}

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

  const [objective, setObjective] = useState("");
  const [deadlineValue, setDeadlineValue] = useState("");
  // 进入编辑时的截止时间原文：**用户没动过截止字段就放行**（该目标本来就在这个状态），
  // 只有“新填/改过”的过去值才拦截。
  const [originalDeadlineValue, setOriginalDeadlineValue] = useState("");
  const [budgetValue, setBudgetValue] = useState("");
  const [hostMode, setHostMode] = useState<GoalHostMode>("new");
  const [existingSessionId, setExistingSessionId] = useState<string>("");
  // 新建时选择的目标项目路径；null = 默认当前工作区。
  const [createdProjectPath, setCreatedProjectPath] = useState<string | null>(null);

  // 打开/切换编辑对象时重置表单。
  useEffect(() => {
    if (editing) {
      setObjective(editing.goal.objective);
      const originalDeadline =
        editing.goal.endAtMs != null ? toDateTimeLocalValue(editing.goal.endAtMs) : "";
      setDeadlineValue(originalDeadline);
      setOriginalDeadlineValue(originalDeadline);
      setBudgetValue(editing.goal.tokenBudget != null ? String(editing.goal.tokenBudget) : "");
      setHostMode("existing");
      setExistingSessionId(editing.sessionId);
      return;
    }
    setObjective("");
    setDeadlineValue("");
    setOriginalDeadlineValue("");
    setBudgetValue("");
    setHostMode("new");
    setExistingSessionId("");
    setCreatedProjectPath(null);
  }, [editing]);

  // 任务所属项目：编辑态锁定为该目标所在项目；新建态跟随选择器
  // （默认当前工作区；identity 只在选中当前工作区时透传，本地候选项目不编造身份）。
  const selectedProject = useMemo<GoalProjectSelection>(() => {
    if (editing) {
      return {
        workspacePath: editing.workspacePath,
        ...(editing.workspaceIdentity ? { workspaceIdentity: editing.workspaceIdentity } : {}),
        label: workspaceLabelFromPath(editing.workspacePath),
      };
    }
    return {
      workspacePath: createdProjectPath ?? workspacePath,
      ...(createdProjectPath == null && workspaceIdentity ? { workspaceIdentity } : {}),
      label: workspaceLabelFromPath(createdProjectPath ?? workspacePath),
    };
  }, [createdProjectPath, editing, workspaceIdentity, workspacePath]);

  const deadlineMs = parseDateTimeLocalValue(deadlineValue);
  // 截止字段是否被“用户新填/改过”：编辑态与原值不同，新建态任何非空填写都算改动。
  const deadlineChanged = editing ? deadlineValue !== originalDeadlineValue : deadlineValue !== "";
  // 「保存」只拦新改的过去值；没动过的原值（即使已过期）放行，先允许只改文字保存。
  const saveDeadlineInvalid =
    deadlineValue !== "" && (deadlineMs === null || (deadlineChanged && deadlineMs <= Date.now()));
  // 「保存并运行」始终要求空或未来：运行一个已过截止的目标会被立刻硬停。
  const runDeadlineInvalid =
    deadlineValue !== "" && (deadlineMs === null || deadlineMs <= Date.now());
  const deadlinePassedUnchanged =
    Boolean(editing) && !deadlineChanged && deadlineMs !== null && deadlineMs <= Date.now();

  const trimmedBudget = budgetValue.trim();
  const budgetInvalid = trimmedBudget !== "" && !/^[1-9]\d*$/.test(trimmedBudget);
  const objectiveValid = objective.trim().length > 0;
  const sessionValid = editing ? true : hostMode === "new" || existingSessionId !== "";
  const canSave =
    objectiveValid &&
    !saveDeadlineInvalid &&
    !budgetInvalid &&
    sessionValid &&
    !saving &&
    !readOnly;
  const canSaveAndRun =
    objectiveValid && !runDeadlineInvalid && !budgetInvalid && sessionValid && !saving && !readOnly;

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const start = readSubmitStart(event);
      if (start ? !canSaveAndRun : !canSave) return;
      // 客户端是截止时间的唯一校验点（服务端不兜底），提交瞬间再确认一次。
      const submitDeadlineMs = parseDateTimeLocalValue(deadlineValue);
      if (submitDeadlineMs === null) return;
      if (start && deadlineValue !== "" && submitDeadlineMs <= Date.now()) return;
      if (!start && deadlineValue !== "" && deadlineChanged && submitDeadlineMs <= Date.now()) {
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
        start,
        workspacePath: selectedProject.workspacePath,
        ...(selectedProject.workspaceIdentity
          ? { workspaceIdentity: selectedProject.workspaceIdentity }
          : {}),
      });
    },
    [
      canSave,
      canSaveAndRun,
      deadlineChanged,
      deadlineValue,
      editing,
      existingSessionId,
      hostMode,
      objective,
      onSubmit,
      selectedProject.workspaceIdentity,
      selectedProject.workspacePath,
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
            saveDeadlineInvalid
              ? intl.formatMessage({ id: "goals.form.deadlineMustBeFuture" })
              : undefined
          }
          hint={intl.formatMessage({
            id: deadlinePassedUnchanged ? "goals.form.deadlineRunHint" : "goals.form.deadlineHint",
          })}
        >
          <Input
            id="goal-deadline"
            type="datetime-local"
            value={deadlineValue}
            aria-invalid={saveDeadlineInvalid}
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

        <GoalProjectField
          editing={editing}
          workspacePath={workspacePath}
          value={selectedProject.workspacePath}
          onValueChange={setCreatedProjectPath}
        />

        <GoalSessionField
          editing={editing}
          listWorkspacePath={selectedProject.workspacePath}
          listWorkspaceIdentity={selectedProject.workspaceIdentity}
          hostMode={hostMode}
          sessionId={existingSessionId}
          onHostModeChange={setHostMode}
          onSessionIdChange={setExistingSessionId}
        />

        <p className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage({ id: "goals.form.deadlineNotice" })}
        </p>

        <div className="flex items-center gap-3">
          <Button type="submit" data-start="false" disabled={!canSave}>
            {intl.formatMessage({ id: "goals.form.save" })}
          </Button>
          <Button type="submit" data-start="true" disabled={!canSaveAndRun}>
            {intl.formatMessage({ id: "goals.form.saveAndRun" })}
          </Button>
          <Button type="button" variant="outline" onClick={onBack}>
            {intl.formatMessage({ id: "goals.form.cancel" })}
          </Button>
        </div>
      </form>
    </div>
  );
}
