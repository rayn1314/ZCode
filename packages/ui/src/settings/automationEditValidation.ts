/**
 * 自动化（任务）表单必填字段校验。
 * 纯模板（无 cron 调度）是合法形态：空 cron 只影响「定时」标签，不再要求必填 schedule。
 */
export type AutomationEditRequiredField = "title" | "prompt";

export function resolveAutomationEditRequiredFieldErrors(params: {
  title: string;
  prompt: string;
}): AutomationEditRequiredField[] {
  const errors: AutomationEditRequiredField[] = [];
  if (!params.title.trim()) errors.push("title");
  if (!params.prompt.trim()) errors.push("prompt");
  return errors;
}

/** 正常编辑只撤销当前字段已有的提交告警，不主动产生新的告警。 */
export function clearAutomationEditRequiredFieldError(
  errors: ReadonlySet<AutomationEditRequiredField>,
  field: AutomationEditRequiredField,
): ReadonlySet<AutomationEditRequiredField> {
  if (!errors.has(field)) return errors;
  const next = new Set(errors);
  next.delete(field);
  return next;
}
