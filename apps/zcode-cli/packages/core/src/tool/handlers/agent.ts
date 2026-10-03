// ============================================================
// Agent Tool Handler
// ============================================================

import {
  AgentErrorCode,
  AgentInputJsonSchema,
  AgentInputSchema,
  AgentOutputSchema,
  AgentType,
  CoreErrorType,
  createCoreError,
  type AgentInput,
  type AgentOutput,
  type ModelCatalogPort,
  type TraceContext,
} from "@zcode/contracts";
import { TASK_TOOL_NAME } from "../compat.js";
import type {
  ToolEntry,
  ToolHandler,
  ToolHandlerFailure,
  ToolInputResolutionContext,
  ToolInputResolutionResult,
} from "../types.js";
import { parseSubagentModelSelection, resolveModelReference } from "./model-reference.js";
import { formatAgentProfilesForPrompt, type AgentProfile } from "../../subagent/profile.js";

const MAX_AGENT_MODEL_BYTES = 120_000;

/** 业务失败码：与 CreateWorkflow 同族的 400，判别键在 message（executor 投影成 `code: "N"`）。 */
const AGENT_MODEL_FAILURE_CODE = 400;

/**
 * 宿主没有模型目录而调用方点名了 `model`：**明确拒绝**，不静默回退到 profile/会话模型。
 *
 * 与 `CreateWorkflow` 的 `subagent_model` 同一条纪律：一个宿主解不了的字符串一路传下去，会在
 * 子代理第一次开口时才炸——那时看起来像是模型的问题。文案点名要省掉的字段，模型才知道下一步
 * 省哪一个。
 */
const AGENT_MODEL_UNAVAILABLE = "This host cannot choose a subagent model; omit `model`.";

const AGENT_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        status: { const: "completed", type: "string" },
        agentId: { type: "string" },
        agentType: { type: "string" },
        prompt: { type: "string" },
        content: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: { const: "text", type: "string" },
              text: { type: "string" },
            },
            required: ["type", "text"],
            additionalProperties: false,
          },
        },
        totalToolUseCount: { type: "integer", minimum: 0 },
        totalDurationMs: { type: "integer", minimum: 0 },
        totalTokens: { type: "integer", minimum: 0 },
        usage: { type: "object", additionalProperties: true },
      },
      required: ["status", "agentId", "prompt", "content", "totalToolUseCount", "totalDurationMs"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        status: { const: "async_launched", type: "string" },
        agentId: {
          type: "string",
          description: "The ID of the async agent",
        },
        description: {
          type: "string",
          description: "The description of the task",
        },
        prompt: {
          type: "string",
          description: "The prompt for the agent",
        },
        outputFile: {
          type: "string",
          description: "Path to the output file for checking agent progress",
        },
        canReadOutputFile: {
          type: "boolean",
          description: "Whether the calling agent has Read/Bash tools to check progress",
        },
      },
      required: ["status", "agentId", "description", "prompt", "outputFile"],
      additionalProperties: false,
    },
  ],
};

/**
 * 动态工作流灰度门也管**工具描述**：
 * 关闭时十个工具不注册，但这条 bullet 仍在 Agent 的 provider 描述里写着「CreateWorkflow
 * 是强制的」，于是模型被指向一个根本不存在的工具，只会白白撞一次 tool_not_found。
 * 缺省 true：TUI、headless 与既有调用方（包括模块加载期烘焙的 AGENT_PROVIDER_DESCRIPTION）
 * 行为不变，只有显式 false 才抹掉这一行。
 */
