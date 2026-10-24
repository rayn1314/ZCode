import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CompactTimelineStatus,
  CompactTrigger,
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createCoreError,
  formatCompactSummary,
  traceContextToLogContext,
} from "../deps.js";
import type { CompactTimelinePayload, SessionEvent, TraceContext } from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  isTurnCancellationError,
  readRawFinishReason,
} from "../helpers/index.js";
import type { CompactHookTrigger, CompactPhase } from "@zcode/contracts";
import type {
  CompactTimelineContext,
  RuntimeModelTextResult,
  RunModelTextRequestOptions,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import { estimateCurrentModelInputTokens } from "./compact.js";

export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_TOOL_USE_DENIAL_REASON = "compaction agent should only produce text summary";

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  return createCoreError(CoreErrorType.ModelContextExceeded, COMPACT_PROMPT_TOO_LONG_USER_MESSAGE, {
    cause: options.cause instanceof Error ? options.cause : undefined,
    context: {
      compactPromptTooLongAttempts: options.attempt,
      preCompactTokenCount: options.preCompactTokenCount,
    },
    recoverable: true,
    // 修复原因：compact 内部已经完成最多 3 次旧轮次截断重试；
    // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
    retryable: false,
  });
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (
    !isContextExceededFinishReason(result.finishReason, rawFinishReason) &&
    !isCompactEmptyLengthFinish(result)
  ) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

function isCompactEmptyLengthFinish(result: RuntimeModelTextResult): boolean {
  // GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
  // 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  await runtime.persistCompactTimeline(payload, traceContext);
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

/**
 * 压缩前上下文的 token 口径：**真实最后一轮 provider 用量 + 本地估算的增量**。
 *
 * 与自动压缩门禁（`buildProviderUsageTokenOverride`）同源，保证"为什么这次压了"和
 * "摘要块显示压了多少"是同一把尺子。纯字符估算只数 provider 的消息体，数不到工具
 * schema 等请求固定开销，会系统性偏低；实测可见估算值只有真实请求的六成上下。
 *
 * 硬不变式：**没有可用 provider 锚点时逐位退化为纯估算**。`estimateCurrentModelInputTokens`
 * 的兜底分支与 `estimateRuntimeEntryTokens` 消费同一份 projection、同一套字符估算，所以
 * 无锚点场景（新会话首压、刚压过还没跑过模型、锚点被 rewind 切除）与改造前完全一致。
 * 别把它改成别的兜底口径——那会同时改掉摘要块和 hook 载荷的数值语义。
 */
export function estimatePreCompactTokenCount(input: {
  entries: readonly RuntimeMessageEntry[];
  useMidConversationSystem?: boolean;
}): number {
  const projection = buildProviderRequestMessages({
    entries: input.entries,
    applyCacheControl: false,
    useMidConversationSystem: input.useMidConversationSystem,
  });
  return estimateCurrentModelInputTokens(projection.messages, projection.sourceEntries);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  return buildProviderRequestMessages({
    entries: [...entriesForSummary, { message: { role: "user" as const, content: compactPrompt } }],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 压缩与 hook 的交互：PreCompact / PostCompact 两条通道的调用、阻断判定与上下文注入。
//
// 这一段独立于上方的摘要与持久化辅助：它实现的是 hook 契约（spec §4.1）与压缩流程的边界，
// 从这里拆出来是为了让 compact-active.ts 只留编排。三处 PostCompact 调用点（skipped /
// completed / failed）语义相同，收敛成 runPostCompactHookPhase，避免改动时漏掉某一条路径。
// ---------------------------------------------------------------------------

/** 被 PreCompact 阻断时的返回形状，与 compactActiveConversation 声明的 outcome 相容。 */
type CompactSkipResult = {
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: "skipped";
  tokenCount: number;
};

type PreCompactHookInput = Parameters<AgentRuntimeInternal["runPreCompactHooks"]>[0];
type PostCompactHookInput = Parameters<AgentRuntimeInternal["runPostCompactHooks"]>[0];

/**
 * PreCompact：可注入上下文，且可阻断。spec §4.1 规定上下文**无论是否阻断**都写入消息历史，
 * 因此注入先于阻断判定；阻断信号有两个来源（blockRequested / preventContinuation），取或。
 */
export async function runPreCompactHookGate(
  runtime: AgentRuntimeInternal,
  input: PreCompactHookInput,
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<{ blocked: boolean }> {
  const result = await runtime.runPreCompactHooks(input, traceContext, abortSignal);
  runtime.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.PreCompact,
    result.additionalContexts,
  );
  return { blocked: Boolean(result.blockRequested || result.preventContinuation) };
}

/** PostCompact：只能观察并注入上下文，不阻断（spec §4.1）。 */
export async function runPostCompactHookPhase(
  runtime: AgentRuntimeInternal,
  input: PostCompactHookInput,
  traceContext: TraceContext,
  abortSignal?: AbortSignal,
): Promise<void> {
  const result = await runtime.runPostCompactHooks(input, traceContext, abortSignal);
  runtime.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.PostCompact,
    result.additionalContexts,
  );
}

/**
 * 被 PreCompact 阻断时按 skipped 落终态并回填 UI。
 * 阻断不是故障：上层 tracker 只记真实 boundary，所以必须显式落一条 skipped，否则界面停在“进行中”。
 */
export async function persistCompactBlockedByHook(
  runtime: AgentRuntimeInternal,
  input: {
    compactTimeline: CompactTimelineContext;
    entries: readonly RuntimeMessageEntry[];
    events: SessionEvent[];
    preCompactTokenCount: number;
    traceContext: TraceContext;
  },
): Promise<CompactSkipResult> {
  const blockedPayload = runtime.buildCompactTimelinePayload(input.compactTimeline, {
    endedAt: Date.now(),
    replace: true,
    status: CompactTimelineStatus.Skipped,
  });
  await persistCompactTimelineEvent(
    runtime,
    SessionEventType.CompactCompleted,
    blockedPayload,
    input.traceContext,
    input.events,
  );
  return {
    displayText: "Compaction blocked by PreCompact hook",
    entries: input.entries,
    outcome: "skipped",
    tokenCount: input.preCompactTokenCount,
  };
}

/**
 * 压缩失败时补发 PostCompact(outcome="failed")。
 *
 * 契约允许 completed|skipped|failed，但过去只有前两者会发射，靠 hook 观察压缩结果的用户
 * 收不到失败信号。这里只在「真实失败」时发射：被取消（Stop / 会话关闭导致的中断）不是失败，
 * 且此刻注入上下文没有意义。
 *
 * hook 自身异常必须吞掉：它不能掩盖原始压缩错误（fail-open 默认），否则用户看到的是
 * hook 的错误而不是压缩失败的原因。
 */
export async function emitPostCompactFailedHook(
  runtime: AgentRuntimeInternal,
  input: {
    abortSignal?: AbortSignal;
    compactTrigger: CompactHookTrigger;
    error: unknown;
    phase: CompactPhase;
    preCompactTokenCount: number;
    turnTraceContext: TraceContext;
  },
): Promise<void> {
  if (isTurnCancellationError(input.error, input.abortSignal)) return;
  try {
    await runPostCompactHookPhase(
      runtime,
      {
        compactTrigger: input.compactTrigger,
        outcome: "failed",
        phase: input.phase,
        preCompactTokenCount: input.preCompactTokenCount,
      },
      input.turnTraceContext,
      input.abortSignal,
    );
  } catch (error) {
    runtime.logger?.warn("PostCompact failure hook threw", {
      ...traceContextToLogContext(input.turnTraceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.post_compact_hook_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

/** hook 事件里的压缩来源必须来自触发路径本身；Partial / SessionMemory 不经过压缩编排。 */
export function compactHookTriggerOf(trigger: CompactTrigger): CompactHookTrigger {
  switch (trigger) {
    case CompactTrigger.Manual:
    case CompactTrigger.Auto:
    case CompactTrigger.Reactive:
    case CompactTrigger.PostTurn:
    case CompactTrigger.ModelDownshift:
      return trigger;
    case CompactTrigger.Partial:
    case CompactTrigger.SessionMemory:
      // 这两条路径不经过 compactActiveConversation；走到这里说明调用方违约。
      // 显式抛错而不是猜一个 hook 值，避免把错误的压缩来源告诉用户 hook。
      throw new Error(`Compact trigger ${trigger} cannot be reported to hooks`);
  }
}
