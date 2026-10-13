import { useMemo } from "react";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useAutomationProjectOptions } from "@/hooks/useAutomationProjectOptions.js";
import { workspaceLabelFromPath } from "./goalDisplay.js";
import { Field } from "./GoalFormField.js";

/** 目标任务项目：新建时可选（仅当前窗口已打开且可用的本地项目，含“无项目会话”）。 */
export interface GoalProjectSelection {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
}

/** 会话选择器的触发框高度：与仓库其它表单保持一致。 */
const SELECT_TRIGGER_CLASSNAME = "h-9";

/**
 * 目标任务项目选择器：仅新建时可改；编辑时锁定为目标所属项目（跨项目全局列表里
 * 条目可能不属于当前工作区），只读展示。
 */
export function GoalProjectField({
  editing,
  workspacePath,
  value,
  onValueChange,
}: {
  editing: ZCodeSessionGoalListEntry | null;
  workspacePath: string;
  /** 当前选中的项目路径（新建态受控值）。 */
  value: string;
  onValueChange: (path: string) => void;
}) {
  const { intl } = useZCodeIntl();

  // 候选 = 当前窗口已打开的可用本地项目（与自动化创建同源）；若当前工作区不在
  // 候选中（如远端 WSL tab），把当前工作区自身并入作为默认项（label 用 basename）。
  const localProjectOptions = useAutomationProjectOptions({
    includeConversationWorkspace: true,
  });
  const options = useMemo<GoalProjectSelection[]>(() => {
    const base = localProjectOptions.map((option) => ({
      workspacePath: option.workspacePath,
      label: option.label,
    }));
    const hasCurrent = base.some((candidate) => candidate.workspacePath === workspacePath);
    if (hasCurrent) return base;
    return [
      ...base,
      {
        workspacePath,
        label: workspaceLabelFromPath(workspacePath),
      },
    ];
  }, [localProjectOptions, workspacePath]);

  if (editing) {
    return (
      <Field
        label={intl.formatMessage({ id: "goals.form.project" })}
        hint={intl.formatMessage({ id: "goals.form.projectLockedHint" })}
      >
        <div className="text-ui-base leading-5 text-foreground-subtle">
          {workspaceLabelFromPath(editing.workspacePath)}
        </div>
      </Field>
    );
  }

  return (
    <Field label={intl.formatMessage({ id: "goals.form.project" })} htmlFor="goal-project">
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger
          id="goal-project"
          className={cn(SELECT_TRIGGER_CLASSNAME, "w-full max-w-md")}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.workspacePath} value={option.workspacePath}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}
