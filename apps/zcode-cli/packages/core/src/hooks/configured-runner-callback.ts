/* oxlint-disable max-lines -- command/process/http/mcp_tool 四类回调工厂与安全模型集中维护，拆分前保持单一执行入口。 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import {
  CoreErrorType,
  HookEventName,
  HookJSONOutputSchema,
  createCoreError,
  type ExecutionResult,
  type HookConfig,
  type HookInput,
  type HookJSONOutput,
  type HookPluginContext,
  type McpToolCallResult,
} from "@zcode/contracts";
import {
  createCompatibleHookStdin,
  createPluginEnvOverlay,
  expandPluginVariables,
} from "./configured-runner-input.js";
import type { ConfiguredHookRunnerOptions, HookCallback, HookCallbackResult } from "./types.js";

export function createConfiguredHookCallback(
  options: ConfiguredHookRunnerOptions,
  event: HookEventName,
  hook: HookConfig,
  matcherIndex: number,
  hookIndex: number,
  execution: { maxOutputBytes: number; timeoutMs: number },
): HookCallback {
  switch (hook.type) {
    case "command":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "shell",
                command: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                shell: hook.shell,
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event);
        } finally {
          await stdin.cleanup();
        }
      };
    case "process":
      return async (input, context) => {
        const stdin = await createCompatibleHookStdin(input);
        try {
          const result = await options.executionPort.run(
            {
              command: {
                mode: "argv",
                file: expandPluginVariables(
                  hook.command,
                  hook.plugin,
                  input,
                  options.getWorkingDirectory(),
                ),
                args: (hook.args ?? []).map((arg) =>
                  expandPluginVariables(arg, hook.plugin, input, options.getWorkingDirectory()),
                ),
              },
              cwd: input.cwd || options.getWorkingDirectory(),
              env: createPluginEnvOverlay(hook.plugin, input, options.getWorkingDirectory()),
              stdin: stdin.value,
              timeoutMs: execution.timeoutMs,
              outputLimit: {
                maxBufferBytes: execution.maxOutputBytes,
                maxInlineBytes: execution.maxOutputBytes,
                persistOutput: "none",
              },
              trace: {
                traceId: input.traceId,
                sessionId: input.sessionId,
                turnId: input.turnId,
                attributes: {
                  hookEventName: event,
                  hookIndex,
                  matcherIndex,
                },
              },
            },
            { signal: context.signal },
          );
          return processHookExecutionResult(input, result, event);
        } finally {
          await stdin.cleanup();
        }
      };
    case "http":
      return async (input, context) => {
        const url = hook.url ?? hook.command;
        await resolveHttpRequest(url, hook.allowPrivateNetwork ?? false);
        const response = await fetch(url, {
          method: hook.method ?? "GET",
          headers: expandHttpHeaders(
            hook.headers,
            hook.allowedEnvVars,
            hook.plugin,
            input,
            options.getWorkingDirectory(),
          ),
          body: hook.body,
          redirect: "manual",
          signal: context.signal,
        });
        const body = await response.text();
        if (!response.ok) {
          throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook http request failed", {
            context: {
              bodyPreview: trimForPreview(body),
              hookEventName: event,
              status: response.status,
              statusText: response.statusText,
            },
            recoverable: true,
          });
        }
        return processHttpHookResponse(input, body, event, execution.maxOutputBytes);
      };
    case "mcp_tool":
      return async (input, context) => {
        const mcpPort = options.mcpPort;
        if (!mcpPort) {
          throw createCoreError(
            CoreErrorType.ConfigurationError,
            "MCP port is not available for mcp_tool hook",
            {
              context: { hookEventName: event, server: hook.server, tool: hook.tool },
              recoverable: true,
            },
          );
        }
        const result = await mcpPort.callTool(
          {
            serverName: hook.server,
            toolName: hook.tool,
            arguments: hook.input ?? {},
            trace: {
              traceId: input.traceId,
              sessionId: input.sessionId,
              turnId: input.turnId,
            },
            runtimeScope: "main",
            workspacePath: input.cwd || options.getWorkingDirectory(),
            ...(input.turnId ? { turnId: input.turnId } : {}),
          },
          { signal: context.signal, timeoutMs: execution.timeoutMs },
        );
        if (result.isError) {
          const message =
            mcpToolResultText(result) || `MCP tool ${hook.server}/${hook.tool} failed`;
          throw createCoreError(CoreErrorType.ToolExecutionFailed, "MCP tool hook failed", {
            cause: new Error(message),
            context: {
              hookEventName: event,
              message,
              server: hook.server,
              tool: hook.tool,
            },
            recoverable: true,
          });
        }
        // spec §10.2：hook 的 MCP 工具结果不进入模型上下文，只作为诊断文本。
        const stdoutPreview = mcpToolResultText(result);
        if (!stdoutPreview) return undefined;
        return {
          kind: "hookCallbackResult",
          diagnostics: { stdoutPreview },
        };
      };
  }
}

function processHookExecutionResult(
  input: HookInput,
  result: ExecutionResult,
  event: HookEventName,
): HookJSONOutput | HookCallbackResult | undefined {
  if (result.status === "completed" && (result.exitCode ?? 0) === 0) {
    return attachHookDiagnostics(parseHookStdout(result.stdout.text, event), result);
  }

  if (result.exitCode === 2) {
    return attachHookDiagnostics(createExitCodeBlockOutput(input, result), result);
  }

  const message =
    result.error?.message ??
    trimForPreview(result.stderr.text) ??
    `Hook process exited with status ${result.status}`;
  throw createCoreError(CoreErrorType.ToolExecutionFailed, "Hook process failed", {
    context: {
      exitCode: result.exitCode,
      hookEventName: event,
      status: result.status,
      stderrPreview: trimForPreview(result.stderr.text),
      stdoutPreview: trimForPreview(result.stdout.text),
    },
    cause: new Error(message),
    recoverable: true,
  });
}

function attachHookDiagnostics(
  output: HookJSONOutput | undefined,
  result: ExecutionResult,
): HookJSONOutput | HookCallbackResult | undefined {
  const stderrPreview = trimForPreview(result.stderr.text);
  const stdoutPreview = result.exitCode === 2 ? trimForPreview(result.stdout.text) : undefined;
  if (!stderrPreview && !stdoutPreview) return output;
  return {
    kind: "hookCallbackResult",
    ...(output ? { output } : {}),
    diagnostics: {
      ...(stderrPreview ? { errorMessage: stderrPreview, stderrPreview } : {}),
      ...(stdoutPreview ? { stdoutPreview } : {}),
    },
  };
}

function parseHookStdout(stdout: string, event: HookEventName): HookJSONOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed || !trimmed.startsWith("{")) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // 非 JSON stdout 是诊断文本，不能因为 hook 打印日志而让当前动作失败。
    return undefined;
  }

  const validation = HookJSONOutputSchema.safeParse(parsed);
  if (!validation.success) {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      "Hook stdout failed HookJSONOutput schema validation",
      {
        context: {
          errors: validation.error.errors.slice(0, 20),
          hookEventName: event,
        },
        recoverable: true,
      },
    );
  }

  return validation.data as HookJSONOutput;
}

function createExitCodeBlockOutput(input: HookInput, result: ExecutionResult): HookJSONOutput {
  const reason =
    trimForPreview(result.stderr.text) ??
    trimForPreview(result.stdout.text) ??
    "Hook blocked execution";

  if (input.hookEventName === HookEventName.PreToolUse) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PreToolUse,
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }

  if (input.hookEventName === HookEventName.PermissionRequest) {
    return {
      continue: false,
      reason,
      hookSpecificOutput: {
        hookEventName: HookEventName.PermissionRequest,
        decision: {
          behavior: "deny",
          message: reason,
        },
      },
    };
  }

  if (input.hookEventName === HookEventName.Stop) {
    return {
      decision: "block",
      reason,
    };
  }

  return {
    continue: false,
    reason,
  };
}

function trimForPreview(value: string, maxLength = 4000): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length <= maxLength) return trimmed;
  return `${trimmed.slice(0, maxLength)}...`;
}

/**
 * SSRF 防护（spec §10.1）：请求发出前解析主机名并检查目标地址。
 * 命中回环、链路本地或（默认）私网网段时直接拒绝；`allowPrivateNetwork: true`
 * 只放行 RFC1918 / fc00::/7 私网，回环与链路本地始终拒绝。
 */
