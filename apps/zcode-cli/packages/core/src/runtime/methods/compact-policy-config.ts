import type { Model } from "../deps.js";
import type { AutoCompactPolicyConfig } from "../deps.js";
import type { AgentRuntimeConfig } from "../types.js";
import { resolveNormalRequestMaxOutputTokens } from "./model-token-limits.js";

/**
 * 把 session 级压缩策略与当前模型的真实窗口合成为 `AutoCompactPolicyConfig`。
 *
 * 三个压缩入口（局部压缩 / 自动压缩 / 模型降档提前压）必须共用这一份合成逻辑，
 * 否则"两套常量各算一次窗口和预算"的老问题会在新增入口上重演。
 *
 * 所有由模型推导的字段都放在 `...config.compact` **之后**强制覆盖：
 * 策略对象里即使误带 `contextWindow`（协议层不接受该字段，但内部对象是结构化类型），
 * 也不会把模型真实窗口覆盖成配置值，阈值与预算全部算错（spec 不变式 I3）。
 */
export function resolveRuntimeCompactPolicyConfig(
  config: AgentRuntimeConfig,
  model: Model,
): AutoCompactPolicyConfig {
  return {
    ...config.compact,
    contextWindow: model.properties.contextWindow,
    maxOutputTokens: resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    modelContextBudgetStrategy: config.modelContextBudgetStrategy,
  };
}
