import { z } from "zod";
import type { HookEvent } from "@zcode/shared";
import type { ModelToolSideEffectScope } from "../model/index.js";
import type { CollaborationMode, RiskLevel } from "../interfaces/session.port.js";
import type { PermissionUpdate } from "../interfaces/permission.port.js";
import type { SessionId, ToolCallId, TraceId, TurnId } from "../interfaces/shared.js";

// 类型级穷尽守卫（spec §5.3）：断言 HookInput/HookSpecificOutput 的事件键集合
// 与事件单源 HOOK_EVENT_NAMES 完全一致。side-effect import 让断言进入编译。
import "./event-exhaustiveness.js";

// 事件键派生自 @zcode/shared 的 HookEvent（单源）；satisfies 保证新增事件时此处缺键即编译报错。
export const HookEventName = {
  SessionStart: "SessionStart",
  UserPromptSubmit: "UserPromptSubmit",
  PreToolUse: "PreToolUse",
  PermissionRequest: "PermissionRequest",
  PostToolUse: "PostToolUse",
  PostToolUseFailure: "PostToolUseFailure",
  Stop: "Stop",
  PreCompact: "PreCompact",
  PostCompact: "PostCompact",
  SubagentStart: "SubagentStart",
  SubagentStop: "SubagentStop",
  SessionEnd: "SessionEnd",
  PermissionDenied: "PermissionDenied",
  PostToolBatch: "PostToolBatch",
  Notification: "Notification",
  PreModelSwitch: "PreModelSwitch",
  PostModelSwitch: "PostModelSwitch",
} as const satisfies Record<HookEvent, string>;

export type HookEventName = (typeof HookEventName)[keyof typeof HookEventName];

export const HookOutcome = {
  Success: "success",
  Blocked: "blocked",
  Failed: "failed",
  Cancelled: "cancelled",
  TimedOut: "timed_out",
} as const;

export type HookOutcome = (typeof HookOutcome)[keyof typeof HookOutcome];

export const HookSourceKind = {
  User: "user",
  Plugin: "plugin",
  Project: "project",
  Internal: "internal",
} as const;

export type HookSourceKind = (typeof HookSourceKind)[keyof typeof HookSourceKind];

/** Runtime-only provenance attached after user/plugin config validation. */
export interface HookConfigSource {
  kind: "user" | "project" | "internal";
  path?: string;
}

/** Client-safe metadata. Unredacted commands and execution IO must never be added here. */
export interface HookExecutionDescriptor {
  clientVisible: boolean;
  sourceKind: HookSourceKind;
  sourcePath?: string;
  pluginId?: string;
  pluginName?: string;
  statusMessage?: string;
  executionType: "process" | "command" | "http" | "mcp_tool";
  executionMode: "foreground" | "background";
  commandDisplay: string;
  timeoutMs: number;
}

export const HookPermissionDecision = {
  Allow: "allow",
  Ask: "ask",
  Deny: "deny",
} as const;

export type HookPermissionDecision =
  (typeof HookPermissionDecision)[keyof typeof HookPermissionDecision];

export interface BaseHookInput {
  agentName?: string;
  cwd: string;
  hookEventName: HookEventName;
  mode: CollaborationMode;
  sessionId: SessionId;
  timestamp: string;
  traceId: TraceId;
  turnId?: TurnId;
}

export interface PreToolUseHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreToolUse;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface PermissionRequestHookInput extends BaseHookInput {
  permissionSuggestions?: PermissionUpdate[];
  hookEventName: typeof HookEventName.PermissionRequest;
  reason: string;
  requestId: string;
  riskLevel: RiskLevel;
  sideEffectScope?: ModelToolSideEffectScope;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface PostToolUseHookInput extends BaseHookInput {
  artifactRefs?: string[];
  hookEventName: typeof HookEventName.PostToolUse;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
  toolResponse: unknown;
  toolResultPreview: string;
}

export interface PostToolUseFailureHookInput extends BaseHookInput {
  error: {
    message: string;
    type: string;
  };
  hookEventName: typeof HookEventName.PostToolUseFailure;
  isInterrupt?: boolean;
  toolCallId: ToolCallId | string;
  toolInput: unknown;
  toolName: string;
}

export interface UserPromptSubmitHookInput extends BaseHookInput {
  attachmentsSummary?: string;
  hookEventName: typeof HookEventName.UserPromptSubmit;
  prompt: string;
}

export interface SessionStartHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.SessionStart;
  model?: string;
  source: "startup" | "resume" | "clear" | "compact";
}

