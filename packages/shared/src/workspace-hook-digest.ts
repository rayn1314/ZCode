import { createHash } from "node:crypto";
import { basename, relative, resolve } from "node:path";
import {
  WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
  WORKSPACE_HOOK_EVENT_NAMES,
  resolveWorkspaceHookConfiguredGates,
  resolveWorkspaceHookTimeoutMs,
  type WorkspaceHookConfigFileKind,
  type WorkspaceHookDefinition,
  type WorkspaceHookEventName,
  type WorkspaceHookRuntimeRoot,
  type WorkspaceHookSourceInput,
} from "./workspace-hook-config.js";

export interface CanonicalWorkspaceHookEntryData {
  reviewItemId: string;
  event: WorkspaceHookEventName;
  matcherIndex: number;
  hookIndex: number;
  sourceFileIndex: number;
  sourceRelativePath: string;
  matcher: string | null;
  type: "command" | "process" | "http" | "mcp_tool";
  command: string;
  args?: string[];
  async?: boolean;
  shell?: true | string;
  // http / mcp_tool 的配置字段透传到审查展示与 digest（spec §10）。
  url?: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  headers?: Record<string, string>;
  allowedEnvVars?: string[];
  body?: string;
  allowPrivateNetwork?: boolean;
  server?: string;
  tool?: string;
  input?: Record<string, unknown>;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
  statusMessage?: string;
  /** P3 行为字段透传（spec §8）。contracts 的 canonical entry schema 已同步收这两个键。 */
  once?: boolean;
  failClosed?: boolean;
  sourceRootEnabled: boolean;
  declarationEnabled: boolean;
  runtimeHooksEnabled: boolean;
  configuredEnabled: boolean;
  editable: boolean;
  declarationDigestAlgorithm: "sha256";
  hookDeclarationDigest: string;
}

export interface WorkspaceHookBundleSnapshotData {
  schemaVersion: typeof WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION;
  workspaceIdentity: string;
  discoveredAt: string;
  sourceFiles: Array<{
    canonicalPath: string;
    baseDir: string;
    discoveryOrder: number;
    configFileKind: WorkspaceHookConfigFileKind;
    explicitProjectConfig: boolean;
    editable: boolean;
    hooksRoot: {
      enabled?: boolean;
      timeoutMs?: number;
      maxOutputBytes?: number;
    };
  }>;
  hooks: CanonicalWorkspaceHookEntryData[];
  digestAlgorithm: "sha256";
  bundleDigest: string;
}

export function resolveWorkspaceHookEntries(input: {
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
}): CanonicalWorkspaceHookEntryData[] {
  const entries: CanonicalWorkspaceHookEntryData[] = [];

  for (const [sourceFileIndex, source] of input.sources.entries()) {
    const sourceRelativePath = normalizeRelativeSourcePath(
      input.workspacePath,
      source.canonicalPath,
    );
    for (const event of WORKSPACE_HOOK_EVENT_NAMES) {
      for (const [matcherIndex, matcher] of (source.hooks.events?.[event] ?? []).entries()) {
        for (const [hookIndex, hook] of matcher.hooks.entries()) {
          const gates = resolveWorkspaceHookConfiguredGates({
            sourceEnabled: source.hooks.enabled,
            declarationEnabled: hook.enabled,
            runtimeHooksEnabled: input.runtimeRoot.enabled,
          });
          const resolvedTimeoutMs = resolveWorkspaceHookTimeoutMs(
            hook,
            input.runtimeRoot.timeoutMs,
          );
          const common = {
            reviewItemId: `workspace-hook-${sourceFileIndex}-${event}-${matcherIndex}-${hookIndex}`,
            event,
            matcherIndex,
            hookIndex,
            sourceFileIndex,
            sourceRelativePath,
            matcher: matcher.matcher ?? null,
            // http/mcp_tool 没有 command 字段；为了兼容既有读取路径（Hook.command / 审查展示），
            // http 用 url、mcp_tool 用 tool 作为展示命令。
            command:
              hook.type === "http"
                ? (hook.url ?? "")
                : hook.type === "mcp_tool"
                  ? (hook.tool ?? "")
                  : hook.command,
            resolvedTimeoutMs,
            resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
            ...(hook.statusMessage ? { statusMessage: hook.statusMessage } : {}),
            ...(hook.once !== undefined ? { once: hook.once } : {}),
            ...(hook.failClosed !== undefined ? { failClosed: hook.failClosed } : {}),
            ...gates,
            editable: source.editable,
            declarationDigestAlgorithm: "sha256" as const,
            hookDeclarationDigest: createWorkspaceHookDeclarationDigest({
              sourceRelativePath,
              sourceDiscoveryOrder: source.discoveryOrder,
              event,
              matcher: matcher.matcher ?? null,
              matcherIndex,
              hookIndex,
              hook,
              defaultTimeoutMs: input.runtimeRoot.timeoutMs,
              resolvedMaxOutputBytes: input.runtimeRoot.maxOutputBytes,
            }),
          };

          if (hook.type === "process") {
            entries.push({
              ...common,
              type: "process",
              ...(hook.args && hook.args.length > 0 ? { args: [...hook.args] } : {}),
            });
          } else if (hook.type === "command") {
            entries.push({
              ...common,
              type: "command",
              ...(hook.async === true ? { async: true } : {}),
              ...(hook.shell !== undefined ? { shell: hook.shell } : {}),
            });
          } else if (hook.type === "http") {
            entries.push({
              ...common,
              type: "http",
              ...(hook.url !== undefined ? { url: hook.url } : {}),
              ...(hook.method !== undefined ? { method: hook.method } : {}),
              ...(hook.headers !== undefined ? { headers: hook.headers } : {}),
              ...(hook.allowedEnvVars !== undefined ? { allowedEnvVars: hook.allowedEnvVars } : {}),
              ...(hook.body !== undefined ? { body: hook.body } : {}),
              ...(hook.allowPrivateNetwork !== undefined
                ? { allowPrivateNetwork: hook.allowPrivateNetwork }
                : {}),
            });
          } else {
            entries.push({
              ...common,
              type: "mcp_tool",
              ...(hook.server !== undefined ? { server: hook.server } : {}),
              ...(hook.tool !== undefined ? { tool: hook.tool } : {}),
              ...(hook.input !== undefined ? { input: hook.input } : {}),
            });
          }
        }
      }
    }
  }
  return entries;
}

