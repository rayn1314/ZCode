import type { AppSettings } from "./protocol.js";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  type ZCodeCompactionPreferences,
} from "./zcode-protocol/index.js";

/**
 * AppSettings 六项压缩控件 → 协议层 `ZCodeCompactionPreferences` 的唯一映射。
 *
 * 设置页、本地 Host 应答（services/node.ts）、远端 Bot 桥接与跨窗口广播都从这里取，
 * 避免同一份字段归一化在各处漂移；越界/非法值一律回落到「维持现状」默认值，
 * 与 core `normalizeThresholdPercent` 的 fail-safe 方向一致。
 */
export type AppCompactionSettings = Pick<
  AppSettings,
  | "compactionThresholdPercent"
  | "compactionMicrocompactEnabled"
  | "compactionMicrocompactKeepRecentToolResults"
  | "compactionMicrocompactClearErrorResults"
  | "compactionPostTurnEnabled"
  | "compactionModelDownshiftEnabled"
>;

export function resolveCompactionPreferencesFromSettings(
  settings: AppCompactionSettings,
): ZCodeCompactionPreferences {
  const percent = settings.compactionThresholdPercent;
  const keepRecentToolResults = settings.compactionMicrocompactKeepRecentToolResults;
  return {
    thresholdPercent:
      typeof percent === "number" && Number.isInteger(percent) && percent >= 1 && percent <= 100
        ? percent
        : DEFAULT_ZCODE_COMPACTION_PREFERENCES.thresholdPercent,
    microcompactEnabled: settings.compactionMicrocompactEnabled === true,
    microcompactKeepRecentToolResults:
      typeof keepRecentToolResults === "number" &&
      Number.isInteger(keepRecentToolResults) &&
      keepRecentToolResults >= 1 &&
      keepRecentToolResults <= 50
        ? keepRecentToolResults
        : DEFAULT_ZCODE_COMPACTION_PREFERENCES.microcompactKeepRecentToolResults,
    microcompactClearErrorResults: settings.compactionMicrocompactClearErrorResults === true,
    postTurnEnabled: settings.compactionPostTurnEnabled === true,
    modelDownshiftEnabled: settings.compactionModelDownshiftEnabled === true,
  };
}
