import {
  HookEventName,
  type CanonicalWorkspaceHookEntry,
  type HookConfig,
  type HookSourceKind,
  type HookMatcherConfig,
} from "@zcode/contracts";
import { resolveWorkspaceHookMaxOutputBytes } from "@zcode/shared/workspace-hook-discovery";
import { expandPluginVariables, resolveHookTimeoutMs } from "./configured-runner-input.js";
import { createHookExecutionDescriptor } from "./display-metadata.js";
import { InMemoryHookRunner } from "./runner.js";
import { createConfiguredHookCallback } from "./configured-runner-callback.js";
import type { ConfiguredHookRunnerOptions, HookRegistration, HookRunner } from "./types.js";

export function createConfiguredHookRunner(
  options: ConfiguredHookRunnerOptions,
): HookRunner | undefined {
  const configuredHooks = options.config.enabled ? createConfiguredHookRegistrations(options) : [];
  const workspaceHooks = createWorkspaceHookRegistrations(options);
  const hooks = insertWorkspaceHooks(configuredHooks, workspaceHooks);
  if (hooks.length === 0) return undefined;
  return new InMemoryHookRunner({
    defaultTimeoutMs: options.config.timeoutMs,
    emitEvent: options.emitEvent,
    hooks,
    logger: options.logger,
  });
}

function createConfiguredHookRegistrations(
  options: ConfiguredHookRunnerOptions,
): HookRegistration[] {
  const registrations: HookRegistration[] = [];

  for (const [eventName, matcherConfigs] of Object.entries(options.config.events)) {
    const event = eventName as HookEventName;
    for (const [matcherIndex, matcherConfig] of (matcherConfigs ?? []).entries()) {
      registrations.push(
        ...createHookRegistrationsForMatcher(options, event, matcherConfig, matcherIndex),
      );
    }
  }

  return registrations;
}

function createHookRegistrationsForMatcher(
  options: ConfiguredHookRunnerOptions,
  event: HookEventName,
  matcherConfig: HookMatcherConfig,
  matcherIndex: number,
): HookRegistration[] {
  return matcherConfig.hooks.flatMap((hook, hookIndex) => {
    if (hook.enabled === false) return [];
    return [
      createHookRegistration({
        event,
        hook,
        hookIndex,
        matcher: matcherConfig.matcher,
        matcherIndex,
        maxOutputBytes: resolveWorkspaceHookMaxOutputBytes(options.config.maxOutputBytes),
        options,
        source: hook.plugin
          ? `plugin.${hook.plugin.id}.${event}.${matcherIndex}.${hookIndex}`
          : `config.${event}.${matcherIndex}.${hookIndex}`,
        sourceKind: hook.plugin ? "plugin" : (hook.source?.kind ?? "internal"),
        timeoutMs: resolveHookTimeoutMs(hook, options.config.timeoutMs),
      }),
    ];
  });
}

function createWorkspaceHookRegistrations(
  options: ConfiguredHookRunnerOptions,
): HookRegistration[] {
  const { workspaceHookAdmission: admission, workspaceHookSnapshot: snapshot } = options;
  if (!admission || !snapshot) return [];
  return snapshot.hooks.flatMap((entry) => {
    const hook = workspaceEntryToHookConfig(snapshot, entry);
    return [
      createHookRegistration({
        admission: () =>
          admission.evaluateDispatch({
            hookDeclarationDigest: entry.hookDeclarationDigest,
            reviewItemId: entry.reviewItemId,
          }),
        event: entry.event,
        hook,
        hookIndex: entry.hookIndex,
        matcher: entry.matcher ?? undefined,
        matcherIndex: entry.matcherIndex,
        maxOutputBytes: entry.resolvedMaxOutputBytes,
        options,
        source: `project.${entry.reviewItemId}`,
        sourceKind: "project",
        timeoutMs: entry.resolvedTimeoutMs,
      }),
    ];
  });
}

/**
 * canonical workspace hook entry 的 http/mcp_tool 扩展字段（shared/workspace-hook-digest.ts
 * 已透传；contracts 的 canonical schema 由并行代理同步）。宽接口保留全部字段，
 * 避免依赖 contracts 判别联合的落地顺序。
 */
