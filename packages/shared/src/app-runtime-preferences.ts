import { z } from "zod";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  zcodeCompactionPreferencesSchema,
} from "./zcode-protocol/index.js";

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    // 压缩偏好随广播跨窗口同步；缺失（旧 sender）按「维持现状」默认值处理。
    compaction: zcodeCompactionPreferencesSchema.default(DEFAULT_ZCODE_COMPACTION_PREFERENCES),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
