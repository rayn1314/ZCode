import { CompactPhase, CompactReason, CompactTrigger, traceContextToLogContext } from "../deps.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { ActiveTurnSteeringState } from "../types.js";
import { isTurnCancellationError } from "../helpers/index.js";
import { evaluateRuntimeAutoCompactDecision } from "./compact-decision.js";

/**
 * 轮末压缩：一轮成功收口后立刻把上下文压好，而不是等用户下一次提问时的 PreRequest 阶段。
 *
 * 位置约束（spec D8）：TurnComplete 事件与 usage 事实已发射之后、`return result` 之前内联执行。
 * 不新建后台调度器——后台压缩会与下一个 turn 竞争改写历史，破坏"压缩替换历史是原子的"这一不变式。
 *
 * 阈值不再与自动压缩共用：判定走 `{ forPostTurn: true }`，按用户的提前量把轮末阈值下调
 * （spec D8）。默认提前量为 0 时与自动压缩完全相同；一旦用户设了提前量，轮末就**可能**在
 * 下一轮 PreRequest 并不会触发的情况下也压缩——这是本功能有意为之的语义，不是缺陷。
 * 时机前移让用户感知的等待更短，也消除了下一轮在 MidTurn 阶段被压缩打断的风险；
 * 代价是这段时间 runtime 仍持有 active turn。
 *
 * 任何失败都不影响已完成的 turn：压缩是维护动作，不是业务动作。
 */
export async function maybeCompactAfterTurn(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    activeTurn: ActiveTurnSteeringState;
    events: SessionEvent[];
    model: Model;
    traceContext: TraceContext;
  },
): Promise<void> {
  if (runtime.config.compact?.enabled === false) return;
  if (runtime.config.compact?.postTurnEnabled !== true) return;
  // 用户马上要发下一轮时不抢跑：那种情况下一轮的 PreRequest 会自动压，且用户能立刻看到新轮开始。
  if (input.activeTurn.pendingInputs.length > 0 || runtime.runtimeCommandQueue.hasPending()) {
    runtime.logger?.debug("Post-turn compact skipped because input is already queued", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.post_turn.skipped",
      module: "core.runtime",
      pendingSteerInputCount: input.activeTurn.pendingInputs.length,
      reason: "queued_input",
    });
    return;
  }

  const decision = evaluateRuntimeAutoCompactDecision(runtime, input.model, { forPostTurn: true });
  if (!decision.shouldCompact) {
    runtime.logger?.debug("Post-turn compact skipped", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.post_turn.skipped",
      module: "core.runtime",
      reason: decision.reason,
      thresholdTokens: decision.threshold,
      tokenCount: decision.tokenCount,
    });
    return;
  }

  runtime.logger?.info("Post-turn compact started", {
    ...traceContextToLogContext(input.traceContext),
    event: "compact.post_turn.started",
    module: "core.runtime",
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
        compactReason: CompactReason.ContextLimit,
        phase: CompactPhase.PostTurn,
        trigger: CompactTrigger.PostTurn,
        model: input.model,
      },
    );
    runtime.logger?.info("Post-turn compact finished", {
      ...traceContextToLogContext(input.traceContext),
      event: "compact.post_turn.completed",
      module: "core.runtime",
      outcome: result.outcome,
    });
  } catch (error) {
    if (isTurnCancellationError(error, input.abortSignal)) {
      runtime.logger?.info("Post-turn compact interrupted", {
        ...traceContextToLogContext(input.traceContext),
        event: "compact.post_turn.interrupted",
        module: "core.runtime",
        status: "cancelled",
      });
      return;
    }
    runtime.logger?.warn("Post-turn compact failed", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.post_turn.failed",
      module: "core.runtime",
    });
  }
}
