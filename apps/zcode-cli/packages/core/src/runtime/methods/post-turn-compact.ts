import {
  CompactPhase,
  CompactReason,
  CompactTrigger,
  traceContextToLogContext,
} from "../deps.js";
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
 * 只在阈值**已经达到**时才跑，因此这份工作在下一轮本来也要做：时机前移让用户感知的等待更短，
 * 也消除了下一轮在 MidTurn 阶段被压缩打断的风险。代价是这段时间 runtime 仍持有 active turn。
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

  const decision = evaluateRuntimeAutoCompactDecision(runtime, input.model);
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
