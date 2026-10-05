import type { HookRunResult, Model, TraceContext, TurnState } from "./deps.js";
import type { HookEventName, SessionId, ToolCallId } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";

// 从 internal-methods.ts 拆出，避免该文件越过
// 400 行边界（runtime-module-boundary 测试），hooks 一组方法自成一段，单独成文件。
export interface AgentRuntimeHookMethods {
  runSessionStartHooks(
    source: "startup" | "resume" | "clear" | "compact",
    traceContext: TraceContext,
    signal?: AbortSignal,
    model?: Pick<Model, "providerId" | "modelId">,
  ): Promise<HookRunResult>;
  runUserPromptSubmitHooks(
    prompt: string,
    attachments: TurnState["attachments"] | undefined,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runStopHooks(
    response: string,
    toolCallCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
    stopHookActive?: boolean,
  ): Promise<HookRunResult>;
  runPreCompactHooks(
    input: {
      compactTrigger: "manual" | "auto" | "reactive";
      preCompactTokenCount?: number;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runPostCompactHooks(
    input: {
      boundaryId?: string;
      compactTrigger: "manual" | "auto" | "reactive";
      outcome: "completed" | "skipped" | "failed";
      postCompactTokenCount?: number;
      preCompactTokenCount?: number;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runSubagentStartHooks(
    input: {
      agentId: string;
      agentType: string;
      childSessionId: SessionId;
      description?: string;
      model?: string;
      parentToolCallId?: string;
      prompt: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runSubagentStopHooks(
    input: {
      agentId: string;
      agentType: string;
      childSessionId: SessionId;
      description?: string;
      error?: string;
      parentToolCallId?: string;
      status: "completed" | "failed" | "stopped";
      totalDurationMs?: number;
      totalToolUseCount?: number;
      totalTokens?: number;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runSessionEndHooks(
    input: { endReason?: string },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runPermissionDeniedHooks(
    input: {
      toolName: string;
      toolCallId: string;
      reason?: string;
      inputSummary?: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runPostToolBatchHooks(
    input: {
      toolCallIds: (string | ToolCallId)[];
      successCount: number;
      errorCount: number;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runNotificationHooks(
    input: {
      notification: string;
      notificationType?: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runPreModelSwitchHooks(
    input: {
      previousModel?: string;
      model?: string;
      reason?: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runPostModelSwitchHooks(
    input: {
      previousModel?: string;
      model?: string;
      reason?: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  injectHookAdditionalContextIntoMessageHistory(
    eventName: HookEventName,
    additionalContexts: readonly string[],
  ): RuntimeMessageEntry | undefined;
  shouldContinueAfterStopHooks(result: HookRunResult, continuationCount: number): boolean;
}
