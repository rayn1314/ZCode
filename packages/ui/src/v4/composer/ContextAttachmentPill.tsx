import type { HTMLAttributes, ReactNode } from "react";
import { XIcon } from "lucide-react";
import {
  AttachmentHoverCard,
  AttachmentHoverCardContent,
  AttachmentHoverCardTrigger,
  type AttachmentHoverCardContentProps,
} from "@/components/ai-elements/attachments.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";

/**
 * 删除入口与它的文案成对出现：删除按钮的 aria-label 必须说清删的是什么，
 * 退回 pill 标题会让屏读用户听到「删掉 3 条代码评论」这种并不存在的动作。
 * 只读 pill（如会话消息信封）没有删除入口，因此两者一起缺席。
 */
type ContextAttachmentPillProps = {
  children: ReactNode;
  contentAlign?: AttachmentHoverCardContentProps["align"];
  icon: ReactNode;
  label: string;
  triggerProps?: Omit<HTMLAttributes<HTMLDivElement>, "children"> &
    Partial<Record<`data-${string}`, string | number>>;
} & ({ onRemoveAll: () => void; removeLabel: string } | { onRemoveAll?: never });

/**
 * 上下文附件共享同一个 pill 与详情浮层外壳，避免各类型复制布局和交互样式。
 * Trigger 使用 asChild，详情使用 Portal，因此消息附件容器中只留下一个 pill 节点。
 */
export function ContextAttachmentPill(props: ContextAttachmentPillProps) {
  const { children, contentAlign = "start", icon, label, triggerProps } = props;
  // 不直接解构 onRemoveAll：留住 props 的联合类型，删除文案才能被收窄成 string。
  const removeAll = props.onRemoveAll
    ? { label: props.removeLabel, run: props.onRemoveAll }
    : undefined;
  return (
    <AttachmentHoverCard>
      <AttachmentHoverCardTrigger asChild>
        <div
          {...triggerProps}
          aria-label={label}
          className={cn(
            "group flex h-8 max-w-full cursor-pointer select-none items-center gap-1.5 rounded-full border-0 bg-surface py-1.5 text-ui-base font-medium text-foreground transition-all hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
            // 输入框与对话流共用该外壳，但只有输入框存在关闭按钮。
            // 无条件压缩右 padding 会让对话流 pill 视觉上偏右，因此按删除入口分流间距。
            removeAll ? "pl-3 pr-1.5" : "px-3",
          )}
          role="button"
          tabIndex={0}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {icon}
            <span className="truncate">{label}</span>
          </span>
          {removeAll ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="size-5 shrink-0 rounded-full text-foreground-subtle opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100"
              aria-label={removeAll.label}
              title={removeAll.label}
              onClick={(event) => {
                event.stopPropagation();
                removeAll.run();
              }}
            >
              <XIcon className="size-3.5" />
            </Button>
          ) : null}
        </div>
      </AttachmentHoverCardTrigger>
      <AttachmentHoverCardContent
        align={contentAlign}
        side="top"
        className="w-80 rounded-xl border border-border bg-tooltip p-1 text-tooltip-foreground shadow-md ring-0"
      >
        <div className="max-h-64 overflow-y-auto">{children}</div>
      </AttachmentHoverCardContent>
    </AttachmentHoverCard>
  );
}
