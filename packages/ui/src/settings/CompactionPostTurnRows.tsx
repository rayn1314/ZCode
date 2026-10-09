import { useEffect, useState } from "react";
import { Collapsible, CollapsibleContent } from "@/components/ui/collapsible.js";
import { Input } from "@/components/ui/input.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  COMPACTION_POST_TURN_OFFSET_INPUT_K_MAX,
  COMPACTION_POST_TURN_OFFSET_INPUT_K_MIN,
  formatTokensAsThousandsDraft,
  parsePostTurnThresholdOffsetTokensInput,
  resolveThresholdPercent,
} from "@/lib/contextCompactionSettings.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";

/**
 * 轮末压缩：开关 + 展开区里的「提前量」输入（spec: core/spec/context-compaction-controls.md §3.6）。
 *
 * 提前量（tokens）把轮末阈值下调，使轮末可以比自动压缩更早触发；0 = 与自动压缩阈值相同。
 * 展开区在开启轮末压缩时才可见——未开启时这个数字没有任何作用，不占用户的注意力（Steve Krug）。
 */
export function PostTurnCompactRows({
  disabled,
  enabled,
  offsetTokens,
  contextWindow,
  autoThresholdTokens,
  onEnabledChange,
  onOffsetCommit,
}: {
  disabled: boolean;
  enabled: boolean;
  offsetTokens: number;
  contextWindow: number | undefined;
  autoThresholdTokens: number | null;
  onEnabledChange: (enabled: boolean) => void;
  onOffsetCommit: (value: number) => void;
}) {
  const { intl } = useZCodeIntl();
  const [draft, setDraft] = useState(formatTokensAsThousandsDraft(offsetTokens) || "0");
  const [invalid, setInvalid] = useState(false);

  // 外部（其它窗口 / 迁移）改了这个值时同步草稿，避免显示陈旧值。
  useEffect(() => {
    setDraft(formatTokensAsThousandsDraft(offsetTokens) || "0");
    setInvalid(false);
  }, [offsetTokens]);

  const commit = () => {
    const parsed = parsePostTurnThresholdOffsetTokensInput(draft);
    if (parsed.kind === "invalid") {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (parsed.value === offsetTokens) {
      setDraft(formatTokensAsThousandsDraft(parsed.value) || "0");
      return;
    }
    onOffsetCommit(parsed.value);
  };

  // 生效值：轮末阈值 = max(1, 自动阈值 − 提前量)。拿不到模型窗口时不显示，不编数字。
  const postTurnThresholdTokens =
    autoThresholdTokens === null ? null : Math.max(1, autoThresholdTokens - offsetTokens);
  const postTurnPercent = resolveThresholdPercent(contextWindow, postTurnThresholdTokens);

  return (
    <>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.contextCompaction.postTurn.label" })}
        description={intl.formatMessage({
          id: "settings.contextCompaction.postTurn.description",
        })}
        control={
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={onEnabledChange}
            aria-label={intl.formatMessage({ id: "settings.contextCompaction.postTurn.label" })}
            data-testid="compaction-post-turn-switch"
          />
        }
      />
      <Collapsible open={enabled}>
        <CollapsibleContent>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.contextCompaction.postTurn.offsetLabel" })}
            description={intl.formatMessage({
              id: "settings.contextCompaction.postTurn.offsetDescription",
            })}
            detail={
              <>
                {offsetTokens > 0 &&
                postTurnThresholdTokens !== null &&
                postTurnPercent !== null ? (
                  <div className="text-ui-base text-foreground-subtle">
                    {intl.formatMessage(
                      { id: "settings.contextCompaction.postTurn.offsetEffective" },
                      {
                        threshold: Math.round(postTurnThresholdTokens / 1_000),
                        percent: postTurnPercent,
                      },
                    )}
                  </div>
                ) : null}
                {invalid ? (
                  <div className="mt-2 text-ui-base text-destructive">
                    {intl.formatMessage({
                      id: "settings.contextCompaction.postTurnOffsetInvalid",
                    })}
                  </div>
                ) : null}
              </>
            }
            control={
              <div className="flex items-center gap-1">
                <Input
                  type="number"
                  inputMode="numeric"
                  min={COMPACTION_POST_TURN_OFFSET_INPUT_K_MIN}
                  max={COMPACTION_POST_TURN_OFFSET_INPUT_K_MAX}
                  step={1}
                  value={draft}
                  disabled={disabled}
                  aria-invalid={invalid}
                  aria-label={intl.formatMessage({
                    id: "settings.contextCompaction.postTurn.offsetLabel",
                  })}
                  data-testid="compaction-post-turn-offset-input"
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
            }
          />
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
