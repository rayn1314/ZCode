import type {
  ExecutionPort,
  HookEventName,
  HookExecutionDescriptor,
  HookInput,
  HookJSONOutput,
  HookPermissionDecision,
  HookSourceKind,
  HooksRuntimeConfig,
  Logger,
  McpPort,
  PermissionRequestHookDecision,
  SessionEvent,
  WorkspaceHookBundleSnapshot,
} from "@zcode/contracts";

import type { WorkspaceHookRuntimeAdmissionPort } from "./workspace-hook-runtime-admission.js";

export interface HookCallbackContext {
  hookIndex: number;
  signal?: AbortSignal;
}

/**
 * 配置 Hook 的执行器可以附带 stderr 等诊断；这些信息只进入生命周期事件，
 * 不参与 Hook 决策，也不会作为 Hook JSON 输出暴露给模型。
 */
export interface HookCallbackDiagnostics {
  errorMessage?: string;
  stderrPreview?: string;
  stdoutPreview?: string;
}

export interface HookCallbackResult {
  kind: "hookCallbackResult";
  diagnostics?: HookCallbackDiagnostics;
  output?: HookJSONOutput;
}

export type HookCallback = (
  input: HookInput,
  context: HookCallbackContext,
) =>
  | HookJSONOutput
  | HookCallbackResult
  | void
  | Promise<HookJSONOutput | HookCallbackResult | void>;

export interface HookRunAdmissionDecision {
  allowed: boolean;
  reasonCode?: string;
  skipLifecycle?: boolean;
}

export interface HookRegistration {
  admission?: (input: HookInput) => HookRunAdmissionDecision;
  async?: boolean;
  callback: HookCallback;
  descriptor?: HookExecutionDescriptor | ((input: HookInput) => HookExecutionDescriptor);
  event: HookEventName;
  /** 同一会话内只执行一次（P3）：以 source 为身份键，执行后（成功或失败）不再触发。 */
  once?: boolean;
  /** 失败时按事件可阻断性转化为阻断（P3）：仅对 blockable 事件生效，默认 fail-open。 */
  failClosed?: boolean;
  matcher?: string;
  source?: string;
  sourceKind?: HookSourceKind;
  timeoutMs?: number;
}

export interface HookRunOptions {
  matchValue?: string;
  matchValues?: readonly string[];
  signal?: AbortSignal;
}

export interface HookRunResult {
  additionalContexts: string[];
  blockRequested?: boolean;
  hookPermissionDecisionReason?: string;
  permissionBehavior?: HookPermissionDecision;
  permissionRequestResult?: PermissionRequestHookDecision;
  preventContinuation?: boolean;
  stopShouldContinue?: boolean;
  stopReason?: string;
  updatedInput?: unknown;
  /** PostToolUse hook 改写后的工具输出（P3），由 tool executor 写回模型消费内容。 */
  updatedToolOutput?: unknown;
}

export interface HookRunner {
  run(input: HookInput, options?: HookRunOptions): Promise<HookRunResult>;
}

export interface HookRunnerOptions {
  defaultTimeoutMs?: number;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  hooks?: HookRegistration[];
  logger?: Logger;
}

export interface ConfiguredHookRunnerOptions {
  config: HooksRuntimeConfig;
  emitEvent?: (event: SessionEvent) => Promise<void>;
  executionPort: ExecutionPort;
  getWorkingDirectory: () => string;
  logger?: Logger;
  /** mcp_tool hook 通过 runtime 的 MCP port 执行工具调用（spec §10.2）。 */
  mcpPort?: McpPort;
  workspaceHookAdmission?: WorkspaceHookRuntimeAdmissionPort;
  workspaceHookSnapshot?: WorkspaceHookBundleSnapshot;
}
