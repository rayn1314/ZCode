import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { LEDGER_PAGE_SIZE_OPTIONS } from "./ledgerPrefs.js";

// 明细表统一分页条：左侧区间摘要，右侧每页条数 + 上/下一页。
// 数据池上限由服务端 merge 截断决定（500 条），页大小选项不超池子。

export function LedgerTablePagination({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  total: number;
  page: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);

  return (
    <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-ui-sm text-foreground-subtle">
      <span>
        {intl.formatMessage({ id: "settings.usage.ledger.pagination.range" }, { from, to, total })}
      </span>
      <div className="flex items-center gap-2">
        <Select value={String(pageSize)} onValueChange={(value) => onPageSize(Number(value))}>
          <SelectTrigger className="h-8 w-auto gap-1 text-ui-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEDGER_PAGE_SIZE_OPTIONS.map((size) => (
              <SelectItem key={size} value={String(size)}>
                {intl.formatMessage(
                  { id: "settings.usage.ledger.pagination.pageSize" },
                  { count: size },
                )}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={current <= 1}
          onClick={() => onPage(current - 1)}
        >
          <ChevronLeft className="size-3.5" />
          {intl.formatMessage({ id: "settings.usage.ledger.pagination.prev" })}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={current >= pageCount}
          onClick={() => onPage(current + 1)}
        >
          {intl.formatMessage({ id: "settings.usage.ledger.pagination.next" })}
          <ChevronRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}