function buildAgentProviderDescription(
  options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    dynamicWorkflowEnabled?: boolean;
  } = {},
): string {
  const agentList = formatAgentProfilesForPrompt(options.profiles ?? [], {
    embeddedSearchEnabled: options.embeddedSearchEnabled,
  });

  return [
    "Launch a new agent to handle complex, multi-step tasks. Each agent type has specific capabilities and tools available to it.",
    "",
    agentList,
    "",
    "When using the Agent tool, specify a subagent_type parameter to select which agent type to use. If omitted, the general-purpose agent is used.",
    "",
    "## When to use",
    "",
    "Reach for this when the task matches an available agent type, when you have independent work to run in parallel, or when answering would mean reading across several files — delegate it and you keep the conclusion, not the file dumps. For a single-fact lookup where you already know the file, symbol, or value, search directly. Once you've delegated a search, don't also run it yourself — wait for the result.",
    "",
    "- By default the call returns immediately with a handle (agentId + childSessionId) while the agent keeps running in the background. Keep steering it with SendMessage using the returned agentId, or wait for the result with TaskOutput(task_id, block:true); you are notified automatically when it finishes.",
    "- Pass `wait: true` when you want the agent's final message inline in this same tool result and are willing to block until it finishes — the typical case for a one-shot delegation you consume right away.",
    // 调用级 model 的口径照 ListModels / CreateWorkflow：只在用户要求时设，且只动这个子代理。
    // 最后那句不对称必须留着——后台路径当前不携带调用级选型，不说穿等于让模型向用户复述一个
    // 没有发生过的换模（与 describeWorkflowSubagentModel 括号里那半句同一个理由）。
    "- Pass `model` only when the user asks this agent to run on a different model (`providerId/modelId` from ListModels, optionally `$<reasoningLevel>`). It applies to this one spawn only and changes nothing persistent: the profile, the session model and later Agent calls are untouched, and you stay on the session model yourself.",
    "- `model` takes effect on a foreground spawn, so pair it with `wait: true`; a background launch (the default) currently runs on the profile/session model.",
    "- The agent's final message is not shown to the user — relay what matters. With the default background launch it arrives later via the completion notification, not in this tool result.",
    "- A new Agent call starts fresh, so the prompt must be self-contained.",
    "- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently (they all run in the background by default).",
    // 只保留「用户点名工作流」这一种情形：工作流一律由用户显式请求触发，与系统提示词其余
    // 部分一致。不能把「结果层层喂给下一步的多代理编排」也划给 CreateWorkflow，
    // 那等于让模型在用户没开口时自行选择工作流。
    ...(options.dynamicWorkflowEnabled === false
      ? []
      : [
          '- If the user explicitly asks for a workflow ("use a workflow", "使用 workflow", "用工作流", or any phrasing naming workflow/工作流 as the means), the CreateWorkflow tool is mandatory: do not use this tool instead, however small the task.',
        ]),
  ].join("\n");
}

const AGENT_PROVIDER_DESCRIPTION = buildAgentProviderDescription();

function formatAgentOutputForModel(output: unknown): string {
  const parsed = AgentOutputSchema.safeParse(output);
  if (!parsed.success) {
    return typeof output === "string" ? output : (JSON.stringify(output) ?? String(output));
  }

  const data = parsed.data as AgentOutput;
  if (data.status !== "async_launched") {
    const childText = data.content.map((block) => block.text).join("\n");
    const childContent =
      childText.trim().length > 0 ? [childText] : ["(Subagent completed but returned no output.)"];
    const usageLines = [
      ...(data.totalTokens === undefined ? [] : [`subagent_tokens: ${data.totalTokens}`]),
      `tool_uses: ${data.totalToolUseCount}`,
      `duration_ms: ${data.totalDurationMs}`,
    ];
    return [
      ...childContent,
      `agentId: ${data.agentId} (use SendMessage with to: '${data.agentId}' to continue this agent)`,
      `<usage>${usageLines.join("\n")}</usage>`,
    ].join("\n");
  }

  // 下游服务按固定片段识别 launch ACK（packages/services 的
  // isCurrentBackgroundAgentLaunchAcknowledgement）：改写时必须保留
  // "Async agent launched successfully."、"agentId:"、"The agent is working in the background."
  // 与 "notified automatically when it completes"，否则启动确认会被当成已完成结果发给 UI。
  const launchLines = [
    "Async agent launched successfully. The agent is working in the background. You will be notified automatically when it completes.",
    `agentId: ${data.agentId} (internal ID - do not mention to user. Use SendMessage with to: '${data.agentId}' to keep steering this agent.)`,
    `childSessionId: ${data.childSessionId}`,
    `To wait for its result now, call TaskOutput with task_id: '${data.backgroundTaskId}' and block: true.`,
  ];

  if (data.canReadOutputFile) {
    return [
      ...launchLines,
      "Do not duplicate this agent's work - avoid working with the same files or topics it is using. Work on non-overlapping tasks, or briefly tell the user what you launched and end your response.",
      `output_file: ${data.outputFile}`,
      "Do NOT Read or tail this file via the shell tool. If the user asks for progress, say the agent is still running; you'll get a completion notification.",
    ].join("\n");
  }

  return [
    ...launchLines,
    "Briefly tell the user what you launched and end your response. Do not generate any other text - agent results will arrive in a subsequent message.",
  ].join("\n");
}

