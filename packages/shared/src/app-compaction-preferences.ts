import type { AppSettings } from "./protocol.js";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  type ZCodeCompactionPreferences,
} from "./zcode-protocol/index.js";

/**
 * AppSettings 七项压缩控件 → 协议层 `ZCodeCompactionPreferences` 的唯一映射。
 *
 * 设置页、本地 Host 应答（services/node.ts）、远端 Bot 桥接与跨窗口广播都从这里取，
 * 避免同一份字段归一化在各处漂移；越界/非法值一律回落到「维持现状」默认值，
 * 与 core `normalizePostTurnThresholdOffsetTokens` 的 fail-safe 方向一致。
 */
export type AppCompactionSettings = Pick<
  AppSettings,
  | "compactionBufferTokens"
  | "compactionMicrocompactEnabled"
  | "compactionMicrocompactKeepRecentToolResults"
  | "compactionMicrocompactClearErrorResults"
  | "compactionPostTurnEnabled"
  | "compactionPostTurnThresholdOffsetTokens"
  | "compactionModelDownshiftEnabled"
>;

export function resolveCompactionPreferencesFromSettings(
  settings: AppCompactionSettings,
): ZCodeCompactionPreferences {
  const bufferTokens = settings.compactionBufferTokens;
  const keepRecentToolResults = settings.compactionMicrocompactKeepRecentToolResults;
  const postTurnOffset = settings.compactionPostTurnThresholdOffsetTokens;
  return {
    // null/缺省/越界都回落到「不覆盖」，让文件值或默认余量生效。
    bufferTokens:
      typeof bufferTokens === "number" &&
      Number.isInteger(bufferTokens) &&
      bufferTokens >= 1_000 &&
      bufferTokens <= 100_000
        ? bufferTokens
        : DEFAULT_ZCODE_COMPACTION_PREFERENCES.bufferTokens,
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
    postTurnThresholdOffsetTokens:
      typeof postTurnOffset === "number" &&
      Number.isInteger(postTurnOffset) &&
      postTurnOffset >= 0 &&
      postTurnOffset <= 100_000
        ? postTurnOffset
        : DEFAULT_ZCODE_COMPACTION_PREFERENCES.postTurnThresholdOffsetTokens,
    modelDownshiftEnabled: settings.compactionModelDownshiftEnabled === true,
  };
}
