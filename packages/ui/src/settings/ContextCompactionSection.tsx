import { useCallback, useEffect, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  COMPACTION_KEEP_RECENT_TOOL_RESULTS_MAX,
  COMPACTION_KEEP_RECENT_TOOL_RESULTS_MIN,
  COMPACTION_THRESHOLD_PERCENT_MAX,
  COMPACTION_THRESHOLD_PERCENT_MIN,
  parseCompactionThresholdPercentInput,
  parseKeepRecentToolResultsInput,
  readEffectiveModelContextWindow,
  resolveAutoThresholdPercent,
} from "@/lib/contextCompactionSettings.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;

/**
 * 「上下文压缩」设置分区（spec: core/spec/context-compaction-controls.md §3.6）。
 *
 * 六个控件默认全部「维持现状」，写回 AppSettings 后由 useSettingService 的同步门
 * 整份下发到 workspace/updateCompactionPreferences，无需重启会话即生效。
 * 这里只表达产品级开关，不阻断压缩（阻断只有 PreCompact hook 能做）。
 */
export function ContextCompactionSection() {
  const { intl } = useZCodeIntl();
  const { settings, loading, update } = useSettings();
  const localHostServices = useBaseWorkspaceServices();
  const modelSelectionRead = useModelSelectionServiceView(localHostServices.modelSelectionService);
  const modelSelectionView =
    modelSelectionRead.state.status === "ready" ? modelSelectionRead.state.view : null;
  const contextWindow = readEffectiveModelContextWindow(modelSelectionView);

  const [saving, setSaving] = useState(false);

  const persist = useCallback(
    async (patch: Partial<AppSettings>) => {
      setSaving(true);
      try {
        await update(patch);
      } catch (error) {
        logger.warn("[settings] 更新上下文压缩设置失败", {
          error: error instanceof Error ? error.message : String(error),
        });
        toast(intl.formatMessage({ id: "settings.contextCompaction.saveFailed" }));
      } finally {
        setSaving(false);
      }
    },
    [intl, update],
  );

  const thresholdPercent = settings?.compactionThresholdPercent ?? null;
  const microcompactEnabled = settings?.compactionMicrocompactEnabled === true;
  const keepRecentToolResults =
    settings?.compactionMicrocompactKeepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  const clearErrorResults = settings?.compactionMicrocompactClearErrorResults === true;
  const postTurnEnabled = settings?.compactionPostTurnEnabled === true;
  const modelDownshiftEnabled = settings?.compactionModelDownshiftEnabled === true;
  const autoThresholdPercent = resolveAutoThresholdPercent(contextWindow);

  if (loading || !settings) {
    return (
      <div className="space-y-3">
        <SkeletonLine />
        <SettingsGroupCard>
          {[0, 1, 2].map((index) => (
            <div key={index} className="border-t border-border px-4 py-3 first:border-t-0">
              <SkeletonLine />
            </div>
          ))}
        </SettingsGroupCard>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="text-ui-base font-medium text-foreground-subtle">
        {intl.formatMessage({ id: "settings.contextCompaction.description" })}
      </div>
      <SettingsGroupCard>
        <CompactionThresholdRow
          disabled={saving}
          percent={thresholdPercent}
          autoPercent={autoThresholdPercent}
          onCommit={(next) => void persist({ compactionThresholdPercent: next })}
        />
        <MicrocompactRows
          disabled={saving}
          enabled={microcompactEnabled}
          keepRecentToolResults={keepRecentToolResults}
          clearErrorResults={clearErrorResults}
          thresholdIsAuto={thresholdPercent === null}
          onEnabledChange={(enabled) => void persist({ compactionMicrocompactEnabled: enabled })}
          onKeepRecentCommit={(value) =>
            void persist({ compactionMicrocompactKeepRecentToolResults: value })
          }
          onClearErrorResultsChange={(enabled) =>
            void persist({ compactionMicrocompactClearErrorResults: enabled })
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.contextCompaction.postTurn.label" })}
          description={intl.formatMessage({
            id: "settings.contextCompaction.postTurn.description",
          })}
          control={
            <Switch
              checked={postTurnEnabled}
              disabled={saving}
              onCheckedChange={(enabled) => void persist({ compactionPostTurnEnabled: enabled })}
              aria-label={intl.formatMessage({ id: "settings.contextCompaction.postTurn.label" })}
              data-testid="compaction-post-turn-switch"
            />
          }
        />
        <SettingsRow
          label={intl.formatMessage({ id: "settings.contextCompaction.modelDownshift.label" })}
          description={intl.formatMessage({
            id: "settings.contextCompaction.modelDownshift.description",
          })}
          control={
            <Switch
              checked={modelDownshiftEnabled}
              disabled={saving}
              onCheckedChange={(enabled) =>
                void persist({ compactionModelDownshiftEnabled: enabled })
              }
              aria-label={intl.formatMessage({
                id: "settings.contextCompaction.modelDownshift.label",
              })}
              data-testid="compaction-model-downshift-switch"
            />
          }
        />
      </SettingsGroupCard>
    </div>
  );
}

function CompactionThresholdRow({
  disabled,
  percent,
  autoPercent,
  onCommit,
}: {
  disabled: boolean;
  percent: number | null;
  autoPercent: number | null;
  onCommit: (next: number | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(percent === null ? "" : String(percent));
  const [invalid, setInvalid] = useState(false);

  // 外部（其它窗口 / 迁移）改了这个值时同步草稿，避免显示陈旧值。
  useEffect(() => {
    setDraft(percent === null ? "" : String(percent));
    setInvalid(false);
  }, [percent]);

  const commit = () => {
    const parsed = parseCompactionThresholdPercentInput(draft);
    if (parsed.kind === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const next = parsed.kind === "auto" ? null : parsed.value;
    if (next === percent) {
      setDraft(next === null ? "" : String(next));
      return;
    }
    onCommit(next);
  };

  const description =
    percent === null
      ? autoPercent === null
        ? intl.formatMessage({ id: "settings.contextCompaction.threshold.autoUnknown" })
        : intl.formatMessage(
            { id: "settings.contextCompaction.threshold.auto" },
            { percent: autoPercent },
          )
      : intl.formatMessage({ id: "settings.contextCompaction.threshold.explicit" }, { percent });

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.contextCompaction.threshold.label" })}
      description={description}
      detail={
        invalid ? (
          <div className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "settings.contextCompaction.thresholdInvalid" })}
          </div>
        ) : null
      }
      control={
        <>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              inputMode="numeric"
              min={COMPACTION_THRESHOLD_PERCENT_MIN}
              max={COMPACTION_THRESHOLD_PERCENT_MAX}
              step={1}
              value={draft}
              disabled={disabled}
              aria-invalid={invalid}
              aria-label={intl.formatMessage({ id: "settings.contextCompaction.threshold.label" })}
              data-testid="compaction-threshold-input"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  commit();
                }
              }}
              className="w-20 text-right"
            />
            <span className="text-ui-base text-foreground-subtle">%</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || percent === null}
            onClick={() => {
              setDraft("");
              setInvalid(false);
              onCommit(null);
            }}
            data-testid="compaction-threshold-reset"
          >
            {intl.formatMessage({ id: "settings.contextCompaction.threshold.reset" })}
          </Button>
        </>
      }
    />
  );
}