/**
 * 调用级 `model` 的归一化：解析成规范形，或一个整次调用的业务失败。
 *
 * 与 `CreateWorkflow` 的 `subagent_model` 共用同一个解析器（`resolveModelReference`）：三档匹配、
 * 大小写、档位校验与失败清单都是同一套。差别只有拒绝文案点名的是 `model`——那是各工具自己的
 * 字段名，所以这段薄包装留在各自的 handler 里。
 */
function resolveAgentModel(
  requested: string | undefined,
  catalog: ModelCatalogPort | undefined,
): { result: true; canonical?: string } | ToolHandlerFailure {
  if (requested === undefined) return { result: true };
  if (catalog === undefined) {
    return { result: false, errorCode: AGENT_MODEL_FAILURE_CODE, message: AGENT_MODEL_UNAVAILABLE };
  }
  const resolution = resolveModelReference(requested, catalog.listModels());
  // 解不出来即整次调用失败：什么都没启动，也不静默回退到 profile/会话模型。
  if (!resolution.ok) {
    return { result: false, errorCode: AGENT_MODEL_FAILURE_CODE, message: resolution.message };
  }
  return { result: true, canonical: resolution.canonical };
}

/**
 * `model` 的归一化钩子。省略时逐字节恒等返回原入参——那是「零回归」的可测形式：没有调用级
 * 模型的调用，hook / 权限规则 / handler 看到的字节与引入本字段之前完全一致。
 */
function resolveAgentInput(
  input: unknown,
  context: ToolInputResolutionContext,
): ToolInputResolutionResult {
  const parsed = AgentInputSchema.safeParse(input);
  // schema 失败由 executor 在更早的位置收口，这里不管。
  if (!parsed.success) return { result: true, input };
  const model = resolveAgentModel(parsed.data.model, context.modelCatalogPort);
  if (!model.result) return model;
  const rawModel = (input as { model?: unknown } | null)?.model;
  // 比的是**原始**入参：schema 带 `.trim()`，所以两端有空白的字符串与规范形解析后相等，而恒等
  // 放行会让下游看到那串空白（与 CreateWorkflow 的归一化同一条理由）。
  if (model.canonical === rawModel) return { result: true, input };
  return { result: true, input: { ...parsed.data, model: model.canonical } };
}

