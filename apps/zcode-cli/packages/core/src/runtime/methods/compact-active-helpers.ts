import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
} from "../deps.js";
import type {
  CompactTimelinePayload,
  SessionEvent,
  SessionEventType,
  TraceContext,
} from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type { RuntimeModelTextResult, RunModelTextRequestOptions } from "../types.js";
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
