import type { AgentRuntimeCompactionPolicyPatch } from "@zcode/core";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  type ZCodeCompactionPreferences,
} from "@zcode/shared";

/**
 * 协议压缩偏好 → 运行时策略补丁，两个产物职责不同，禁止互相替代。
 *
 * 两者的共同前提：`undefined` = 不修改、`null`（仅 thresholdPercent）= 显式清除、
 * 布尔 `false` = 显式关闭；且都**不产出** `contextWindow` / `maxOutputTokens`
 * （由当前模型推导，spec 不变式 I3）。
 */

/**
 * 热更新用：六项**全量 present**（`thresholdPercent` 为 `number | null`，两个布尔总给出）。
 *
 * 设置页每次提交都是整份状态，只有全量下发才能让用户「关掉刚打开的东西」，
 * 以及把阈值从覆盖值改回自动（`null` → 清除）。
 */
export function compactionPreferencesToPolicy(
  preferences: ZCodeCompactionPreferences,
): AgentRuntimeCompactionPolicyPatch {
  return {
    thresholdPercent: preferences.thresholdPercent,
    microcompact: {
      enabled: preferences.microcompactEnabled,
      keepRecentToolResults: preferences.microcompactKeepRecentToolResults,
      clearErrorResults: preferences.microcompactClearErrorResults,
    },
    postTurnEnabled: preferences.postTurnEnabled,
    modelDownshiftEnabled: preferences.modelDownshiftEnabled,
  };
}

/**
 * 创建期产物类型：`thresholdPercent` 只可能是数字（null 表示"清除"，而创建期的空配置
 * 表达方式是**省略该键**）。因此它同时可赋给 `AgentRuntimeCompactionPolicyPatch`
 * 与 core 的 `AutoCompactPolicyConfig`。
 */
export type AgentRuntimeCompactionPolicyOverride = Omit<
  AgentRuntimeCompactionPolicyPatch,
  "thresholdPercent"
> & { thresholdPercent?: number };

/**
 * 创建期用：只含**偏离默认值**的字段，靠条件构造省略键。
 *
 * 必须省略而不是写成 `{thresholdPercent: x ?? undefined}`：只要键存在，展开时就会把
 * CLI 文件里的同名值清掉。全默认（用户没表达任何偏好）返回 `{}`，调用方据此整段省略
 * `runtimeConfig.compact`，让文件级 `compact` 段完整生效——这是纯 CLI / headless
 * 用户唯一的配置入口（spec D5）。
 */
export function compactionPreferencesToPolicyOverride(
  preferences: ZCodeCompactionPreferences,
): AgentRuntimeCompactionPolicyOverride {
  const policy: AgentRuntimeCompactionPolicyOverride = {};
  // null 表示「自动」，在创建期等价于「不表达」，直接省略键。
  if (preferences.thresholdPercent !== null) {
    policy.thresholdPercent = preferences.thresholdPercent;
  }
  const microcompact: NonNullable<AgentRuntimeCompactionPolicyPatch["microcompact"]> = {};
  if (preferences.microcompactEnabled) {
    microcompact.enabled = true;
  }
  if (
    preferences.microcompactKeepRecentToolResults !==
    DEFAULT_ZCODE_COMPACTION_PREFERENCES.microcompactKeepRecentToolResults
  ) {
    microcompact.keepRecentToolResults = preferences.microcompactKeepRecentToolResults;
  }
  if (preferences.microcompactClearErrorResults) {
    microcompact.clearErrorResults = true;
  }
  if (Object.keys(microcompact).length > 0) {
    policy.microcompact = microcompact;
  }
  if (preferences.postTurnEnabled) {
    policy.postTurnEnabled = true;
  }
  if (preferences.modelDownshiftEnabled) {
    policy.modelDownshiftEnabled = true;
  }
  return policy;
}