export interface StopHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.Stop;
  responsePreview: string;
  responseText?: string;
  stopHookActive: boolean;
  toolCallCount: number;
}

export interface PreCompactHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreCompact;
  /** 压缩触发来源：manual（用户/命令）/ auto（上下文策略）/ reactive（溢出后响应式）。 */
  compactTrigger: "manual" | "auto" | "reactive";
  /** 压缩前的预估 token 数（可能尚未完成精确统计）。 */
  preCompactTokenCount?: number;
}

export interface PostCompactHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PostCompact;
  compactTrigger: "manual" | "auto" | "reactive";
  outcome: "completed" | "skipped" | "failed";
  boundaryId?: string;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
}

export interface SubagentStartHookInput extends BaseHookInput {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  description?: string;
  prompt: string;
  parentToolCallId?: string;
  /** providerId/modelId 展示串，与 SessionStartHookInput.model 一致。 */
  model?: string;
  hookEventName: typeof HookEventName.SubagentStart;
}

export interface SubagentStopHookInput extends BaseHookInput {
  agentId: string;
  agentType: string;
  childSessionId: SessionId;
  description?: string;
  parentToolCallId?: string;
  status: "completed" | "failed" | "stopped";
  totalDurationMs?: number;
  totalToolUseCount?: number;
  totalTokens?: number;
  error?: string;
  hookEventName: typeof HookEventName.SubagentStop;
}

export interface SessionEndHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.SessionEnd;
  endReason?: string;
}

export interface PermissionDeniedHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PermissionDenied;
  toolName: string;
  toolCallId: ToolCallId | string;
  reason?: string;
  inputSummary?: string;
}

export interface PostToolBatchHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PostToolBatch;
  toolCallIds: (ToolCallId | string)[];
  successCount: number;
  errorCount: number;
}

export interface NotificationHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.Notification;
  /** 通知文本（面向模型的后台任务/子代理通知）。 */
  notification: string;
  /** 通知来源类型，如 "background_task" | "subagent" | "permission" | "error"。 */
  notificationType?: string;
}

export interface PreModelSwitchHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PreModelSwitch;
  previousModel?: string;
  model?: string;
  reason?: string;
}

export interface PostModelSwitchHookInput extends BaseHookInput {
  hookEventName: typeof HookEventName.PostModelSwitch;
  previousModel?: string;
  model?: string;
  reason?: string;
}

export type HookInput =
  | PreToolUseHookInput
  | PermissionRequestHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | StopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | SessionEndHookInput
  | PermissionDeniedHookInput
  | PostToolBatchHookInput
  | NotificationHookInput
  | PreModelSwitchHookInput
  | PostModelSwitchHookInput;

export type PermissionRequestHookDecision =
  | {
      behavior: "allow";
      permissionUpdates?: PermissionUpdate[];
      updatedPermissions?: PermissionUpdate[];
      updatedInput?: unknown;
    }
  | {
      behavior: "deny";
      interrupt?: boolean;
      message?: string;
    };

export type HookSpecificOutput =
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PreToolUse;
      permissionDecision?: HookPermissionDecision;
      permissionDecisionReason?: string;
      updatedInput?: unknown;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.UserPromptSubmit;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.SessionStart;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolUse;
      /** PostToolUse 专属：允许 hook 改写工具输出（P3 协议补全）。 */
      updatedToolOutput?: unknown;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolUseFailure;
    }
  | {
      decision?: PermissionRequestHookDecision;
      hookEventName: typeof HookEventName.PermissionRequest;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.Stop;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PreCompact;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostCompact;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.SubagentStart;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.SubagentStop;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.SessionEnd;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PermissionDenied;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostToolBatch;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.Notification;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PreModelSwitch;
    }
  | {
      additionalContext?: string;
      hookEventName: typeof HookEventName.PostModelSwitch;
    };

export interface HookJSONOutput {
  additionalContext?: string;
  additional_context?: string;
  continue?: boolean;
  decision?: "approve" | "block";
  hookSpecificOutput?: HookSpecificOutput;
  reason?: string;
  stopReason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  /** 顶层兼容字段（P3）：等价于 hookSpecificOutput.updatedToolOutput（PostToolUse）。 */
  updatedToolOutput?: unknown;
}

