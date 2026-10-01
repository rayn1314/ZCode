import { lazy, useEffect, useMemo, useState } from "react";
import type { LedgerSource } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useLedgerStats } from "@/hooks/useLedgerStats.js";
import type { LedgerSnapshotRequest } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { UsageChartLoadBoundary } from "@/settings/usage-stats/UsageChartLoadBoundary.js";
import { UsageStatsErrorNotice } from "@/settings/usage-stats/UsageStatsErrorNotice.js";
import { UsageEmptyState } from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  loadLedgerPrefs,
  saveLedgerPrefs,
  type LedgerDailyMetric,
  type LedgerDonutMetric,
  type LedgerPrefs,
} from "./ledgerPrefs.js";
import { formatLedgerClock, formatLedgerDuration } from "./ledgerFormat.js";
import { LedgerToolbar } from "./LedgerToolbar.js";
import { LedgerFixedKpiStrip, LedgerHourlyStrip, LedgerKpiCards } from "./LedgerKpiCards.js";
import { LedgerSessionsTable, LedgerRecentTable, LedgerErrorSummary } from "./LedgerTables.js";

// Recharts 初始化会在 Linux 容器阻断 renderer 启动（与 App Usage 相同的按需加载边界）。
const LedgerTrendChart = lazy(() =>
  import("./LedgerTrendChart.js").then((m) => ({ default: m.LedgerTrendChart })),
);
const LedgerModelDonutChart = lazy(() =>
  import("./LedgerModelDonutChart.js").then((m) => ({ default: m.LedgerModelDonutChart })),
);
const LedgerAgentBarChart = lazy(() =>
  import("./LedgerAgentBarChart.js").then((m) => ({ default: m.LedgerAgentBarChart })),
);

