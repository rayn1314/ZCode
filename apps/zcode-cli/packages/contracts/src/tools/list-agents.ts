// ============================================================
// ListAgents Tool - 列出本会话派出的子代理及其状态
// ============================================================
// 数据源只有本进程内 runtimeTaskRegistry 里的 `local_agent` 任务。跨重启的历史不在契约里：
// 那需要按 `subagent_child` 从 sessionStore 恢复，是后续任务（见 spec 遗留工作 2）。

import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const LIST_AGENTS_TOOL_NAME = "ListAgents";

/**
 * 子代理任务的生命周期词汇表。字面与 `SubagentTaskStatus`（`interfaces/subagent.port.ts`）
 * 同集，但在这里重新声明成 zod 枚举：schema 是**运行时**校验面，type-only 的联合类型在这一层
 * 派不上用场。两处一旦分叉，症状是注册表里合法状态的任务被过滤条件或输出校验拒掉。
 */
export const AGENT_TASK_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
] as const;

export const ListAgentsInputSchema = z
  .object({
    status: z
      .enum(AGENT_TASK_STATUSES)
      .optional()
      .describe(
        'Optional lifecycle filter. Omit to list every subagent this session spawned, running or settled. Pass "running" to see only what is still in flight.',
      ),
    agent_type: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Optional agent-type filter (the same value passed as `subagent_type` when spawning). Omit to list all types.",
      ),
  })
  // .strict()：多传一个未知过滤键是可见错误，而不是被静默忽略后返回一份「看起来对」的全量列表。
  .strict();

export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>;

export const ListAgentsInputJsonSchema = toToolJsonSchema(ListAgentsInputSchema);

export const ListAgentsAgentSchema = z
  .object({
    agentId: z.string().min(1),
    childSessionId: z.string().min(1),
    agentType: z.string(),
    description: z.string(),
    status: z.enum(AGENT_TASK_STATUSES),
    isBackgrounded: z.boolean(),
    /** epoch ms（注册表快照的 Date 投影）。 */
    startedAt: z.number(),
    /** 终态才有；运行中缺席。 */
    endedAt: z.number().optional(),
  })
  .strict();

export type ListAgentsAgent = z.infer<typeof ListAgentsAgentSchema>;

export const ListAgentsOutputSchema = z
  .object({
    agents: z.array(ListAgentsAgentSchema),
  })
  .strict();

export type ListAgentsOutput = z.infer<typeof ListAgentsOutputSchema>;

export const ListAgentsOutputJsonSchema = toToolJsonSchema(ListAgentsOutputSchema);
