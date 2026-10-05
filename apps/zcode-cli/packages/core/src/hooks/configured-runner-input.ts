import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveWorkspaceHookTimeoutMs } from "@zcode/shared/workspace-hook-discovery";
import {
  CoreErrorType,
  HookEventName,
  createCoreError,
  type HookConfig,
  type HookInput,
  type HookPluginContext,
} from "@zcode/contracts";
import { assertNever } from "./assertNever.js";

export async function createCompatibleHookStdin(input: HookInput): Promise<{
  cleanup: () => Promise<void>;
  value: string;
}> {
  const compatible: Record<string, unknown> = {
    ...input,
    agent_type: input.agentName,
    hook_event_name: input.hookEventName,
    permission_mode: input.mode,
    session_id: input.sessionId,
  };
  const tempDir = await mkdtemp(join(tmpdir(), "zcode-hook-"));
  const transcriptPath = join(tempDir, "transcript.jsonl");
  await writeFile(transcriptPath, formatTranscript(input), "utf8");
  compatible.transcript_path = transcriptPath;
  compatible.transcriptPath = transcriptPath;

  if ("toolInput" in input) {
    // 这里只补无损 alias，继续保留 ZCode camelCase 字段作为内部主契约。
    compatible.tool_name = input.toolName;
    compatible.tool_input = input.toolInput;
    compatible.tool_use_id = input.toolCallId;
  }

  switch (input.hookEventName) {
    case HookEventName.PermissionRequest:
      compatible.permission_suggestions = input.permissionSuggestions;
      break;
    case HookEventName.PostToolUse:
      compatible.tool_response = input.toolResponse;
      break;
    case HookEventName.PostToolUseFailure:
      compatible.error_details = input.error;
      compatible.error = input.error.message;
      compatible.is_interrupt = input.isInterrupt;
      break;
    case HookEventName.Stop:
      compatible.last_assistant_message = input.responseText ?? input.responsePreview;
      compatible.stop_hook_active = input.stopHookActive;
      break;
    case HookEventName.PreCompact:
      compatible.compact_trigger = input.compactTrigger;
      break;
    case HookEventName.PostCompact:
      compatible.compact_trigger = input.compactTrigger;
      compatible.compact_outcome = input.outcome;
      break;
    case HookEventName.SubagentStart:
      compatible.subagent_id = input.agentId;
      compatible.subagent_type = input.agentType;
      break;
    case HookEventName.SubagentStop:
      compatible.subagent_id = input.agentId;
      compatible.subagent_type = input.agentType;
      compatible.subagent_status = input.status;
      break;
    case HookEventName.SessionEnd:
      compatible.end_reason = input.endReason;
      break;
    case HookEventName.SessionStart:
    case HookEventName.UserPromptSubmit:
    case HookEventName.PreToolUse:
      break;
    case HookEventName.PermissionDenied:
      compatible.tool_name = input.toolName;
      compatible.tool_use_id = input.toolCallId;
      compatible.reason = input.reason;
      compatible.input_summary = input.inputSummary;
      break;
    case HookEventName.PostToolBatch:
      compatible.tool_call_ids = input.toolCallIds;
      compatible.success_count = input.successCount;
      compatible.error_count = input.errorCount;
      break;
    case HookEventName.Notification:
      compatible.notification = input.notification;
      compatible.notification_type = input.notificationType;
      break;
    case HookEventName.PreModelSwitch:
    case HookEventName.PostModelSwitch:
      compatible.previous_model = input.previousModel;
      compatible.model = input.model;
      compatible.reason = input.reason;
      break;
    default:
      // 全部事件已在上方覆盖；default 只作类型级穷尽守卫（P0 不改判定语义）。
      assertNever(input);
  }

  return {
    value: `${JSON.stringify(compatible)}\n`,
    cleanup: async () => {
      await rm(tempDir, { force: true, recursive: true });
    },
  };
}

export function resolveHookTimeoutMs(hook: HookConfig, defaultTimeoutMs: number): number {
  return resolveWorkspaceHookTimeoutMs(hook, defaultTimeoutMs);
}

export function createPluginEnvOverlay(
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
) {
  const set: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ZCODE_PROJECT_DIR: input.cwd || workingDirectory,
    ZCODE_SESSION_ID: input.sessionId,
  };
  if (!plugin) return { set };
  return {
    set: {
      ...set,
      CLAUDE_PLUGIN_DATA: plugin.dataPath,
      CLAUDE_PLUGIN_ROOT: plugin.rootPath,
      ZCODE_PLUGIN_DATA: plugin.dataPath,
      ZCODE_PLUGIN_ID: plugin.id,
      ZCODE_PLUGIN_NAME: plugin.name,
      ZCODE_PLUGIN_ROOT: plugin.rootPath,
    },
  };
}

export function expandPluginVariables(
  value: string,
  plugin: HookPluginContext | undefined,
  input: HookInput,
  workingDirectory: string,
): string {
  const replacements: Record<string, string> = {
    CLAUDE_CODE_SESSION_ID: input.sessionId,
    CLAUDE_PROJECT_DIR: input.cwd || workingDirectory,
    CLAUDE_SESSION_ID: input.sessionId,
    ZCODE_PROJECT_DIR: input.cwd || workingDirectory,
    ZCODE_SESSION_ID: input.sessionId,
  };
  if (plugin) {
    replacements.CLAUDE_PLUGIN_DATA = plugin.dataPath;
    replacements.CLAUDE_PLUGIN_ROOT = plugin.rootPath;
    replacements.ZCODE_PLUGIN_DATA = plugin.dataPath;
    replacements.ZCODE_PLUGIN_ROOT = plugin.rootPath;
  }
  return value.replace(
    /\$\{(CLAUDE_CODE_SESSION_ID|CLAUDE_PLUGIN_DATA|CLAUDE_PLUGIN_ROOT|CLAUDE_PROJECT_DIR|CLAUDE_SESSION_ID|CLAUDE_SKILL_DIR|ZCODE_PLUGIN_DATA|ZCODE_PLUGIN_ROOT|ZCODE_PROJECT_DIR|ZCODE_SESSION_ID|ZCODE_SKILL_DIR)\}/gu,
    (_match, key: string) => {
      if (key === "CLAUDE_SKILL_DIR" || key === "ZCODE_SKILL_DIR") {
        // hook 运行时没有“当前 skill”语义，不能把该变量交给 shell 展开为空字符串。
        // 这里提前报错，插件诊断/日志能看到明确的上下文缺失原因。
        throw createCoreError(
          CoreErrorType.ConfigurationError,
          `Hook variable requires a skill context: ${key}`,
          {
            context: {
              hookEventName: input.hookEventName,
              variable: key,
            },
            recoverable: true,
          },
        );
      }
      return replacements[key] ?? _match;
    },
  );
}

function formatTranscript(input: HookInput): string {
  if (input.hookEventName === HookEventName.Stop) {
    return formatMessageLine("assistant", input.responseText ?? input.responsePreview);
  }
  if (input.hookEventName === HookEventName.UserPromptSubmit) {
    return formatMessageLine("user", input.prompt);
  }
  return "";
}

function formatMessageLine(role: "assistant" | "user", text: string): string {
  return `${JSON.stringify({
    message: {
      content: [{ text, type: "text" }],
      role,
    },
  })}\n`;
}
