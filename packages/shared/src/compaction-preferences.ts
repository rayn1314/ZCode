import { z } from "zod";

/**
 * 压缩偏好是「设置层」与「协议层」共用的叶子结构，单独成文件以避免
 * `zcode-protocol` ↔ `app-runtime-preferences` 的循环初始化：
 * 协议侧只依赖本模块，设置侧也不再反向依赖协议入口。
 *
 * 用户调的是**安全余量**（tokens），不是阈值百分比：阈值 = 输入侧上限 − 余量。
 * 百分比只是反算出来的只读展示值（`getAutoCompactThresholdPercent`）。
 */
export const zcodeCompactionPreferencesSchema = z
  .object({
    /** 自动压缩的安全余量（tokens）；null = 不覆盖（让 CLI 文件值 / 默认 13000 生效）。 */
    bufferTokens: z.number().int().min(1_000).max(100_000).nullable(),
    microcompactEnabled: z.boolean(),
    microcompactKeepRecentToolResults: z.number().int().min(1).max(50),
    microcompactClearErrorResults: z.boolean(),
    postTurnEnabled: z.boolean(),
    /** 轮末阈值相对自动阈值的提前量（tokens）；0 = 与自动阈值相同。总是 present。 */
    postTurnThresholdOffsetTokens: z.number().int().min(0).max(100_000),
    modelDownshiftEnabled: z.boolean(),
  })
  .strict();
export type ZCodeCompactionPreferences = z.infer<typeof zcodeCompactionPreferencesSchema>;

/** 「维持现状」默认值：不显式配置任何开关时的压缩行为。 */
export const DEFAULT_ZCODE_COMPACTION_PREFERENCES: ZCodeCompactionPreferences = {
  bufferTokens: null,
  microcompactEnabled: false,
  microcompactKeepRecentToolResults: 5,
  microcompactClearErrorResults: false,
  postTurnEnabled: false,
  postTurnThresholdOffsetTokens: 0,
  modelDownshiftEnabled: false,
};
