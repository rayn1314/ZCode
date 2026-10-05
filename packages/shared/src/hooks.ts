import type { SettingsDirectoryLocation } from "./settings-source.js";
import type { WorkspaceHookReviewTrustState } from "./zcode-protocol-v4/workspace-hook-review.js";

/**
 * 事件单一来源（spec: core/spec/hook-framework-expansion.md §5）。
 * 本模块被根 workspace（ui/services/shared）与 CLI workspace（contracts/adapters/core）
 * 同时消费，因此必须浏览器安全、零运行时依赖：只放纯字符串常量与纯数据描述符，
 * 不放 zod、不放 node:*。
 */
export const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;

export type HookEvent = (typeof HOOK_EVENT_NAMES)[number];

export interface HookEventDescriptor {
  /** matcher 的匹配维度（P0 为元数据，不接引擎，见 spec D5）。 */
  matcherKind: "toolName" | "sessionSource" | "compactTrigger" | "subagent" | "none";
  /** 是否可阻断（P0 为元数据，不接引擎）。 */
  blockable: boolean;
  /** 是否支持注入 additionalContext（P0 为元数据，不接引擎）。 */
  injectsContext: boolean;
  /** 设置页事件下拉的 i18n key。 */
  labelKey: string;
}

export const HOOK_EVENT_DESCRIPTORS: Record<HookEvent, HookEventDescriptor> = {
  SessionStart: {
    matcherKind: "sessionSource",
    blockable: false,
    injectsContext: true,
    labelKey: "settings.hooks.event.sessionStart",
  },
  UserPromptSubmit: {
    matcherKind: "none",
    blockable: true,
    injectsContext: true,
    labelKey: "settings.hooks.event.userPromptSubmit",
  },
  PreToolUse: {
    matcherKind: "toolName",
    blockable: true,
    injectsContext: true,
    labelKey: "settings.hooks.event.preToolUse",
  },
  PermissionRequest: {
    matcherKind: "toolName",
    blockable: true,
    injectsContext: true,
    labelKey: "settings.hooks.event.permissionRequest",
  },
  PostToolUse: {
    matcherKind: "toolName",
    blockable: false,
    injectsContext: true,
    labelKey: "settings.hooks.event.postToolUse",
  },
  PostToolUseFailure: {
    matcherKind: "toolName",
    blockable: false,
    injectsContext: true,
    labelKey: "settings.hooks.event.postToolUseFailure",
  },
  Stop: {
    matcherKind: "none",
    blockable: false,
    injectsContext: true,
    labelKey: "settings.hooks.event.stop",
  },
};

export type HookType = "command" | "process";

export interface HookConfiguredState {
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  sourcePath: string;
}

export interface WorkspaceHookDiscoveryState extends HookConfiguredState {
  reviewItemId: string;
  workspaceIdentity: string;
  bundleDigest: string;
  hookDeclarationDigest: string;
  sourceFileIndex: number;
  /** Read-only Settings evaluation; a live Runtime review projection overrides this value. */
  trustState?: WorkspaceHookReviewTrustState;
}

export interface Hook {
  id: string;
  event: HookEvent;
  matcher?: string;
  type: HookType;
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  enabled: boolean;
  editable?: boolean;
  configuredState?: HookConfiguredState;
  workspaceHook?: WorkspaceHookDiscoveryState;
  custom?: Record<string, unknown>;
  location?: SettingsDirectoryLocation;
}

export interface HookConfig {
  event: HookEvent;
  matcher?: string;
  type: HookType;
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  statusMessage?: string;
  timeout?: number;
  enabled?: boolean;
  custom?: Record<string, unknown>;
  storageLevel?: "user" | "project";
}

/**
 * Metadata for hook identification in tool calls.
 * Used in both chat-panel.types.ts and conversationStore.ts.
 */
export interface ToolCallHookMeta {
  isHook?: boolean;
  hookEvent?: string;
  hookCommand?: string;
  hookMatcher?: string;
  hookToolName?: string;
  hookExitCode?: number | null;
  hookError?: string;
  hookStdout?: string;
  hookName?: string;
  hookFeedback?: string;
  hookStderr?: string;
  /** Skill-related metadata */
  "zcode/isSkill"?: boolean;
  "zcode/skillName"?: string;
  [key: string]: unknown;
}
