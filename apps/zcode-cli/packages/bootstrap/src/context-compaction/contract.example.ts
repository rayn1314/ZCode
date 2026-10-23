/**
 * context-compaction 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { AgentRuntimeCompactionPolicyOverride } from "./contract.js";
import {
  applyPostTurnThresholdOffset,
  compactionPreferencesToPolicy,
  compactionPreferencesToPolicyOverride,
  getAutoCompactThreshold,
  resolveCompactionPreferencesFromSettings,
  updateCompactionPreferences,
  type AppCompactionSettings,
  type ZCodeCompactionPreferences,
} from "./contract.js";
import type { ZCodeProtocolAgentServerContext } from "../zcode-protocol/server-types.js";

/**
 * 创建期：设置七项 → 协议偏好 → **稀疏**策略覆盖。
 * 只下发用户表达过的偏好（全默认返回 `{}`），让 CLI 文件段里设置页不拥有的键完整存活。
 */
export function exampleCreationPolicy(
  settings: AppCompactionSettings,
): AgentRuntimeCompactionPolicyOverride {
  const preferences = resolveCompactionPreferencesFromSettings(settings);
  return compactionPreferencesToPolicyOverride(preferences);
}

/**
 * 热更新：协议 handler 里一次做完三件事——写 workspace 偏好、刷新 session 快照、逐个会话热更新。
 * 用户当次操作就是当前意图，因此走**七项全量**映射；找不到 / 不支持该能力的 session 跳过。
 */
export async function exampleHotUpdatePreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  return updateCompactionPreferences(context, rawParams);
}

/** 热更新期的映射产物：七项全量 present，`bufferTokens: null` 表示显式清除覆盖。 */
export function exampleHotUpdatePolicy(
  preferences: ZCodeCompactionPreferences,
): ReturnType<typeof compactionPreferencesToPolicy> {
  return compactionPreferencesToPolicy(preferences);
}

/**
 * 轮末判定：偏移缺省或为 0 时 `applyPostTurnThresholdOffset` 原样返回入参（引用相等，逐位不变）；
 * 非 0 时把阈值下调若干 token，使轮末可以比自动压缩更早触发（夹紧到 1，不会每次轮末都压）。
 */
export function examplePostTurnThreshold(
  config: Parameters<typeof applyPostTurnThresholdOffset>[0],
  offsetTokens: number,
): number {
  return getAutoCompactThreshold(applyPostTurnThresholdOffset(config, offsetTokens));
}