function MicrocompactRows({
  disabled,
  enabled,
  keepRecentToolResults,
  clearErrorResults,
  thresholdIsAuto,
  onEnabledChange,
  onKeepRecentCommit,
  onClearErrorResultsChange,
}: {
  disabled: boolean;
  enabled: boolean;
  keepRecentToolResults: number;
  clearErrorResults: boolean;
  thresholdIsAuto: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onKeepRecentCommit: (value: number) => void;
  onClearErrorResultsChange: (enabled: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(String(keepRecentToolResults));
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(String(keepRecentToolResults));
    setInvalid(false);
  }, [keepRecentToolResults]);

  const commit = () => {
    const parsed = parseKeepRecentToolResultsInput(draft);
    if (parsed.kind === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed.value === keepRecentToolResults) {
      setDraft(String(parsed.value));
      return;
    }
    onKeepRecentCommit(parsed.value);
  };

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.contextCompaction.microcompact.label" })}
        description={intl.formatMessage({
          id: "settings.contextCompaction.microcompact.description",
        })}
        control={
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
            aria-label={intl.formatMessage({ id: "settings.contextCompaction.microcompact.label" })}
            data-testid="compaction-microcompact-switch"
          />
        }
      />
      <Collapsible open={enabled}>
        <CollapsibleContent>
          {/* 依赖提示：局部压缩的触发点复用自动压缩阈值，用户在自动模式下需要知道这一点。 */}
          {thresholdIsAuto ? (
            <div className="border-t border-border px-4 py-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.contextCompaction.microcompact.thresholdHint" })}
            </div>
          ) : null}
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.contextCompaction.microcompact.keepRecentLabel",
            })}
            description={intl.formatMessage({
              id: "settings.contextCompaction.microcompact.keepRecentDescription",
            })}
            detail={
              invalid ? (
                <div className="text-ui-base text-destructive">
                  {intl.formatMessage({ id: "settings.contextCompaction.keepRecentInvalid" })}
                </div>
              ) : null
            }
            control={
              <Input
                type="number"
                inputMode="numeric"
                min={COMPACTION_KEEP_RECENT_TOOL_RESULTS_MIN}
                max={COMPACTION_KEEP_RECENT_TOOL_RESULTS_MAX}
                step={1}
                value={draft}
                disabled={disabled}
                aria-invalid={invalid}
                aria-label={intl.formatMessage({
                  id: "settings.contextCompaction.microcompact.keepRecentLabel",
                })}
                data-testid="compaction-keep-recent-input"
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commit();
                  }
                }}
                className="w-20 text-right"
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({
              id: "settings.contextCompaction.microcompact.clearErrorsLabel",
            })}
            description={intl.formatMessage({
              id: "settings.contextCompaction.microcompact.clearErrorsDescription",
            })}
            control={
              <Switch
                checked={clearErrorResults}
                disabled={disabled}
                onCheckedChange={onClearErrorResultsChange}
                aria-label={intl.formatMessage({
                  id: "settings.contextCompaction.microcompact.clearErrorsLabel",
                })}
                data-testid="compaction-clear-error-results-switch"
              />
            }
          />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}

function SkeletonLine() {
  return <div className="h-5 w-40 animate-pulse rounded-sm bg-surface" />;
}
