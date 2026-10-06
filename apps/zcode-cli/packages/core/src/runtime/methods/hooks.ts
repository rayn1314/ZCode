/* oxlint-disable max-lines -- runtime 生命周期/观察类 hook 方法集中维护，拆分前保持单一执行入口。 */
import { HookEventName } from "../deps.js";
import type { HookRunResult, Model, TraceContext, TurnState } from "../deps.js";
import type {
  CompactHookTrigger,
  CompactPhase,
  HookEventName as HookEventNameType,
  SessionId,
  ToolCallId,
} from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";

const MAX_STOP_HOOK_CONTINUATIONS = 3;

const EMPTY_HOOK_RESULT: HookRunResult = {
  additionalContexts: [],
};
const HOOK_CONTEXT_MAX_CHARS = 24_000;
const HOOK_PREVIEW_MAX_CHARS = 4_000;

type SessionStartSource = "startup" | "resume" | "clear" | "compact";

export async function runSessionStartHooks(
  this: AgentRuntimeInternal,
  source: SessionStartSource,
  traceContext: TraceContext,
  signal?: AbortSignal,
  model?: Pick<Model, "providerId" | "modelId">,
): Promise<HookRunResult> {
  if (this.sessionStartHookRan) return EMPTY_HOOK_RESULT;
  await this.workspaceHookAdmission?.activate(source, signal);
  this.sessionStartHookRan = true;
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  const selectedModel = model ?? this.getSessionModelSelection();
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.SessionStart,
      mode: this.getMode(),
      model: selectedModel ? `${selectedModel.providerId}/${selectedModel.modelId}` : undefined,
      sessionId: this.sessionId,
      source,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { matchValue: source, signal },
  );
}

export async function runUserPromptSubmitHooks(
  this: AgentRuntimeInternal,
  prompt: string,
  attachments: TurnState["attachments"] | undefined,
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      attachmentsSummary: summarizeTurnAttachments(attachments),
      cwd: this.workingDirectory,
      hookEventName: HookEventName.UserPromptSubmit,
      mode: this.getMode(),
      prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runStopHooks(
  this: AgentRuntimeInternal,
  response: string,
  toolCallCount: number,
  traceContext: TraceContext,
  signal?: AbortSignal,
  stopHookActive = false,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  const responsePreview = truncateForHook(response, HOOK_PREVIEW_MAX_CHARS);

  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Stop,
      mode: this.getMode(),
      responsePreview,
      responseText: response,
      sessionId: this.sessionId,
      stopHookActive,
      timestamp: new Date().toISOString(),
      toolCallCount,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runPreCompactHooks(
  this: AgentRuntimeInternal,
  input: {
    compactTrigger: CompactHookTrigger;
    phase?: CompactPhase;
    preCompactTokenCount?: number;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      compactTrigger: input.compactTrigger,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.PreCompact,
      mode: this.getMode(),
      phase: input.phase,
      preCompactTokenCount: input.preCompactTokenCount,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      trigger: input.compactTrigger,
      turnId: traceContext.turnId,
    },
    { matchValue: input.compactTrigger, signal },
  );
}

export async function runPostCompactHooks(
  this: AgentRuntimeInternal,
  input: {
    boundaryId?: string;
    compactTrigger: CompactHookTrigger;
    outcome: "completed" | "skipped" | "failed";
    phase?: CompactPhase;
    postCompactTokenCount?: number;
    preCompactTokenCount?: number;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      boundaryId: input.boundaryId,
      compactTrigger: input.compactTrigger,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.PostCompact,
      mode: this.getMode(),
      outcome: input.outcome,
      phase: input.phase,
      postCompactTokenCount: input.postCompactTokenCount,
      preCompactTokenCount: input.preCompactTokenCount,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      trigger: input.compactTrigger,
      turnId: traceContext.turnId,
    },
    { matchValue: input.compactTrigger, signal },
  );
}