export function LedgerPanel() {
  const { intl, locale } = useZCodeIntl();
  const [prefs, setPrefs] = useState<LedgerPrefs>(loadLedgerPrefs);
  const [nowTick, setNowTick] = useState(() => Date.now());

  const update = (patch: Partial<LedgerPrefs>) => {
    setPrefs((current) => ({ ...current, ...patch }));
    saveLedgerPrefs(patch);
  };

  const request = useMemo<LedgerSnapshotRequest>(
    () => ({
      range: prefs.range,
      customStart: prefs.range === "custom" ? prefs.customStart || null : null,
      customEnd: prefs.range === "custom" ? prefs.customEnd || null : null,
      providerLabel: prefs.providerLabel || null,
      modelId: prefs.modelId || null,
      sourceKeys: prefs.sourceKeys && prefs.sourceKeys.length > 0 ? prefs.sourceKeys : null,
    }),
    [
      prefs.range,
      prefs.customStart,
      prefs.customEnd,
      prefs.providerLabel,
      prefs.modelId,
      prefs.sourceKeys,
    ],
  );

  const { snapshot, loading, error, unavailable, refresh, syncPrices } = useLedgerStats(request);

  // 价格基准手动同步：按钮 → 服务拉 models.dev 写同步层 → 刷新快照用新价。
  const [priceSyncState, setPriceSyncState] = useState<"idle" | "syncing" | "success" | "error">(
    "idle",
  );
  const [priceSyncError, setPriceSyncError] = useState<string | null>(null);
  const handleSyncPrices = () => {
    if (priceSyncState === "syncing") {
      return;
    }
    setPriceSyncState("syncing");
    setPriceSyncError(null);
    void syncPrices().then((result) => {
      if (!result) {
        setPriceSyncState("error");
        setPriceSyncError(intl.formatMessage({ id: "settings.usage.ledger.unavailableTitle" }));
        return;
      }
      if (result.ok) {
        setPriceSyncState("success");
        void refresh();
        // 成功态短暂展示后回到普通按钮；失败态保留到下次操作，让用户能读到原因
        window.setTimeout(
          () => setPriceSyncState((current) => (current === "success" ? "idle" : current)),
          3_000,
        );
      } else {
        setPriceSyncState("error");
        setPriceSyncError(result.error ?? null);
      }
    });
  };

  // 自动刷新：仅页面可见时轮询，切回可见立即刷新一次
  useEffect(() => {
    const intervalMs = prefs.refreshIntervalMs;
    if (!intervalMs) {
      return;
    }
    const tick = () => {
      if (document.visibilityState === "visible") {
        setNowTick(Date.now());
        void refresh();
      }
    };
    const timer = window.setInterval(tick, intervalMs);
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        tick();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [prefs.refreshIntervalMs, refresh]);

  const sources = snapshot?.sources ?? [];
  const availableSources = sources.filter((s) => s.ok);
  const selectedKeys = prefs.sourceKeys;
  const includedCount = sources.filter(
    (s) => s.ok && (!selectedKeys || selectedKeys.includes(s.key)),
  ).length;

  const sourceButtonLabel = useMemo(() => {
    if (!selectedKeys) {
      return intl.formatMessage({ id: "settings.usage.ledger.sourceAll" });
    }
    if (selectedKeys.length === 0 || includedCount === 0) {
      return intl.formatMessage({ id: "settings.usage.ledger.sourceNone" });
    }
    if (availableSources.length > 0 && selectedKeys.length === availableSources.length) {
      return intl.formatMessage({ id: "settings.usage.ledger.sourceAll" });
    }
    return intl.formatMessage(
      { id: "settings.usage.ledger.sourceCount" },
      { count: includedCount },
    );
  }, [intl, selectedKeys, includedCount, availableSources.length]);

  const toggleSource = (key: string) => {
    const base = selectedKeys ?? availableSources.map((s) => s.key);
    const next = base.includes(key) ? base.filter((k) => k !== key) : [...base, key];
    // 回到全选时存 null，让以后新增的数据源自动纳入
    const isAll =
      availableSources.length > 0 && availableSources.every((s) => next.includes(s.key));
    update({
      sourceKeys: isAll ? null : next.filter((k) => availableSources.some((s) => s.key === k)),
    });
  };

  const selectSourceGroup = (variant: LedgerSource["variant"] | "all") => {
    if (variant === "all") {
      update({ sourceKeys: null });
      return;
    }
    update({ sourceKeys: availableSources.filter((s) => s.variant === variant).map((s) => s.key) });
  };

  const currency = snapshot?.priceMeta?.currency === "CNY" ? "CNY" : "USD";
  const customRangeInvalid = prefs.range === "custom" && (!prefs.customStart || !prefs.customEnd);

  if (unavailable) {
    return (
      <UsageEmptyState
        title={intl.formatMessage({ id: "settings.usage.ledger.unavailableTitle" })}
        description={intl.formatMessage({ id: "settings.usage.ledger.unavailableDescription" })}
      />
    );
  }

  if (loading && !snapshot) {
    return (
      <div className="space-y-5">
        <LedgerToolbar
          prefs={prefs}
          snapshot={null}
          onPrefs={update}
          onRefresh={() => {}}
          sourceButtonLabel={sourceButtonLabel}
          toggleSource={toggleSource}
          selectSourceGroup={selectSourceGroup}
        />
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
          description={intl.formatMessage({ id: "settings.usage.ledger.loadingDescription" })}
        />
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="space-y-5">
        <LedgerToolbar
          prefs={prefs}
          snapshot={null}
          onPrefs={update}
          onRefresh={() => {
            void refresh();
          }}
          sourceButtonLabel={sourceButtonLabel}
          toggleSource={toggleSource}
          selectSourceGroup={selectSourceGroup}
        />
        {error ? <UsageStatsErrorNotice error={error} /> : null}
        <UsageEmptyState
          title={intl.formatMessage({ id: "settings.usage.emptyTitle" })}
          description={intl.formatMessage({ id: "settings.usage.ledger.emptyDescription" })}
        />
      </div>
    );
  }

  const overview = snapshot.overview;
  const units = {
    second: intl.formatMessage({ id: "settings.usage.ledger.unit.second" }),
    minute: intl.formatMessage({ id: "settings.usage.duration.minute" }),
    hour: intl.formatMessage({ id: "settings.usage.duration.hour" }),
  };
  const unpricedCalls = overview.unpricedCalls ?? 0;

  return (
    <div className="space-y-5">
      <LedgerToolbar
        prefs={prefs}
        snapshot={snapshot}
        onPrefs={update}
        onRefresh={() => {
          void refresh();
          setNowTick(Date.now());
        }}
        sourceButtonLabel={sourceButtonLabel}
        toggleSource={toggleSource}
        selectSourceGroup={selectSourceGroup}
        customRangeInvalid={customRangeInvalid}
      />

      {error ? <UsageStatsErrorNotice error={error} /> : null}
      {sources.some((s) => !s.ok) ? (
        <div className="rounded-lg bg-surface px-4 py-2 text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.usage.ledger.unavailableSources" },
            {
              names: sources
                .filter((s) => !s.ok)
                .map((s) => s.label)
                .join("、"),
            },
          )}
        </div>
      ) : null}

      <LedgerKpiCards
        overview={overview}
        currency={currency}
        locale={locale}
        formatDuration={(ms) => formatLedgerDuration(locale, ms, units)}
      />

      <LedgerFixedKpiStrip snapshot={snapshot} locale={locale} currency={currency} />

      <LedgerHourlyStrip snapshot={snapshot} />

      <UsageChartLoadBoundary
        scope="settings.usage.ledger-trend"
        resetKeys={[snapshot.generatedAt, prefs.dailyMetric]}
        loadingDescription={intl.formatMessage({ id: "settings.usage.ledger.loadingDescription" })}
      >
        <LedgerTrendChart
          snapshot={snapshot}
          metric={prefs.dailyMetric}
          onMetricChange={(metric: LedgerDailyMetric) => update({ dailyMetric: metric })}
        />
      </UsageChartLoadBoundary>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <UsageChartLoadBoundary
          scope="settings.usage.ledger-donut"
          resetKeys={[snapshot.generatedAt, prefs.donutMetric]}
          loadingDescription={intl.formatMessage({
            id: "settings.usage.ledger.loadingDescription",
          })}
        >
          <LedgerModelDonutChart
            snapshot={snapshot}
            metric={prefs.donutMetric}
            onMetricChange={(metric: LedgerDonutMetric) => update({ donutMetric: metric })}
          />
        </UsageChartLoadBoundary>
        <UsageChartLoadBoundary
          scope="settings.usage.ledger-agents"
          resetKeys={[snapshot.generatedAt]}
          loadingDescription={intl.formatMessage({
            id: "settings.usage.ledger.loadingDescription",
          })}
        >
          <LedgerAgentBarChart snapshot={snapshot} currency={currency} />
        </UsageChartLoadBoundary>
      </div>

      <LedgerSessionsTable
        snapshot={snapshot}
        locale={locale}
        currency={currency}
        nowTick={nowTick}
      />
      <LedgerErrorSummary snapshot={snapshot} />
      <LedgerRecentTable snapshot={snapshot} locale={locale} currency={currency} />

      <div className="flex flex-wrap items-center justify-between gap-2 text-ui-sm text-foreground-subtle">
        <span title={sources.map((s) => `${s.label} · ${s.rootPath}`).join("\n")}>
          {intl.formatMessage(
            { id: "settings.usage.ledger.footerSources" },
            { count: availableSources.length },
          )}
        </span>
        <span className="flex items-center gap-1.5">
          {intl.formatMessage(
            { id: "settings.usage.ledger.footerPriceBaseline" },
            { date: snapshot.priceMeta?.date ?? "—" },
          )}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            disabled={priceSyncState === "syncing"}
            onClick={handleSyncPrices}
          >
            {priceSyncState === "syncing"
              ? intl.formatMessage({ id: "settings.usage.ledger.pricesSync.syncing" })
              : priceSyncState === "success"
                ? intl.formatMessage({ id: "settings.usage.ledger.pricesSync.success" })
                : intl.formatMessage({ id: "settings.usage.ledger.pricesSync.button" })}
          </Button>
          {priceSyncState === "error" ? (
            <span className="text-destructive" title={priceSyncError ?? undefined}>
              {intl.formatMessage({ id: "settings.usage.ledger.pricesSync.failed" })}
            </span>
          ) : null}
        </span>
        <span>
          {intl.formatMessage(
            { id: "settings.usage.ledger.footerRefreshedAt" },
            { time: formatLedgerClock(locale, snapshot.generatedAt) },
          )}
        </span>
      </div>
      {loading ? (
        <div
          className="h-0.5 overflow-hidden rounded-full bg-border"
          role="status"
          aria-label={intl.formatMessage({ id: "settings.usage.loadingTitle" })}
        >
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary/60" />
        </div>
      ) : null}
      {unpricedCalls > 0 ? (
        <div className="text-ui-sm text-foreground-subtle">
          {intl.formatMessage(
            { id: "settings.usage.ledger.unpricedNotice" },
            { count: unpricedCalls },
          )}
        </div>
      ) : null}
    </div>
  );
}
