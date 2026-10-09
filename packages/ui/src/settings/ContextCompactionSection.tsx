import { useCallback, useState } from "react";
import type { AppSettings } from "@zcode/shared";
import { Switch } from "@/components/ui/switch.js";
import { toast } from "@/components/ui/toast.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { logger } from "@/logger.js";
import {
  readEffectiveModelContextWindow,
  resolveAutoThresholdTokens,
} from "@/lib/contextCompactionSettings.js";
import { BufferTokensRow, MicrocompactRows } from "@/settings/CompactionThresholdRows.js";
import { PostTurnCompactRows } from "@/settings/CompactionPostTurnRows.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const DEFAULT_KEEP_RECENT_TOOL_RESULTS = 5;
const DEFAULT_POST_TURN_OFFSET = 0;

/**
 * 「上下文压缩」设置分区（spec: core/spec/context-compaction-controls.md §3.6）。
 *
 * 七个控件默认全部「维持现状」，写回 AppSettings 后由 useSettingService 的同步门
 * 整份下发到 workspace/updateCompactionPreferences，无需重启会话即生效。
 * 这里只表达产品级开关，不阻断压缩（阻断只有 PreCompact hook 能做）。
 *
 * 用户调的是**安全余量**（tokens）：阈值 = 输入侧上限 − 余量。百分比只是反算出来的
 * 只读展示值，不可编辑——百分比会随模型窗口漂移，且"显示值照抄回填"无法复现自动值。
 * 具体控件实现见 CompactionThresholdRows / CompactionPostTurnRows。
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

  const bufferTokens = settings?.compactionBufferTokens ?? null;
  const microcompactEnabled = settings?.compactionMicrocompactEnabled === true;
  const keepRecentToolResults =
    settings?.compactionMicrocompactKeepRecentToolResults ?? DEFAULT_KEEP_RECENT_TOOL_RESULTS;
  const clearErrorResults = settings?.compactionMicrocompactClearErrorResults === true;
  const postTurnEnabled = settings?.compactionPostTurnEnabled === true;
  const postTurnOffset =
    settings?.compactionPostTurnThresholdOffsetTokens ?? DEFAULT_POST_TURN_OFFSET;
  const modelDownshiftEnabled = settings?.compactionModelDownshiftEnabled === true;
  const autoThresholdTokens = resolveAutoThresholdTokens(contextWindow, bufferTokens);

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
        <BufferTokensRow
          disabled={saving}
          bufferTokens={bufferTokens}
          contextWindow={contextWindow}
          thresholdTokens={autoThresholdTokens}
          onCommit={(next) => void persist({ compactionBufferTokens: next })}
        />
        <MicrocompactRows
          disabled={saving}
          enabled={microcompactEnabled}
          keepRecentToolResults={keepRecentToolResults}
          clearErrorResults={clearErrorResults}
          thresholdIsAuto={bufferTokens === null}
          onEnabledChange={(enabled) => void persist({ compactionMicrocompactEnabled: enabled })}
          onKeepRecentCommit={(value) =>
            void persist({ compactionMicrocompactKeepRecentToolResults: value })
          }
          onClearErrorResultsChange={(enabled) =>
            void persist({ compactionMicrocompactClearErrorResults: enabled })
          }
        />
        <PostTurnCompactRows
          disabled={saving}
          enabled={postTurnEnabled}
          offsetTokens={postTurnOffset}
          contextWindow={contextWindow}
          autoThresholdTokens={autoThresholdTokens}
          onEnabledChange={(enabled) => void persist({ compactionPostTurnEnabled: enabled })}
          onOffsetCommit={(value) =>
            void persist({ compactionPostTurnThresholdOffsetTokens: value })
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

function SkeletonLine() {
  return <div className="h-5 w-40 animate-pulse rounded-sm bg-surface" />;
}
