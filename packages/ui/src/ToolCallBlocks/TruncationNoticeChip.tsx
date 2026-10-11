import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip.js";
import type { TruncationNotice } from "./truncationNotice.js";

/**
 * 截断种类徽标：中性色弱元数据（DESIGN.md 规定语义色只留给真正的语义状态），
 * 视觉与 sourceLabel chip 一致；hover 给一句话细节。
 * key 缺失时 tooltip 回退为徽标短文案本身，不渲染空提示。
 */
export function TruncationNoticeChip({ notice }: { notice: TruncationNotice }) {
  const { intl } = useZCodeIntl();
  const label = intl.formatMessage({ id: `chat.toolCall.notice.${notice.kind}.label` });
  // resultsTruncated 的带数值文案只在解析到 limit 时使用，否则占位符 {limit} 会原样露出。
  const tooltipId =
    notice.kind === "resultsTruncated"
      ? notice.limit !== undefined
        ? "chat.toolCall.notice.resultsTruncated.tooltip"
        : "chat.toolCall.notice.resultsTruncated.tooltipGeneric"
      : `chat.toolCall.notice.${notice.kind}.tooltip`;
  const tooltipRaw = intl.formatMessage(
    { id: tooltipId },
    notice.limit !== undefined ? { limit: notice.limit } : undefined,
  );
  const tooltip = tooltipRaw === tooltipId ? label : tooltipRaw;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="shrink-0 cursor-help rounded border border-border bg-background-alt px-1.5 py-0.5 text-ui-xs leading-none text-foreground-subtlest">
            {label}
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-96">
          <span className="line-clamp-3 min-w-0 whitespace-pre-wrap break-words">{tooltip}</span>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