export async function resolveHttpRequest(
  url: string,
  allowPrivateNetwork: boolean,
): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw createCoreError(CoreErrorType.ConfigurationError, "Hook http URL is not a valid URL", {
      recoverable: true,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Hook http URL must use http or https protocol",
      {
        context: { protocol: parsed.protocol, url },
        recoverable: true,
      },
    );
  }

  // URL.hostname 对 IPv6 字面量返回带方括号的 `[::1]`，dns.lookup 需要裸地址。
  const hostname =
    parsed.hostname.startsWith("[") && parsed.hostname.endsWith("]")
      ? parsed.hostname.slice(1, -1)
      : parsed.hostname;

  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(hostname, { all: true, verbatim: true });
  } catch (error) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Hook http URL hostname could not be resolved",
      {
        cause: error instanceof Error ? error : undefined,
        context: { hostname, url },
        recoverable: true,
      },
    );
  }

  for (const { address } of addresses) {
    if (isBlockedHookAddress(address, allowPrivateNetwork)) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "Hook http URL resolves to a private/loopback address",
        {
          context: { address, allowPrivateNetwork, url },
          recoverable: true,
        },
      );
    }
  }

  return parsed;
}

function isBlockedHookAddress(address: string, allowPrivateNetwork: boolean): boolean {
  if (isIP(address) === 4) {
    const ip = ipv4ToUint32(address);
    if (ip === undefined) return false;
    // 回环 127.0.0.0/8
    if ((ip & 0xff000000) >>> 0 === 0x7f000000) return true;
    // 链路本地 169.254.0.0/16（覆盖云 metadata 169.254.169.254）
    if ((ip & 0xffff0000) >>> 0 === 0xa9fe0000) return true;
    if (allowPrivateNetwork) return false;
    // 私网 10/8、172.16/12、192.168/16
    if ((ip & 0xff000000) >>> 0 === 0x0a000000) return true;
    if ((ip & 0xfff00000) >>> 0 === 0xac100000) return true;
    if ((ip & 0xffff0000) >>> 0 === 0xc0a80000) return true;
    return false;
  }
  if (isIP(address) === 6) {
    const normalized = address.toLowerCase();
    // 回环 ::1
    if (normalized === "::1") return true;
    // 链路本地 fe80::/10
    if (/^fe[89ab][0-9a-f]:/u.test(normalized)) return true;
    if (allowPrivateNetwork) return false;
    // 私网 fc00::/7
    if (/^f[cd][0-9a-f]:/u.test(normalized)) return true;
    return false;
  }
  return false;
}

