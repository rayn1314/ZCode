import { ChevronRight } from "lucide-react";
import type { MigrationScanResult } from "@zcode/services";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 「不迁移的内容」折叠说明：列表由服务端的 notMigratable 提供，界面不做任何硬编码，
 * 避免前后端各维护一份而漂移。
 */
export function DataMigrationNotMigratable({
  items,
}: {
  items: MigrationScanResult["notMigratable"];
}) {
  const { intl } = useZCodeIntl();

  if (items.length === 0) {
    return null;
  }

  return (
    <Collapsible className="rounded-lg border border-border">
      <CollapsibleTrigger asChild>
        <button
          type="button"
          /* data-state 由触发器自身承载，用 group/… 让箭头跟随展开态旋转。 */
          className="group/notMigratable flex w-full items-center gap-1.5 px-3 py-2 text-left text-ui-base text-foreground-subtle transition-colors hover:text-foreground"
        >
          <ChevronRight className="size-3.5 shrink-0 transition-transform group-data-[state=open]/notMigratable:rotate-90" />
          {intl.formatMessage({ id: "settings.migration.zcode.notMigratableTitle" })}
        </button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y divide-border border-t border-border">
          {items.map((item) => (
            <div key={item.id} className="space-y-0.5 px-3 py-2">
              <div className="text-ui-base text-foreground">{item.label}</div>
              <div className="text-ui-base/relaxed text-foreground-subtle">{item.reason}</div>
            </div>
          ))}
          {/* 用户看「不迁移的内容」时最容易把「Claude Code 会话迁移」也当成被排除项，
              其实它在同一设置节的下方单独提供，这里指一下位置。 */}
          <div className="px-3 py-2 text-ui-base/relaxed text-foreground-subtle">
            {intl.formatMessage({ id: "settings.migration.zcode.notMigratableClaudeHint" })}
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