export async function runSubagentStartHooks(
  this: AgentRuntimeInternal,
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
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentId: input.agentId,
      agentName: this.config.agentName,
      agentType: input.agentType,
      childSessionId: input.childSessionId,
      cwd: this.workingDirectory,
      description: input.description,
      hookEventName: HookEventName.SubagentStart,
      mode: this.getMode(),
      model: input.model,
      parentToolCallId: input.parentToolCallId,
      prompt: input.prompt,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runSubagentStopHooks(
  this: AgentRuntimeInternal,
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
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentId: input.agentId,
      agentName: this.config.agentName,
      agentType: input.agentType,
      childSessionId: input.childSessionId,
      cwd: this.workingDirectory,
      description: input.description,
      error: input.error,
      hookEventName: HookEventName.SubagentStop,
      mode: this.getMode(),
      parentToolCallId: input.parentToolCallId,
      sessionId: this.sessionId,
      status: input.status,
      timestamp: new Date().toISOString(),
      totalDurationMs: input.totalDurationMs,
      totalToolUseCount: input.totalToolUseCount,
      totalTokens: input.totalTokens,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runSessionEndHooks(
  this: AgentRuntimeInternal,
  input: { endReason?: string },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      endReason: input.endReason,
      hookEventName: HookEventName.SessionEnd,
      mode: this.getMode(),
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runPermissionDeniedHooks(
  this: AgentRuntimeInternal,
  input: {
    toolName: string;
    toolCallId: string;
    reason?: string;
    inputSummary?: string;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.PermissionDenied,
      inputSummary: input.inputSummary,
      mode: this.getMode(),
      reason: input.reason,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runPostToolBatchHooks(
  this: AgentRuntimeInternal,
  input: {
    toolCallIds: (string | ToolCallId)[];
    successCount: number;
    errorCount: number;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      errorCount: input.errorCount,
      hookEventName: HookEventName.PostToolBatch,
      mode: this.getMode(),
      sessionId: this.sessionId,
      successCount: input.successCount,
      timestamp: new Date().toISOString(),
      toolCallIds: input.toolCallIds,
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runNotificationHooks(
  this: AgentRuntimeInternal,
  input: {
    notification: string;
    notificationType?: string;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.Notification,
      mode: this.getMode(),
      notification: input.notification,
      notificationType: input.notificationType,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runPreModelSwitchHooks(
  this: AgentRuntimeInternal,
  input: {
    previousModel?: string;
    model?: string;
    reason?: string;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.PreModelSwitch,
      model: input.model,
      mode: this.getMode(),
      previousModel: input.previousModel,
      reason: input.reason,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export async function runPostModelSwitchHooks(
  this: AgentRuntimeInternal,
  input: {
    previousModel?: string;
    model?: string;
    reason?: string;
  },
  traceContext: TraceContext,
  signal?: AbortSignal,
): Promise<HookRunResult> {
  if (!this.hookRunner) return EMPTY_HOOK_RESULT;
  return this.hookRunner.run(
    {
      agentName: this.config.agentName,
      cwd: this.workingDirectory,
      hookEventName: HookEventName.PostModelSwitch,
      model: input.model,
      mode: this.getMode(),
      previousModel: input.previousModel,
      reason: input.reason,
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      traceId: traceContext.traceId,
      turnId: traceContext.turnId,
    },
    { signal },
  );
}

export function injectHookAdditionalContextIntoMessageHistory(
  this: AgentRuntimeInternal,
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): RuntimeMessageEntry | undefined {
  if (additionalContexts.length === 0) return undefined;
  const entry = systemReminderAttachmentEntry(
    "hook_context",
    formatLifecycleHookAdditionalContextBody(eventName, additionalContexts),
  );
  this.messageHistory.addEntries([entry]);
  return entry;
}

export function shouldContinueAfterStopHooks(
  result: HookRunResult,
  continuationCount: number,
): boolean {
  return (
    result.stopShouldContinue === true &&
    result.additionalContexts.length > 0 &&
    continuationCount < MAX_STOP_HOOK_CONTINUATIONS
  );
}

function formatLifecycleHookAdditionalContextBody(
  eventName: HookEventNameType,
  additionalContexts: readonly string[],
): string {
  const body = additionalContexts.map((context, index) => `#${index + 1}\n${context}`).join("\n\n");
  return truncateForHook(
    [`${eventName} hook additional context: `, body].join("\n"),
    HOOK_CONTEXT_MAX_CHARS,
  );
}

function summarizeTurnAttachments(
  attachments: TurnState["attachments"] | undefined,
): string | undefined {
  if (!attachments || attachments.length === 0) return undefined;

  return attachments
    .map((attachment, index) => {
      if (attachment.path) return `${index + 1}:${attachment.type}:${attachment.path}`;
      if (attachment.content)
        return `${index + 1}:${attachment.type}:inline:${attachment.content.length} chars`;
      return `${index + 1}:${attachment.type}`;
    })
    .join("\n");
}

function truncateForHook(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}...`;
}
