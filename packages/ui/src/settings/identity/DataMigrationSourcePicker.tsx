import { Loader2, RefreshCcw } from "lucide-react";
import type { MigrationSourceRoot } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/**
 * 来源数据根选择行：
 * - 0 个候选：虚线空态 + 重新检测（本机没有另一个身份数据根）；
 * - 1 个候选：静态展示，不做无意义的单选项下拉；
 * - 多个候选：下拉，每项两行显示 label 与绝对路径。
 */
export function DataMigrationSourcePicker({
  sources,
  selectedSourceRootPath,
  isScanning,
  isRunning,
  onSelect,
  onRediscover,
}: {
  sources: MigrationSourceRoot[];
  selectedSourceRootPath: string | null;
  isScanning: boolean;
  isRunning: boolean;
  onSelect: (sourceRootPath: string) => void;
  onRediscover: () => void;
}) {
  const { intl } = useZCodeIntl();
  const selectedSource =
    sources.find((source) => source.rootPath === selectedSourceRootPath) ?? null;

  return (
    <div className="space-y-2">
      <div className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "settings.migration.zcode.sourceLabel" })}
      </div>

      {isScanning && sources.length === 0 ? (
        <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
          <Loader2 className="size-3.5 animate-spin" />
          {intl.formatMessage({ id: "settings.migration.zcode.scanning" })}
        </div>
      ) : null}

      {!isScanning && sources.length === 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-dashed border-border px-3 py-2.5">
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "settings.migration.zcode.emptySource" })}
          </span>
          <Button type="button" size="sm" variant="outline" onClick={onRediscover}>
            <RefreshCcw className="size-3.5" />
            {intl.formatMessage({ id: "settings.migration.zcode.rediscover" })}
          </Button>
        </div>
      ) : null}

      {sources.length === 1 && selectedSource ? (
        <div className="rounded-lg border border-border bg-background px-3 py-2.5">
          <div className="text-ui-base text-foreground">{selectedSource.label}</div>
          <div className="font-mono text-ui-xs break-all text-foreground-subtle">
            {selectedSource.rootPath}
          </div>
        </div>
      ) : null}

      {sources.length > 1 && selectedSourceRootPath ? (
        <Select
          value={selectedSourceRootPath}
          disabled={isRunning || isScanning}
          onValueChange={onSelect}
        >
          <SelectTrigger size="lg" className="h-auto min-h-8 w-full justify-between py-1.5">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {sources.map((source) => (
              <SelectItem key={source.rootPath} value={source.rootPath}>
                <span className="flex min-w-0 flex-col items-start">
                  <span className="truncate">{source.label}</span>
                  <span className="max-w-full truncate font-mono text-ui-xs text-foreground-subtle">
                    {source.rootPath}
                  </span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