const PermissionRequestHookDecisionSchema = z.union([
  z.object({
    behavior: z.literal("allow"),
    permissionUpdates: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedPermissions: z
      .array(
        z.object({
          type: z.literal("addRules"),
          behavior: z.enum(["allow", "deny", "ask"]),
          rules: z.array(
            z.object({
              toolName: z.string().min(1),
              ruleContent: z.string().optional(),
            }),
          ),
        }),
      )
      .optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    behavior: z.literal("deny"),
    interrupt: z.boolean().optional(),
    message: z.string().optional(),
  }),
]);

export const HookSpecificOutputSchema = z.discriminatedUnion("hookEventName", [
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PreToolUse),
    permissionDecision: z.enum(["allow", "ask", "deny"]).optional(),
    permissionDecisionReason: z.string().optional(),
    updatedInput: z.unknown().optional(),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.UserPromptSubmit),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.SessionStart),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolUse),
    updatedToolOutput: z.unknown().optional(),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolUseFailure),
  }),
  z.object({
    decision: PermissionRequestHookDecisionSchema.optional(),
    hookEventName: z.literal(HookEventName.PermissionRequest),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.Stop),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PreCompact),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostCompact),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.SubagentStart),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.SubagentStop),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.SessionEnd),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PermissionDenied),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostToolBatch),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.Notification),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PreModelSwitch),
  }),
  z.object({
    additionalContext: z.string().optional(),
    hookEventName: z.literal(HookEventName.PostModelSwitch),
  }),
]);

export const HookJSONOutputSchema = z.object({
  additionalContext: z.string().optional(),
  additional_context: z.string().optional(),
  continue: z.boolean().optional(),
  decision: z.enum(["approve", "block"]).optional(),
  hookSpecificOutput: HookSpecificOutputSchema.optional(),
  reason: z.string().optional(),
  stopReason: z.string().optional(),
  suppressOutput: z.boolean().optional(),
  systemMessage: z.string().optional(),
  updatedToolOutput: z.unknown().optional(),
});

export interface HookPluginContext {
  dataPath: string;
  id: string;
  name: string;
  rootPath: string;
  /** Actual hooks.json/manifest source. Other plugin consumers may omit it. */
  sourcePath?: string;
}

export interface HookCommandConfig {
  async?: boolean;
  command: string;
  enabled?: boolean;
  failClosed?: boolean;
  once?: boolean;
  plugin?: HookPluginContext;
  shell?: true | string;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeout?: number;
  timeoutMs?: number;
  type: "command";
}

export interface HookProcessConfig {
  args?: string[];
  command: string;
  enabled?: boolean;
  failClosed?: boolean;
  once?: boolean;
  plugin?: HookPluginContext;
  /** Runtime-only provenance; the public config schema deliberately strips this field. */
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  type: "process";
}

export interface HookHttpConfig {
  allowedEnvVars?: string[];
  allowPrivateNetwork?: boolean;
  body?: string;
  /** 兼容既有 HookConfig.command 读取路径：http 的 url 也暴露为 command。 */
  command: string;
  enabled?: boolean;
  failClosed?: boolean;
  headers?: Record<string, string>;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  once?: boolean;
  plugin?: HookPluginContext;
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  type: "http";
  url?: string;
}

export interface HookMcpToolConfig {
  /** 兼容既有 HookConfig.command 读取路径：mcp_tool 的 tool 也暴露为 command。 */
  command: string;
  enabled?: boolean;
  failClosed?: boolean;
  input?: Record<string, unknown>;
  once?: boolean;
  plugin?: HookPluginContext;
  server: string;
  source?: HookConfigSource;
  statusMessage?: string;
  timeoutMs?: number;
  tool: string;
  type: "mcp_tool";
}

export type HookConfig = HookCommandConfig | HookProcessConfig | HookHttpConfig | HookMcpToolConfig;

export interface HookMatcherConfig {
  hooks: HookConfig[];
  matcher?: string;
}

export interface HooksRuntimeConfig {
  enabled: boolean;
  events: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes: number;
  timeoutMs: number;
}

