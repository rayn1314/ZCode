import { shouldAutoCompact } from "../deps.js";
import type { AutoCompactDecision, Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { buildRuntimeProviderRequestMessages } from "../helpers/index.js";
import { buildProviderUsageTokenOverride } from "./compact.js";
import { resolveRuntimeCompactPolicyConfig } from "./compact-policy-config.js";

/**
 * 以 messageHistory 的当前投影评估"是否需要自动压缩"。
 *
 * 轮末压缩与模型降档提前压共用这一份判定：两处各写一遍"策略合成 + 投影 + token override"
 * 迟早会漂移成两套阈值。`autoCompactIfNeeded` 不复用这里——它判的是 loop 自己的
 * `turnRequestState.entries`（可能领先于 messageHistory 的已提交态），语义不同。
 */
export function evaluateRuntimeAutoCompactDecision(
  runtime: AgentRuntimeInternal,
  model: Model,
): AutoCompactDecision {
  const config = resolveRuntimeCompactPolicyConfig(runtime.config, model);
  const projection = buildRuntimeProviderRequestMessages(runtime, {
    entries: runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
    applyCacheControl: false,
    model,
  });
  return shouldAutoCompact({
    messages: projection.messages,
    config,
    consecutiveFailures: runtime.autoCompactConsecutiveFailures,
    tokenOverride: buildProviderUsageTokenOverride(projection.messages, projection.sourceEntries),
  });
}
