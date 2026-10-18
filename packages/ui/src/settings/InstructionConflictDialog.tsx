import { Button } from "@/components/ui/button.js";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 保存冲突的阻塞式确认：磁盘已被外部修改，必须由用户裁决。
 *
 * 用 AlertDialog 拿到焦点陷阱、Esc 取消与「点遮罩不关闭」语义（AlertDialog 不允许
 * 点击外部关闭，避免误关后用户以为改动已处理）。三个分支都是显式按钮，不用
 * AlertDialogAction / Cancel 的自动关闭，保证「覆盖 / 放弃 / 取消」各自走自己的异步流程。
 */
export function InstructionConflictDialog({
  open,
  busy,
  onOverwrite,
  onDiscard,
  onCancel,
}: {
  open: boolean;
  busy: boolean;
  onOverwrite: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}) {
  const { intl } = useZCodeIntl();
  return (
    <AlertDialog open={open} onOpenChange={(nextOpen) => (!nextOpen ? onCancel() : undefined)}>
      <AlertDialogContent data-testid="instructions-conflict-dialog">
        <AlertDialogHeader className="gap-2">
          <AlertDialogTitle>
            {intl.formatMessage({ id: "settings.instructions.conflict.title" })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {intl.formatMessage({ id: "settings.instructions.conflict.description" })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter className="gap-2 sm:justify-end">
          <Button variant="outline" size="lg" disabled={busy} onClick={onCancel}>
            {intl.formatMessage({ id: "settings.instructions.conflict.cancel" })}
          </Button>
          <Button variant="outline" size="lg" disabled={busy} onClick={onDiscard}>
            {intl.formatMessage({ id: "settings.instructions.conflict.discard" })}
          </Button>
          <Button variant="default" size="lg" disabled={busy} onClick={onOverwrite}>
            {intl.formatMessage({ id: "settings.instructions.conflict.overwrite" })}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