const agentHandler: ToolHandler = async (input, context) => {
  const parsed = AgentInputSchema.parse(input) as AgentInput;
  const agentType = parsed.subagent_type ?? AgentType.GeneralPurpose;

  if (!context.subagentPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SubagentPort is not configured for Agent tool",
      {
        context: {
          code: AgentErrorCode.SUBAGENT_UNAVAILABLE,
          toolCallId: context.toolCallId,
          toolName: "Agent",
        },
        recoverable: false,
      },
    );
  }

  // 走到 handler 的 `model` 已被 resolveInput 归一成规范形（解不出来的调用根本走不到这里），
  // 所以这里只把那个字符串拆回结构化选型。与 CreateWorkflow 的 handler 同一姿态。
  const callModelSelection = parseSubagentModelSelection(parsed.model, "agent model");

  const request = {
    sessionId: context.sessionId,
    turnId: context.turnId,
    parentToolCallId: context.toolCallId,
    agentType,
    description: parsed.description,
    prompt: parsed.prompt,
    callerCanReadOutputFile: canReadBackgroundOutputFile(context.providerVisibleToolNames),
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
    trace: {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    } as TraceContext,
  };
  return context.subagentPort.launch(
    {
      ...request,
      // 缺省即后台；前台/后台的唯一分叉判据在 runner.launch，handler 只透传 wait。
      wait: parsed.wait === true,
    },
    {
      signal: context.abortSignal,
      ...(context.model ? { model: context.model } : {}),
      ...(context.subagentModelOverride ? { modelOverride: context.subagentModelOverride } : {}),
      // 调用级选型只放在本次 launch 的 options 里：不回写 Settings / profile / turn 状态，
      // 因此历史 tool call 回放不会留下任何能覆盖当前配置的东西。
      ...(callModelSelection ? { callModelSelection } : {}),
    },
  );
};

export const agentToolEntry: ToolEntry = {
  capability: "Launch a profile-backed subagent; background execution is runtime-configured",
  metadata: {
    name: "Agent",
    description: AGENT_PROVIDER_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    maxOutputBytes: MAX_AGENT_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: agentHandler,
  resolveInput: resolveAgentInput,
  formatModelContent: formatAgentOutputForModel,
  inputSchema: AgentInputJsonSchema,
  outputSchema: AGENT_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: AgentInputSchema,
  runtimeOutputSchema: AgentOutputSchema,
  permission: {
    permission: "subagent",
    reason:
      "Agent launches a child runtime; child tool calls are separately constrained and approved",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["input"],
    alwaysAllowPatternSources: ["input"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_AGENT_MODEL_BYTES,
    maxModelBytes: MAX_AGENT_MODEL_BYTES,
    strategy: "artifact",
    preview: {
      maxBytes: MAX_AGENT_MODEL_BYTES,
      direction: "head",
    },
    artifact: {
      enabled: true,
      retention: "session",
    },
  },
  timeout: { kind: "none" },
  cancellation: {
    supported: true,
    cleanup: "bestEffort",
    userVisibleMessage:
      "Agent was cancelled before the subagent returned findings or background launch completed",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function canReadBackgroundOutputFile(toolNames: readonly string[] | undefined): boolean {
  const names = new Set(toolNames ?? []);
  return names.has("Read") || names.has("Bash");
}

export const taskToolEntry: ToolEntry = {
  ...agentToolEntry,
  capability: "Claude Code-compatible alias for launching a ZCode subagent",
  metadata: {
    ...agentToolEntry.metadata,
    name: TASK_TOOL_NAME,
    providerVisible: false,
    description: [
      "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
      "",
      agentToolEntry.metadata.description ?? "",
    ].join("\n"),
  },
};

function createTaskToolEntryFromAgent(entry: ToolEntry): ToolEntry {
  return {
    ...entry,
    capability: "Claude Code-compatible alias for launching a ZCode subagent",
    metadata: {
      ...entry.metadata,
      name: TASK_TOOL_NAME,
      providerVisible: false,
      description: [
        "Claude Code-compatible alias for the Agent tool. Use this when plugin instructions ask for the Task tool.",
        "",
        entry.metadata.description ?? "",
      ].join("\n"),
    },
  };
}

export function createAgentToolEntry(
  _options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    /** 见 buildAgentProviderDescription：缺省 true，只有灰度显式关闭时才去掉工作流那一行。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return {
    ...agentToolEntry,
    metadata: {
      ...agentToolEntry.metadata,
      description: buildAgentProviderDescription(_options),
    },
  };
}

export function createTaskToolEntry(
  options: {
    embeddedSearchEnabled?: boolean;
    profiles?: readonly AgentProfile[];
    /** Task 是 Agent 的兼容别名，描述整段内嵌 Agent 的，因此同一道门一起传下去。 */
    dynamicWorkflowEnabled?: boolean;
  } = {},
): ToolEntry {
  return createTaskToolEntryFromAgent(createAgentToolEntry(options));
}
