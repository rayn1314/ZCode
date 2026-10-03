import { useState } from "react";
import { CheckCircle2, ChevronRight, Circle, Loader2, TriangleAlert, XCircle } from "lucide-react";
import type { MigrationDomainResult, MigrationDomainSummary } from "@zcode/services";
import { Badge } from "@/components/ui/badge.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import type { IdentityMigrationDomainStatus } from "@/hooks/useIdentityDataMigration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { formatBytes } from "@/settings/identity/formatBytes.js";

function DomainStatusIcon({ status }: { status?: IdentityMigrationDomainStatus }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 shrink-0 animate-spin text-foreground-subtle" />;
    case "done":
      return <CheckCircle2 className="size-4 shrink-0 text-success" />;
    case "failed":
      return <XCircle className="size-4 shrink-0 text-destructive" />;
    default:
      return <Circle className="size-4 shrink-0 text-foreground-subtlest" />;
  }
}

export function DataMigrationDomainRow({
  domain,
  checked,
  runStatus,
  result,
  showRunStatus,
  interactionsDisabled,
  onToggle,
}: {
  domain: MigrationDomainSummary;
  checked: boolean;
  runStatus?: IdentityMigrationDomainStatus;
  result?: MigrationDomainResult;
  showRunStatus: boolean;
  interactionsDisabled: boolean;
  onToggle: () => void;
}) {
  const { intl } = useZCodeIntl();
  const [detailsOpen, setDetailsOpen] = useState(false);

  const title = intl.formatMessage({ id: `settings.migration.zcode.domain.${domain.id}.title` });
  // note 由服务端按实际数据给出（例如来源文件损坏），优先级高于固定策略句。
  const policy =
    domain.note ??
    intl.formatMessage({ id: `settings.migration.zcode.domain.${domain.id}.policy` });
  const isUnavailable = !domain.available;

  return (
    <div className={cn("px-3 py-2.5", isUnavailable && "opacity-50")}>
      <div className="flex items-start gap-2.5">
        <div className="flex h-6 items-center">
          {showRunStatus ? (
            <DomainStatusIcon status={runStatus} />
          ) : (
            <Checkbox
              checked={checked}
              disabled={isUnavailable || interactionsDisabled}
              onCheckedChange={onToggle}
              aria-label={title}
            />
          )}
        </div>

        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="text-ui-base font-medium text-foreground">{title}</span>
            {domain.conflictCount > 0 ? (
              <Badge variant="secondary">
                {intl.formatMessage(
                  {
                    id:
                      domain.id === "appSettings"
                        ? "settings.migration.zcode.conflict.overwrite"
                        : "settings.migration.zcode.conflict.skip",
                  },
                  { count: domain.conflictCount },
                )}
              </Badge>
            ) : null}
          </div>
          <div className="text-ui-base/relaxed text-foreground-subtle">
            {isUnavailable
              ? (domain.skipReason ??
                intl.formatMessage({ id: "settings.migration.zcode.skipReason" }))
              : policy}
          </div>
          {domain.id === "sessions" ? (
            <div className="flex items-start gap-1 text-ui-xs text-warning">
              <TriangleAlert className="mt-0.5 size-3 shrink-0" />
              <span>{intl.formatMessage({ id: "settings.migration.zcode.sessionsWarning" })}</span>
            </div>
          ) : null}
        </div>

        <div className="flex h-6 shrink-0 items-center gap-2 text-ui-base text-foreground-subtle">
          <span className="font-mono">{formatBytes(domain.bytes)}</span>
          <span>
            {intl.formatMessage(
              { id: "settings.migration.zcode.itemCount" },
              { count: domain.itemCount },
            )}
          </span>
        </div>
      </div>

      {result ? (
        <Collapsible open={detailsOpen} onOpenChange={setDetailsOpen} className="mt-1.5 pl-6.5">
          <CollapsibleTrigger className="flex items-center gap-1 rounded-md text-ui-xs text-foreground-subtle transition-colors hover:text-foreground">
            <ChevronRight
              className={cn("size-3 shrink-0 transition-transform", detailsOpen && "rotate-90")}
            />
            <span>
              {intl.formatMessage(
                { id: "settings.migration.zcode.domainResult" },
                { imported: result.imported, skipped: result.skipped, failed: result.failed },
              )}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="pt-1.5">
            {result.details.length > 0 ? (
              <div className="space-y-0.5 font-mono text-ui-xs break-all text-foreground-subtle">
                {result.details.map((detail, index) => (
                  <div key={`${index}:${detail}`}>{detail}</div>
                ))}
              </div>
            ) : (
              <div className="text-ui-xs text-foreground-subtle">
                {intl.formatMessage({ id: "settings.migration.zcode.noDetails" })}
              </div>
            )}
            {result.error ? (
              <div className="mt-1 font-mono text-ui-xs break-all text-destructive">
                {result.error}
              </div>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}