function ipv4ToUint32(address: string): number | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  let result = 0;
  for (const part of parts) {
    const octet = Number(part);
    if (!Number.isInteger(octet) || octet < 0 || octet > 255) return undefined;
    result = result * 256 + octet;
  }
  return result >>> 0;
}

/**
 * 凭据处理（spec §10.1）：headers 值中的 `$ENV_VAR` 只展开 `allowedEnvVars` 白名单内的变量，
 * 白名单为空时不展开任何环境变量（内置 ZCode/CLAUDE 变量由 expandPluginVariables 处理）。
 */
export function expandAllowedEnvVars(
  value: string,
  allowedEnvVars: string[] | undefined,
): string {
  const allowed = new Set(allowedEnvVars ?? []);
  if (allowed.size === 0) return value;
  return value.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name: string) =>
    allowed.has(name) ? (process.env[name] ?? "") : match,
  );
}

function expandHttpHeaders(
  headers: Record<string, string> | undefined,
  allowedEnvVars: string[] | undefined,
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    // 内置 ZCode/CLAUDE 会话变量总是展开（spec §10.1），$ENV_VAR 只展开白名单。
    result[key] = expandAllowedEnvVars(
      expandPluginVariables(value, plugin, input, workingDirectory),
      allowedEnvVars,
    );
  }
  return result;
}

function processHttpHookResponse(
  input: HookInput,
  body: string,
  event: HookEventName,
  maxOutputBytes: number,
): HookJSONOutput | HookCallbackResult | undefined {
  const truncated = body.length > maxOutputBytes;
  const bounded = truncated ? body.slice(0, maxOutputBytes) : body;
  const output = parseHookStdout(bounded, event);
  const stdoutPreview = trimForPreview(bounded, maxOutputBytes);
  if (!stdoutPreview) return output;
  return {
    kind: "hookCallbackResult",
    ...(output ? { output } : {}),
    diagnostics: {
      stdoutPreview: truncated ? `${stdoutPreview} [truncated]` : stdoutPreview,
    },
  };
}

function mcpToolResultText(result: McpToolCallResult): string {
  const text = result.content
    .map((block) => (typeof block.text === "string" ? block.text : undefined))
    .filter((value): value is string => Boolean(value))
    .join("\n")
    .trim();
  if (text) return text;
  if (result.structuredContent !== undefined) {
    try {
      return JSON.stringify(result.structuredContent, null, 2);
    } catch {
      return String(result.structuredContent);
    }
  }
  return "";
}