export interface HooksRuntimeConfigPatch {
  enabled?: boolean;
  events?: Partial<Record<HookEventName, HookMatcherConfig[]>>;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface HookRunLifecyclePayload {
  agentName?: string;
  /** New events always carry this; optional keeps old persisted events replayable. */
  descriptor?: HookExecutionDescriptor;
  /** Sanitized human-readable reason when the Hook itself blocked execution. */
  blockReason?: string;
  durationMs?: number;
  errorCode?: string;
  errorMessage?: string;
  hookEventName: HookEventName;
  hookIndex: number;
  hookCount?: number;
  hookInvocationId?: string;
  hookRunId: string;
  hookSource?: string;
  matcher?: string;
  outcome?: HookOutcome;
  outputBytes?: number;
  requestId?: string;
  startedAt?: number;
  stderrPreview?: string;
  stdoutPreview?: string;
  toolCallId?: ToolCallId | string;
  toolName?: string;
  truncated?: boolean;
}

export const HookProcessConfigSchema = z.object({
  type: z.literal("process"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  args: z.array(z.string()).optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  failClosed: z.boolean().optional(),
});

export const HookCommandConfigSchema = z.object({
  type: z.literal("command"),
  command: z.string().min(1),
  enabled: z.boolean().optional(),
  async: z.boolean().optional(),
  shell: z.union([z.literal(true), z.string().min(1)]).optional(),
  timeout: z.number().positive().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  failClosed: z.boolean().optional(),
});

export const HookHttpConfigSchema = z.object({
  type: z.literal("http"),
  url: z.string().url(),
  enabled: z.boolean().optional(),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  allowedEnvVars: z.array(z.string()).optional(),
  body: z.string().optional(),
  allowPrivateNetwork: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  failClosed: z.boolean().optional(),
});

export const HookMcpToolConfigSchema = z.object({
  type: z.literal("mcp_tool"),
  server: z.string().min(1),
  tool: z.string().min(1),
  input: z.record(z.string(), z.unknown()).optional(),
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  statusMessage: z.string().optional(),
  once: z.boolean().optional(),
  failClosed: z.boolean().optional(),
});

export const HookConfigSchema = z.discriminatedUnion("type", [
  HookProcessConfigSchema,
  HookCommandConfigSchema,
  HookHttpConfigSchema,
  HookMcpToolConfigSchema,
]);

export const HookMatcherConfigSchema = z.object({
  matcher: z.string().optional(),
  hooks: z.array(HookConfigSchema).min(1),
});

// 事件键映射：每个键显式写出，用 satisfies Record<HookEvent, z.ZodTypeAny> 保住字面量键与穷尽性。
// 新增事件时此映射缺键即编译报错（spec §5.2）。
const hooksRuntimeEventsMap = {
  SessionStart: z.array(HookMatcherConfigSchema).optional(),
  UserPromptSubmit: z.array(HookMatcherConfigSchema).optional(),
  PreToolUse: z.array(HookMatcherConfigSchema).optional(),
  PermissionRequest: z.array(HookMatcherConfigSchema).optional(),
  PostToolUse: z.array(HookMatcherConfigSchema).optional(),
  PostToolUseFailure: z.array(HookMatcherConfigSchema).optional(),
  Stop: z.array(HookMatcherConfigSchema).optional(),
  PreCompact: z.array(HookMatcherConfigSchema).optional(),
  PostCompact: z.array(HookMatcherConfigSchema).optional(),
  SubagentStart: z.array(HookMatcherConfigSchema).optional(),
  SubagentStop: z.array(HookMatcherConfigSchema).optional(),
  SessionEnd: z.array(HookMatcherConfigSchema).optional(),
  PermissionDenied: z.array(HookMatcherConfigSchema).optional(),
  PostToolBatch: z.array(HookMatcherConfigSchema).optional(),
  Notification: z.array(HookMatcherConfigSchema).optional(),
  PreModelSwitch: z.array(HookMatcherConfigSchema).optional(),
  PostModelSwitch: z.array(HookMatcherConfigSchema).optional(),
} satisfies Record<HookEvent, z.ZodTypeAny>;

export const HooksRuntimeConfigPatchSchema = z.object({
  enabled: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  maxOutputBytes: z.number().int().positive().optional(),
  events: z.object(hooksRuntimeEventsMap).strict().optional(),
});

export const DefaultHooksRuntimeConfig: HooksRuntimeConfig = {
  enabled: false,
  events: {},
  maxOutputBytes: 32768,
  timeoutMs: 60000,
};

export * from "./workspace-hook-trust.js";
export * from "./workspace-hook-trust-store.js";