interface CanonicalWorkspaceHookEntryLike {
  reviewItemId: CanonicalWorkspaceHookEntry["reviewItemId"];
  event: CanonicalWorkspaceHookEntry["event"];
  matcherIndex: CanonicalWorkspaceHookEntry["matcherIndex"];
  hookIndex: CanonicalWorkspaceHookEntry["hookIndex"];
  sourceFileIndex: CanonicalWorkspaceHookEntry["sourceFileIndex"];
  sourceRelativePath: CanonicalWorkspaceHookEntry["sourceRelativePath"];
  matcher: CanonicalWorkspaceHookEntry["matcher"];
  type: "command" | "process" | "http" | "mcp_tool";
  command: CanonicalWorkspaceHookEntry["command"];
  args?: string[];
  async?: boolean;
  shell?: true | string;
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  body?: string;
  allowPrivateNetwork?: boolean;
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  resolvedTimeoutMs: CanonicalWorkspaceHookEntry["resolvedTimeoutMs"];
  resolvedMaxOutputBytes: CanonicalWorkspaceHookEntry["resolvedMaxOutputBytes"];
  statusMessage?: CanonicalWorkspaceHookEntry["statusMessage"];
  sourceRootEnabled: CanonicalWorkspaceHookEntry["sourceRootEnabled"];
  declarationEnabled: CanonicalWorkspaceHookEntry["declarationEnabled"];
  runtimeHooksEnabled: CanonicalWorkspaceHookEntry["runtimeHooksEnabled"];
  configuredEnabled: CanonicalWorkspaceHookEntry["configuredEnabled"];
  editable: CanonicalWorkspaceHookEntry["editable"];
  declarationDigestAlgorithm: CanonicalWorkspaceHookEntry["declarationDigestAlgorithm"];
  hookDeclarationDigest: CanonicalWorkspaceHookEntry["hookDeclarationDigest"];
}

function workspaceEntryToHookConfig(
  snapshot: NonNullable<ConfiguredHookRunnerOptions["workspaceHookSnapshot"]>,
  entry: CanonicalWorkspaceHookEntryLike,
): HookConfig {
  const sourcePath = snapshot.sourceFiles[entry.sourceFileIndex]?.canonicalPath;
  const common = {
    command: entry.command,
    source: { kind: "project" as const, ...(sourcePath ? { path: sourcePath } : {}) },
    ...(entry.statusMessage ? { statusMessage: entry.statusMessage } : {}),
    timeoutMs: entry.resolvedTimeoutMs,
  };
  switch (entry.type) {
    case "command":
      return {
        ...common,
        type: "command",
        ...(entry.async === undefined ? {} : { async: entry.async }),
        ...(entry.shell === undefined ? {} : { shell: entry.shell }),
      };
    case "process":
      return {
        ...common,
        type: "process",
        ...(entry.args ? { args: [...entry.args] } : {}),
      };
    case "http":
      return {
        ...common,
        type: "http",
        url: entry.url ?? entry.command,
        ...(entry.method !== undefined ? { method: entry.method } : {}),
        ...(entry.headers !== undefined ? { headers: entry.headers } : {}),
        ...(entry.allowedEnvVars !== undefined
          ? { allowedEnvVars: entry.allowedEnvVars }
          : {}),
        ...(entry.body !== undefined ? { body: entry.body } : {}),
        ...(entry.allowPrivateNetwork !== undefined
          ? { allowPrivateNetwork: entry.allowPrivateNetwork }
          : {}),
      };
    case "mcp_tool":
      return {
        ...common,
        type: "mcp_tool",
        server: entry.server ?? entry.command,
        tool: entry.tool ?? entry.command,
        ...(entry.input !== undefined ? { input: entry.input } : {}),
      };
  }
}

function createHookRegistration(input: {
  admission?: HookRegistration["admission"];
  event: HookEventName;
  hook: HookConfig;
  hookIndex: number;
  matcher?: string;
  matcherIndex: number;
  maxOutputBytes: number;
  options: ConfiguredHookRunnerOptions;
  source: string;
  sourceKind: HookSourceKind;
  timeoutMs: number;
}): HookRegistration {
  return {
    ...(input.admission ? { admission: input.admission } : {}),
    async: input.hook.type === "command" && input.hook.async === true,
    callback: createConfiguredHookCallback(
      input.options,
      input.event,
      input.hook,
      input.matcherIndex,
      input.hookIndex,
      { maxOutputBytes: input.maxOutputBytes, timeoutMs: input.timeoutMs },
    ),
    descriptor: (hookInput) =>
      createHookExecutionDescriptor(input.hook, input.timeoutMs, (value) => {
        try {
          return expandPluginVariables(
            value,
            input.hook.plugin,
            hookInput,
            input.options.getWorkingDirectory(),
          );
        } catch {
          // Display metadata must never introduce a new execution failure.
          return value;
        }
      }),
    event: input.event,
    matcher: input.matcher,
    source: input.source,
    sourceKind: input.sourceKind,
    timeoutMs: input.timeoutMs,
  };
}

function insertWorkspaceHooks(
  configured: HookRegistration[],
  workspace: HookRegistration[],
): HookRegistration[] {
  const result = [...configured];
  for (const event of new Set(workspace.map((registration) => registration.event))) {
    const eventWorkspace = workspace.filter((registration) => registration.event === event);
    const firstNonUserIndex = result.findIndex(
      (registration) => registration.event === event && registration.sourceKind !== "user",
    );
    if (firstNonUserIndex < 0) {
      result.push(...eventWorkspace);
    } else {
      result.splice(firstNonUserIndex, 0, ...eventWorkspace);
    }
  }
  return result;
}
