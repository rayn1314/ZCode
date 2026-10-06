import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  traceContextToLogContext,
} from "../deps.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { isTurnCancellationError } from "../helpers/index.js";
import { evaluateRuntimeAutoCompactDecision } from "./compact-decision.js";

/**
 * 模型降档提前压：切到上下文窗口更小的模型前先把上下文压进新窗口。
 *
 * 必须在 `emitModelSelected`（即 PreModelSwitch 注入）**之前**执行：
 * PreModelSwitch 的注入上下文写在 messageHistory 末尾，压缩只保留 context prefix +
 * summary + 最近一组轮次，注入会被吞掉（spec D9 的顺序约束）。
 *
 * 只做补充动作，不接管熔断：失败只 `warn`，不递增 `autoCompactConsecutiveFailures`
 * （该计数器归 auto/reactive 路径所有）。切换本身照常进行，最坏情况退化到切换后的
 * reactive 压缩兜底。
 */
export async function maybeCompactForModelDownshift(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    events: SessionEvent[];
    model: Model;
    previousContextWindow?: number;
    traceContext: TraceContext;
  },
): Promise<void> {
  if (runtime.config.compact?.enabled === false) return;
  if (runtime.config.compact?.modelDownshiftEnabled !== true) return;

  const nextWindow = input.model.properties.contextWindow;
  const previousWindow = input.previousContextWindow;
  // 上一个窗口未知时只能放弃：无法区分"降档"与"升级"，而升级时压缩是纯浪费。
  if (
    !isFinitePositive(previousWindow) ||
    !isFinitePositive(nextWindow) ||
    nextWindow >= previousWindow
  ) {
    runtime.logger?.debug("Model downshift compact not applicable", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.model_downshift.skipped",
      modelId: input.model.modelId,
      module: "core.runtime",
      nextContextWindow: nextWindow,
      previousContextWindow: previousWindow,
      reason: isFinitePositive(previousWindow) ? "window_not_shrinking" : "previous_window_unknown",
    });
    return;
  }

  const decision = evaluateRuntimeAutoCompactDecision(runtime, input.model);
  if (!decision.shouldCompact) {
    runtime.logger?.debug("Model downshift compact skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.model_downshift.skipped",
      modelId: input.model.modelId,
      module: "core.runtime",
      nextContextWindow: nextWindow,
      previousContextWindow: previousWindow,
      reason: decision.reason,
      thresholdTokens: decision.threshold,
      tokenCount: decision.tokenCount,
    });
    return;
  }

  runtime.logger?.info("Model downshift compact started", {
    ...traceContextToLogContext(input.traceContext),
    event: "compact.model_downshift.started",
    modelId: input.model.modelId,
    module: "core.runtime",
    nextContextWindow: nextWindow,
    previousContextWindow: previousWindow,
    thresholdTokens: decision.threshold,
    tokenCount: decision.tokenCount,
  });

  try {
    const result = await runtime.compactActiveConversation(
      undefined,
      input.traceContext,
      input.events,
      {
        abortSignal: input.abortSignal,
        autoCompactThreshold: decision.threshold,
        compactContextTelemetry: {
          inputTokens: decision.tokenCount,
          policyContextWindowTokens: decision.contextWindow,
          thresholdTokens: decision.threshold,
          tokenSource: decision.tokenSource,
        },
        compactReason: CompactReason.ModelDownshift,
        phase: CompactPhase.PreRequest,
        trigger: CompactTrigger.ModelDownshift,
        model: input.model,
      },
    );
    runtime.logger?.info("Model downshift compact finished", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.model_downshift.completed",
      modelId: input.model.modelId,
      module: "core.runtime",
      outcome: result.outcome,
    });
  } catch (error) {
    // 取消不是压缩失败：切换照常，也不该掩盖用户中断。
    if (isTurnCancellationError(error, input.abortSignal)) return;
    runtime.logger?.warn("Model downshift compact failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.model_downshift.failed",
      modelId: input.model.modelId,
      module: "core.runtime",
    });
  }
}

function isFinitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0;
}
