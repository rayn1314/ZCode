import { useMemo, useEffect } from "react";
import { ArrowRightLeft, CheckCircle2, Loader2, RefreshCcw, TriangleAlert } from "lucide-react";
import type { MigrationDomainId, MigrationDomainResult } from "@zcode/services";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import { toast } from "@/components/ui/toast.js";
import { useIdentityDataMigration } from "@/hooks/useIdentityDataMigration.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { DataMigrationDomainRow } from "@/settings/identity/DataMigrationDomainRow.js";
import { DataMigrationNotMigratable } from "@/settings/identity/DataMigrationNotMigratable.js";
import { DataMigrationSourcePicker } from "@/settings/identity/DataMigrationSourcePicker.js";

const MIGRATION_TOAST_DEDUPE_KEY = "identity-data-migration-result";

/**
 * 设置页「数据迁移」中的身份数据迁移面板。
 * 只做展示与事件转发，异步编排与状态机在 useIdentityDataMigration 里。
 */
export function DataMigrationPanel() {
  const { intl } = useZCodeIntl();
  const {
    supported,
    phase,
    sources,
    selectedSourceRootPath,
    scanResult,
    error,
    selectedDomainIds,
    domainStatuses,
    results,
    selectSource,
    toggleDomain,
    selectAllDomains,
    clearDomains,
    startMigration,
    rescan,
    rediscover,
  } = useIdentityDataMigration();

  const selectedSet = useMemo(() => new Set(selectedDomainIds), [selectedDomainIds]);
  const resultByDomain = useMemo(() => {
    const map = new Map<MigrationDomainId, MigrationDomainResult>();
    for (const result of results) {
      map.set(result.id, result);
    }
    return map;
  }, [results]);
  const totals = useMemo(
    () =>
      results.reduce(
        (accumulator, result) => ({
          imported: accumulator.imported + result.imported,
          skipped: accumulator.skipped + result.skipped,
          failed: accumulator.failed + result.failed,
        }),
        { imported: 0, skipped: 0, failed: 0 },
      ),
    [results],
  );

  const isRunning = phase === "running";
  const isScanning = phase === "scanning";
  // 运行中与完成后都用状态图标替掉勾选框：前者表达进度，后者表达结果。
  const showRunStatus = isRunning || phase === "done";
  const hasSource = sources.length > 0;

  useEffect(() => {
    if (phase !== "done") {
      return;
    }
    const hasFailures = totals.failed > 0;
    toast(
      intl.formatMessage(
        {
          id: hasFailures
            ? "settings.migration.zcode.toastFailed"
            : "settings.migration.zcode.toastSuccess",
        },
        { imported: totals.imported, skipped: totals.skipped, failed: totals.failed },
      ),
      {
        variant: hasFailures ? "warning" : "info",
        durationMs: 5000,
        position: "bottom-left",
        dedupeKey: MIGRATION_TOAST_DEDUPE_KEY,
      },
    );
  }, [intl, phase, totals]);

  if (!supported) {
    return (
      <Card className="border border-border bg-card py-0 shadow-none">
        <CardHeader className="border-b border-border">
          <div className="space-y-1">
            <CardTitle>{intl.formatMessage({ id: "settings.migration.zcode.title" })}</CardTitle>
            <CardDescription>
              {intl.formatMessage({ id: "settings.migration.zcode.description" })}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="px-4 py-4">
          <Alert>
            <TriangleAlert className="size-4" />
            <AlertTitle>
              {intl.formatMessage({ id: "settings.migration.zcode.unsupportedTitle" })}
            </AlertTitle>
            <AlertDescription>
              {intl.formatMessage({ id: "settings.migration.zcode.unsupportedDescription" })}
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="border border-border bg-card py-0 shadow-none">
      <CardHeader className="border-b border-border">
        <div className="space-y-1">
          <CardTitle>{intl.formatMessage({ id: "settings.migration.zcode.title" })}</CardTitle>
          <CardDescription>
            {intl.formatMessage({ id: "settings.migration.zcode.description" })}
          </CardDescription>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-4 py-4">
        {phase === "done" ? (
          <Alert variant={totals.failed > 0 ? "destructive" : "default"}>
            {totals.failed > 0 ? (
              <TriangleAlert className="size-4" />
            ) : (
              <CheckCircle2 className="size-4" />
            )}
            <AlertTitle>
              {intl.formatMessage({
                id:
                  totals.failed > 0
                    ? "settings.migration.zcode.resultFailedTitle"
                    : "settings.migration.zcode.resultTitle",
              })}
            </AlertTitle>
            <AlertDescription>
              {intl.formatMessage(
                { id: "settings.migration.zcode.resultSummary" },
                { imported: totals.imported, skipped: totals.skipped, failed: totals.failed },
              )}
            </AlertDescription>
          </Alert>
        ) : null}

        {phase === "error" && error ? (
          <Alert variant="destructive">
            <TriangleAlert className="size-4" />
            <AlertTitle>
              {intl.formatMessage({ id: "settings.migration.zcode.scanFailedTitle" })}
            </AlertTitle>
            <AlertDescription>
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 break-all">{error}</span>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    // 报错来源可能是探测（无选中来源）或扫描某个来源，分别重试对应步骤。
                    if (selectedSourceRootPath) {
                      rescan();
                      return;
                    }
                    rediscover();
                  }}
                >
                  {intl.formatMessage({ id: "settings.migration.zcode.retry" })}
                </Button>
              </div>
            </AlertDescription>
          </Alert>
        ) : null}

        <DataMigrationSourcePicker
          sources={sources}
          selectedSourceRootPath={selectedSourceRootPath}
          isScanning={isScanning}
          isRunning={isRunning}
          onSelect={selectSource}
          onRediscover={rediscover}
        />

        {isScanning && hasSource ? (
          <div className="flex items-center gap-2 text-ui-base text-foreground-subtle">
            <Loader2 className="size-3.5 animate-spin" />
            {intl.formatMessage({ id: "settings.migration.zcode.scanning" })}
          </div>
        ) : null}

        {scanResult && !isScanning ? (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="text-ui-base font-medium text-foreground">
                  {intl.formatMessage({ id: "settings.migration.zcode.domainsTitle" })}
                </div>
                {!isRunning && phase !== "done" ? (
                  <div className="flex items-center gap-1">
                    <Button type="button" size="sm" variant="ghost" onClick={selectAllDomains}>
                      {intl.formatMessage({ id: "settings.migration.zcode.selectAll" })}
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={clearDomains}>
                      {intl.formatMessage({ id: "settings.migration.zcode.clearSelection" })}
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
                {scanResult.domains.map((domain) => (
                  <DataMigrationDomainRow
                    key={domain.id}
                    domain={domain}
                    checked={selectedSet.has(domain.id)}
                    runStatus={domainStatuses[domain.id]}
                    result={resultByDomain.get(domain.id)}
                    showRunStatus={showRunStatus}
                    interactionsDisabled={isRunning}
                    onToggle={() => toggleDomain(domain.id)}
                  />
                ))}
              </div>
            </div>

            <DataMigrationNotMigratable items={scanResult.notMigratable} />
          </>
        ) : null}

        {!isScanning && hasSource ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="lg"
              disabled={isRunning || !scanResult || selectedDomainIds.length === 0}
              onClick={() => {
                void startMigration();
              }}
            >
              {isRunning ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <ArrowRightLeft className="size-4" />
              )}
              {intl.formatMessage({ id: "settings.migration.zcode.start" })}
            </Button>
            <Button
              type="button"
              size="lg"
              variant="ghost"
              disabled={isRunning || isScanning}
              onClick={rescan}
            >
              <RefreshCcw className="size-4" />
              {intl.formatMessage({ id: "settings.migration.zcode.rescan" })}
            </Button>
            {isRunning ? (
              <span className="text-ui-base text-foreground-subtle">
                {intl.formatMessage(
                  { id: "settings.migration.zcode.progress" },
                  {
                    current: Math.min(results.length + 1, selectedDomainIds.length),
                    total: selectedDomainIds.length,
                  },
                )}
              </span>
            ) : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
