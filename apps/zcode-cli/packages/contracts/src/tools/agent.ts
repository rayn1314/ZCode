// ============================================================
// Agent Tool - Subagent orchestration tool
// ============================================================
// 支持基于配置的子代理；默认派发即句柄（后台），wait: true 走前台同步。

import { z } from "zod";
import type { ToolCallId, TraceId } from "../interfaces/shared.js";
import type { ModelUsage } from "../model/index.js";
import { toToolJsonSchema } from "./json-schema.js";

export const AgentType = {
  GeneralPurpose: "general-purpose",
  Explore: "Explore",
} as const;

export type AgentType = string;

export const AgentInputSchema = z.object({
  description: z.string().describe("A short (3-5 word) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z
    .string()
    .optional()
    .describe("The type of specialized agent to use for this task"),
  // 派发即句柄：默认后台启动并立即返回 agentId/childSessionId，父代理可在子代理完成前
  // 用 SendMessage 继续指挥；wait: true 才阻塞到完成、一次拿回正文（一次性委派/并行 fan-out）。
  // 旧字段 run_in_background 已删除；本 schema 非 strict，历史/旧端残留的该键会被静默剥离。
  wait: z
    .boolean()
    .optional()
    .describe(
      "Defaults to false: the agent is launched in the background and the call returns a handle " +
        "(agentId, childSessionId) immediately, without waiting for any model call. Keep steering it with " +
        "SendMessage, or wait for the result with TaskOutput(task_id, block:true); you are notified " +
        "automatically when it completes. Set true to block until the agent finishes and return its final " +
        "message in this same tool result.",
    ),
  /**
   * 调用级 model：只给**本次** spawn 指定子代理模型，规范形与 `CreateWorkflow` 的
   * `subagent_model` 完全同形（`resolveInput` 会先用宿主模型目录解析成规范形，解不开即整次调用
   * 业务失败）。与 workflow 同一条纪律：**不留痕**——它只在 handler → `subagentPort.launch` 的
   * 本次 options 里生效，绝不回写 Settings / profile / turn 状态。
   *
   * 这一点是该字段当年被移除的原因的反面：父模型暴露一个"选模"参数后，历史 tool call 会持续
   * 带着旧 override 复现并覆盖用户当前配置；规范化为"一次调用的一次性请求、零持久化"之后，
   * 历史回放不再有任何副作用可覆写。
   *
   * 主代理自己的模型不受影响（与 ListModels 的描述口径一致）：它只描述这个子代理。
   */
  model: z
    .string()
    .trim()
    .min(1)
    .optional()
    .describe(
      "Model for this one spawn (`providerId/modelId`, optionally `$<reasoningLevel>`; ListModels prints ids in this shape). " +
        "Only when the user asks for this agent to run on a different model — omit to use the profile/session model. " +
        "It applies to this one call only and never changes the profile, the session model, or later Agent calls; " +
        "you stay on the session model yourself. " +
        "Honored on a foreground spawn (`wait: true`); a background launch (the default) currently runs on the profile/session model.",
    ),
});

export type AgentInput = z.infer<typeof AgentInputSchema>;

export const AgentInputJsonSchema = toToolJsonSchema(AgentInputSchema);

export interface AgentTextContentBlock {
  type: "text";
  text: string;
}

export interface AgentCompletedOutput {
  status: "completed";
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  content: AgentTextContentBlock[];
  totalToolUseCount: number;
  totalDurationMs: number;
  totalTokens?: number;
  usage?: ModelUsage;
}

export interface AgentBackgroundedOutput {
  status: "async_launched";
  isAsync: true;
  agentId: string;
  agentType: AgentType;
  description: string;
  prompt: string;
  childSessionId: string;
  backgroundTaskId: string;
  outputFile: string;
  canReadOutputFile: boolean;
}

export type AgentOutput = AgentCompletedOutput | AgentBackgroundedOutput;

export const AgentTextContentBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .strict();

export const AgentCompletedOutputSchema = z
  .object({
    status: z.literal("completed"),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    content: z.array(AgentTextContentBlockSchema),
    totalToolUseCount: z.number().int().nonnegative(),
    totalDurationMs: z.number().int().nonnegative(),
    totalTokens: z.number().int().nonnegative().optional(),
    usage: z.record(z.unknown()).optional(),
  })
  .strict();

export const AgentBackgroundedOutputSchema = z
  .object({
    status: z.literal("async_launched"),
    isAsync: z.literal(true),
    agentId: z.string(),
    agentType: z.string(),
    description: z.string(),
    prompt: z.string(),
    childSessionId: z.string(),
    backgroundTaskId: z.string(),
    outputFile: z.string(),
    canReadOutputFile: z.boolean(),
  })
  .strict();

export const AgentOutputSchema = z.union([
  AgentCompletedOutputSchema,
  AgentBackgroundedOutputSchema,
]);

export const AgentOutputJsonSchema = toToolJsonSchema(AgentOutputSchema);

export interface AgentToolCall {
  id: ToolCallId;
  name: "Agent";
  input: AgentInput;
  traceId: TraceId;
  startedAt: Date;
}

export interface AgentToolResult {
  toolCallId: ToolCallId;
  output: AgentOutput;
  traceId: TraceId;
  durationMs: number;
}

export const AgentErrorCode = {
  SUBAGENT_UNAVAILABLE: "agent_subagent_unavailable",
  BACKGROUND_UNAVAILABLE: "agent_background_unavailable",
  UNKNOWN_AGENT_TYPE: "agent_unknown_type",
  CHILD_RUNTIME_FAILED: "agent_child_runtime_failed",
} as const;

export type AgentErrorCode = (typeof AgentErrorCode)[keyof typeof AgentErrorCode];
