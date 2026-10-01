import { RefreshCcw, ChevronDown } from "lucide-react";
import type { LedgerRange, LedgerSnapshot, LedgerSource } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  USAGE_STATS_TABS_LIST_CLASS,
  USAGE_STATS_TABS_TRIGGER_CLASS,
  formatCompactNumber,
} from "@/settings/usage-stats/usageStatsUiParts.js";
import {
  LEDGER_RANGES_UI,
  LEDGER_REFRESH_OPTIONS,
  todayLocalDateString,
  type LedgerPrefs,
} from "./ledgerPrefs.js";

const RANGE_LABEL_IDS: Record<LedgerRange, string> = {
  today: "settings.usage.ledger.range.today",
  "7d": "settings.usage.range.7d",
  "30d": "settings.usage.range.30d",
  custom: "settings.usage.ledger.range.custom",
  all: "settings.usage.range.all",
};

function sourceGroupLabelId(variant: LedgerSource["variant"]): string {
  return variant === "self"
    ? "settings.usage.ledger.sourceGroup.self"
    : "settings.usage.ledger.sourceGroup.official";
}

export interface LedgerToolbarProps {
  prefs: LedgerPrefs;
  snapshot: LedgerSnapshot | null;
  onPrefs: (patch: Partial<LedgerPrefs>) => void;
  onRefresh: () => void;
  sourceButtonLabel: string;
  toggleSource: (key: string) => void;
  selectSourceGroup: (variant: LedgerSource["variant"] | "all") => void;
  customRangeInvalid?: boolean;
}

