import { useEffect, useState } from "react";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { parseDateTimeLocalValue, toDateTimeLocalValue } from "./GoalEditView.js";

/**
 * 「恢复已截止目标」小表单：服务端要求恢复 attempt 必须带新截止时间（或显式 null 表示不再设截止），
 * 否则会拒绝并回传提示。默认给一个「一小时之后」的可用值，避免用户直接继承过期时间。
 */
export function GoalResumeDialog({
  entry,
  busy,
  onCancel,
  onConfirm,
}: {
  entry: ZCodeSessionGoalListEntry | null;
  busy: boolean;
  onCancel: () => void;
  onConfirm: (endAtMs: number | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [value, setValue] = useState("");

  useEffect(() => {
    if (!entry) return;
    const existing = entry.goal.endAtMs;
    const seed =
      existing != null && existing > Date.now() ? existing : Date.now() + 60 * 60 * 1_000;
    setValue(toDateTimeLocalValue(seed));
  }, [entry]);

  const parsed = parseDateTimeLocalValue(value);
  const invalid = value !== "" && (parsed === null || parsed <= Date.now());

  return (
    <Dialog
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "goals.resume.title" })}</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <p className="text-ui-sm text-foreground-subtle">
            {intl.formatMessage({ id: "goals.resume.description" })}
          </p>
          <Input
            type="datetime-local"
            value={value}
            aria-invalid={invalid}
            aria-label={intl.formatMessage({ id: "goals.form.deadline" })}
            onChange={(event) => setValue(event.target.value)}
          />
          {invalid ? (
            <p className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "goals.form.deadlineMustBeFuture" })}
            </p>
          ) : null}
        </div>
        <DialogFooter className="gap-3">
          <Button type="button" variant="outline" disabled={busy} onClick={() => onConfirm(null)}>
            {intl.formatMessage({ id: "goals.resume.clearDeadline" })}
          </Button>
          <Button
            type="button"
            disabled={busy || invalid || value === ""}
            onClick={() => onConfirm(parsed)}
          >
            {intl.formatMessage({ id: "goals.resume.confirm" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