export function buildWorkspaceHookBundleSnapshot(input: {
  workspaceIdentity: string;
  workspacePath: string;
  sources: readonly WorkspaceHookSourceInput[];
  runtimeRoot: WorkspaceHookRuntimeRoot;
  discoveredAt?: string;
}): WorkspaceHookBundleSnapshotData | undefined {
  const hooks = resolveWorkspaceHookEntries(input);
  if (hooks.length === 0) return undefined;

  const sourceFiles = input.sources.map((source) => ({
    canonicalPath: source.canonicalPath,
    baseDir: source.baseDir,
    discoveryOrder: source.discoveryOrder,
    configFileKind: source.configFileKind,
    explicitProjectConfig: source.explicitProjectConfig,
    editable: source.editable,
    hooksRoot: {
      ...(source.hooks.enabled !== undefined ? { enabled: source.hooks.enabled } : {}),
      ...(source.hooks.timeoutMs !== undefined ? { timeoutMs: source.hooks.timeoutMs } : {}),
      ...(source.hooks.maxOutputBytes !== undefined
        ? { maxOutputBytes: source.hooks.maxOutputBytes }
        : {}),
    },
  }));
  const bundlePayload = [
    "workspace-hook-bundle",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sources.map((source) => [
      normalizeRelativeSourcePath(input.workspacePath, source.canonicalPath),
      source.discoveryOrder,
      source.configFileKind,
      source.explicitProjectConfig,
      canonicalOptional(source.hooks.enabled),
      canonicalOptional(source.hooks.timeoutMs),
      canonicalOptional(source.hooks.maxOutputBytes),
    ]),
    hooks.map((hook) => [
      hook.hookDeclarationDigest,
      hook.sourceRootEnabled,
      hook.declarationEnabled,
      hook.runtimeHooksEnabled,
      hook.configuredEnabled,
    ]),
  ];

  return deepFreeze({
    schemaVersion: WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    workspaceIdentity: input.workspaceIdentity,
    discoveredAt: input.discoveredAt ?? new Date().toISOString(),
    sourceFiles,
    hooks,
    digestAlgorithm: "sha256",
    bundleDigest: sha256(bundlePayload),
  });
}

export function createWorkspaceHookDeclarationDigest(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  defaultTimeoutMs: number;
  resolvedMaxOutputBytes: number;
}): string {
  return sha256(
    canonicalDeclarationPayload({
      ...input,
      resolvedTimeoutMs: resolveWorkspaceHookTimeoutMs(input.hook, input.defaultTimeoutMs),
    }),
  );
}

function canonicalDeclarationPayload(input: {
  sourceRelativePath: string;
  sourceDiscoveryOrder: number;
  event: WorkspaceHookEventName;
  matcher: string | null;
  matcherIndex: number;
  hookIndex: number;
  hook: WorkspaceHookDefinition;
  resolvedTimeoutMs: number;
  resolvedMaxOutputBytes: number;
}): unknown[] {
  const execution =
    input.hook.type === "process"
      ? ["process", input.hook.command, [...(input.hook.args ?? [])]]
      : input.hook.type === "command"
        ? [
            "command",
            input.hook.command,
            input.hook.async === true,
            input.hook.shell === undefined
              ? ["unset"]
              : input.hook.shell === true
                ? ["true"]
                : ["string", input.hook.shell],
          ]
        : input.hook.type === "http"
          ? [
              "http",
              input.hook.url,
              input.hook.method ?? "GET",
              input.hook.headers ?? {},
              input.hook.allowedEnvVars ?? [],
              input.hook.body ?? "",
              input.hook.allowPrivateNetwork === true,
            ]
          : ["mcp_tool", input.hook.server, input.hook.tool, input.hook.input ?? {}];
  return [
    "workspace-hook-declaration",
    WORKSPACE_HOOK_DIGEST_SCHEMA_VERSION,
    input.sourceRelativePath,
    input.sourceDiscoveryOrder,
    input.event,
    input.matcher,
    input.matcherIndex,
    input.hookIndex,
    execution,
    input.resolvedTimeoutMs,
    input.resolvedMaxOutputBytes,
  ];
}

function normalizeRelativeSourcePath(workspacePath: string, sourcePath: string): string {
  const value = relative(resolve(workspacePath), resolve(sourcePath)).replaceAll("\\", "/");
  return value || basename(sourcePath);
}

function canonicalOptional(value: boolean | number | undefined): unknown[] {
  return value === undefined ? ["unset"] : ["set", value];
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
