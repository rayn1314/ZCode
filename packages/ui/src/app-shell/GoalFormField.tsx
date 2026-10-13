import type { ReactNode } from "react";

/** 表单字段外壳：label + 内容 + error（优先）/hint。供任务与自动化表单共用。 */
export function Field({
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
