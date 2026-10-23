import { z } from "zod";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  zcodeCompactionPreferencesSchema,
} from "./compaction-preferences.js";

export const appToolSearchModeSchema = z.enum(["auto", "local", "off"]);
export type AppToolSearchMode = z.infer<typeof appToolSearchModeSchema>;

export const APP_RUNTIME_PREFERENCES_CHANGED_BROADCAST_CHANNEL = "settings:app-runtime-preferences";
export const ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV = "ZCODE_E2E_ASK_USER_QUESTION_CLOCK_SCALE";

export const appRuntimePreferencesChangedBroadcastPayloadSchema = z
  .object({
    askUserQuestionAutoResolutionEnabled: z.boolean(),
    // 缺失（旧 sender）按「未设置即开启」处理，避免旧 Host 广播把新窗口的开关误关。
    permissionRequestAutoDenyEnabled: z.boolean().default(true),
    modelIoFullRetentionEnabled: z.boolean().default(false),
    // 压缩偏好随广播跨窗口同步；缺失（旧 sender）按「维持现状」默认值处理。
    compaction: zcodeCompactionPreferencesSchema.default(DEFAULT_ZCODE_COMPACTION_PREFERENCES),
  })
  .strict();

export type AppRuntimePreferencesChangedBroadcastPayload = z.infer<
  typeof appRuntimePreferencesChangedBroadcastPayloadSchema
>;
