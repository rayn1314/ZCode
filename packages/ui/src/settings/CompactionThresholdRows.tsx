import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  COMPACTION_BUFFER_INPUT_K_MAX,
  COMPACTION_BUFFER_INPUT_K_MIN,
  COMPACTION_KEEP_RECENT_TOOL_RESULTS_MAX,
  COMPACTION_KEEP_RECENT_TOOL_RESULTS_MIN,
  formatTokensAsThousandsDraft,
  parseBufferTokensInput,
  parseKeepRecentToolResultsInput,
  resolveThresholdPercent,
} from "@/lib/contextCompactionSettings.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 「上下文压缩」里的阈值类控件（spec: core/spec/context-compaction-controls.md §3.6）。
 *
 * 自动压缩的「安全余量」与局部压缩的展开项放在同一文件：两者共用「阈值 + 保留组数」的
 * 数值输入形态与错误展示约定，放一起便于统一维护（Section 本体只负责编排与下发）。
 */

/**
 * 自动压缩的「安全余量」（tokens，K 输入）。
 *
 * 用户调的是绝对余量而不是百分比：百分比会随模型窗口漂移（128K 上按比例只剩 ~0.8K 缓冲），
 * 而余量是"离上限还留多少 token"的直接表达。百分比只作为只读信息展示，不可编辑。
 */
export function BufferTokensRow({
  disabled,
  bufferTokens,
  contextWindow,
  thresholdTokens,
  onCommit,
}: {
  disabled: boolean;
  bufferTokens: number | null;
  contextWindow: number | undefined;
  thresholdTokens: number | null;
  onCommit: (next: number | null) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(formatTokensAsThousandsDraft(bufferTokens));
  const [invalid, setInvalid] = useState(false);

  // 外部（其它窗口 / 迁移）改了这个值时同步草稿，避免显示陈旧值。
  useEffect(() => {
    setDraft(formatTokensAsThousandsDraft(bufferTokens));
    setInvalid(false);
  }, [bufferTokens]);

  const commit = () => {
    const parsed = parseBufferTokensInput(draft);
    if (parsed.kind === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const next = parsed.kind === "auto" ? null : parsed.value;
    if (next === bufferTokens) {
      setDraft(formatTokensAsThousandsDraft(next));
      return;
    }
    onCommit(next);
  };

  return (
    <SettingsRow
      label={intl.formatMessage({ id: "settings.contextCompaction.buffer.label" })}
      detail={
        <>
          <div className="text-ui-base text-foreground-subtle">
            {contextWindow === undefined || thresholdTokens === null
              ? intl.formatMessage({ id: "settings.contextCompaction.buffer.infoUnknown" })
              : intl.formatMessage(
                  { id: "settings.contextCompaction.buffer.info" },
                  {
                    window: Math.round(contextWindow / 1_000),
                    threshold: Math.round(thresholdTokens / 1_000),
                    percent: resolveThresholdPercent(contextWindow, thresholdTokens) ?? 0,
                  },
                )}
          </div>
          {invalid ? (
            <div className="mt-2 text-ui-base text-destructive">
              {intl.formatMessage({ id: "settings.contextCompaction.bufferInvalid" })}
            </div>
          ) : null}
        </>
      }
      control={
        <>
          <div className="flex items-center gap-1">
            <Input
              type="number"
              inputMode="numeric"
              min={COMPACTION_BUFFER_INPUT_K_MIN}
              max={COMPACTION_BUFFER_INPUT_K_MAX}
              step={1}
              value={draft}
              disabled={disabled}
              aria-invalid={invalid}
              aria-label={intl.formatMessage({ id: "settings.contextCompaction.buffer.label" })}
              data-testid="compaction-buffer-tokens-input"
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
            <span className="text-ui-base text-foreground-subtle">K</span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || bufferTokens === null}
            onClick={() => {
              setDraft("");
              setInvalid(false);
              onCommit(null);
            }}
            data-testid="compaction-buffer-tokens-reset"
          >
            {intl.formatMessage({ id: "settings.contextCompaction.buffer.reset" })}
          </Button>
        </>
      }
    />
  );
}

export function MicrocompactRows({
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