export function LedgerToolbar({
  prefs,
  snapshot,
  onPrefs,
  onRefresh,
  sourceButtonLabel,
  toggleSource,
  selectSourceGroup,
  customRangeInvalid,
}: LedgerToolbarProps) {
  const { intl, locale } = useZCodeIntl();
  const providers = snapshot?.facets.providers ?? [];
  const models = snapshot?.facets.models ?? [];
  const sources = snapshot?.sources ?? [];
  const availableSources = sources.filter((s) => s.ok);
  const groups: LedgerSource["variant"][] = ["official", "self"];

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Tabs
            value={prefs.range}
            onValueChange={(value) => {
              const range = value as LedgerRange;
              if (range === "custom") {
                const today = todayLocalDateString();
                const weekAgo = todayLocalDateString(Date.now() - 6 * 86_400_000);
                onPrefs({
                  range,
                  customStart: prefs.customStart || weekAgo,
                  customEnd: prefs.customEnd || today,
                });
                return;
              }
              onPrefs({ range });
            }}
            className="shrink-0"
          >
            <TabsList className={USAGE_STATS_TABS_LIST_CLASS}>
              {LEDGER_RANGES_UI.map((option) => (
                <TabsTrigger key={option} value={option} className={USAGE_STATS_TABS_TRIGGER_CLASS}>
                  {intl.formatMessage({ id: RANGE_LABEL_IDS[option] })}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          <Select
            value={prefs.providerLabel || "__all__"}
            onValueChange={(value) => onPrefs({ providerLabel: value === "__all__" ? "" : value })}
          >
            <SelectTrigger size="sm" className="h-8 min-w-32 max-w-56">
              <SelectValue
                placeholder={intl.formatMessage({ id: "settings.usage.ledger.allProviders" })}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">
                {intl.formatMessage({ id: "settings.usage.ledger.allProviders" })}
              </SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.label} value={p.label}>
                  {p.label} ({formatCompactNumber(locale, p.calls)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={prefs.modelId || "__all__"}
            onValueChange={(value) => onPrefs({ modelId: value === "__all__" ? "" : value })}
          >
            <SelectTrigger size="sm" className="h-8 min-w-32 max-w-56">
              <SelectValue
                placeholder={intl.formatMessage({ id: "settings.usage.ledger.allModels" })}
              />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">
                {intl.formatMessage({ id: "settings.usage.ledger.allModels" })}
              </SelectItem>
              {models.map((m) => (
                <SelectItem key={m.id ?? "__null__"} value={m.id ?? "__null__"}>
                  {m.id ?? intl.formatMessage({ id: "settings.usage.unknownModel" })} (
                  {formatCompactNumber(locale, m.calls)})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Popover>
            <PopoverTrigger asChild>
              <Button type="button" variant="outline" size="sm" className="h-8 max-w-60">
                <span className="truncate">
                  {intl.formatMessage({ id: "settings.usage.ledger.source" })}：{sourceButtonLabel}
                </span>
                <ChevronDown className="size-3.5 shrink-0 opacity-60" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-72 p-3">
              <div className="flex gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 flex-1 px-2 text-ui-sm"
                  onClick={() => selectSourceGroup("all")}
                >
                  {intl.formatMessage({ id: "settings.usage.ledger.sourceAll" })}
                </Button>
                {groups.map((variant) => {
                  const count = availableSources.filter((s) => s.variant === variant).length;
                  if (count === 0) {
                    return null;
                  }
                  return (
                    <Button
                      key={variant}
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-7 flex-1 px-2 text-ui-sm"
                      onClick={() => selectSourceGroup(variant)}
                    >
                      {intl.formatMessage({ id: sourceGroupLabelId(variant) })}
                    </Button>
                  );
                })}
              </div>
              <div className="mt-2 max-h-72 space-y-0.5 overflow-y-auto">
                {groups.flatMap((variant) =>
                  sources
                    .filter((s) => s.variant === variant)
                    .map((source) => (
                      <label
                        key={source.key}
                        className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-ui-sm ${
                          source.ok ? "hover:bg-surface" : "opacity-50"
                        }`}
                        title={source.error ?? source.rootPath}
                      >
                        <Checkbox
                          checked={
                            source.ok &&
                            (!prefs.sourceKeys || prefs.sourceKeys.includes(source.key))
                          }
                          disabled={!source.ok}
                          onCheckedChange={() => toggleSource(source.key)}
                        />
                        <span className="min-w-0 flex-1 truncate">{source.label}</span>
                        <span className="shrink-0 tabular-nums text-foreground-subtle">
                          {source.ok
                            ? formatCompactNumber(locale, source.calls)
                            : intl.formatMessage({ id: "settings.usage.ledger.sourceUnavailable" })}
                        </span>
                      </label>
                    )),
                )}
              </div>
              <p className="mt-2 px-2 text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "settings.usage.ledger.sourceHint" })}
              </p>
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={String(prefs.refreshIntervalMs)}
            onValueChange={(value) => onPrefs({ refreshIntervalMs: Number(value) })}
          >
            <SelectTrigger size="sm" className="h-8 w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEDGER_REFRESH_OPTIONS.map((option) => (
                <SelectItem key={option} value={String(option)}>
                  {intl.formatMessage(
                    { id: "settings.usage.ledger.refreshInterval" },
                    {
                      value:
                        option === 0
                          ? intl.formatMessage({ id: "settings.usage.ledger.refreshOff" })
                          : option >= 60_000
                            ? intl.formatMessage(
                                { id: "settings.usage.ledger.refreshMinutes" },
                                { count: option / 60_000 },
                              )
                            : intl.formatMessage(
                                { id: "settings.usage.ledger.refreshSeconds" },
                                { count: option / 1000 },
                              ),
                    },
                  )}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={onRefresh}
            disabled={customRangeInvalid}
          >
            <RefreshCcw className="size-3.5" />
            {intl.formatMessage({ id: "settings.usage.refresh" })}
          </Button>
        </div>
      </div>

      {prefs.range === "custom" ? (
        <div className="flex flex-wrap items-center gap-2">
          <input
            type="date"
            value={prefs.customStart}
            max={prefs.customEnd || todayLocalDateString()}
            onChange={(e) => onPrefs({ customStart: e.target.value })}
            className="h-8 rounded-md border border-input bg-background px-2 text-ui-sm"
          />
          <span className="text-foreground-subtle">→</span>
          <input
            type="date"
            value={prefs.customEnd}
            min={prefs.customStart}
            max={todayLocalDateString()}
            onChange={(e) => onPrefs({ customEnd: e.target.value })}
            className="h-8 rounded-md border border-input bg-background px-2 text-ui-sm"
          />
          {customRangeInvalid ? (
            <span className="text-ui-sm text-destructive">
              {intl.formatMessage({ id: "settings.usage.ledger.customRangeRequired" })}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
