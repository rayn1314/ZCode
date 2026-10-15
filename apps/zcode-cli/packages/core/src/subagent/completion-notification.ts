import type { ModelUsage } from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";

export type LocalAgentTaskNotificationStatus =
  | "completed"
  | "failed"
  | "stopped";

export interface LocalAgentTaskNotificationInput {
  agentId: string;
  agentType: string;
  description: string;
  error?: string;
  outputFile: string;
  parentToolCallId: string;
  result?: string;
  status: LocalAgentTaskNotificationStatus;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ModelUsage;
}

export function formatLocalAgentTaskNotification(
  input: LocalAgentTaskNotificationInput,
): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    error: input.error,
    outputFile: input.outputFile,
    result: input.result,
    status: input.status,
    subagentType: input.agentType,
    summary: formatLocalAgentNotificationSummary(input),
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
    usage: {
      durationMs: input.totalDurationMs,
      modelUsage: input.usage,
      toolUseCount: input.totalToolUseCount,
      totalTokens: input.totalTokens,
    },
  });
}

function formatLocalAgentNotificationSummary(
  input: Pick<
    LocalAgentTaskNotificationInput,
    "agentType" | "description" | "error" | "status"
  >,
): string {
  const summary = `Agent ${input.agentType} task "${input.description}" ${input.status}.`;
  const error =
    input.status === "failed" && input.error?.trim() ? input.error : undefined;
  // 修复原因：失败 summary 是 Agent 卡“子智能体输出”的来源，必须保留原前缀并
  // 直接追加与 <error> 相同的失败原因；completed/stopped 文案保持不变。
  return error ? `${summary} ${error}` : summary;
}

export interface LocalAgentTaskRevivedNotificationInput {
  agentId: string;
  agentType: string;
  description: string;
  outputFile: string;
  parentToolCallId: string;
}

/**
 * 复活可见性通知（spec `subagent-input-revival.md` D8）：同一 taskId、非终态
 * running——父代理据此知道「这个子代理又活了」，等它的终态通知而不是重开一个。
 * 刻意不复用终态格式化器：那条路绑定 finalize 数据（error/result/usage），
 * 复活时还没有结果可言。status=「running」也让投递期的过期消解规则
 * （spec `background-notification-supersession.md`）永远不会误杀它。
 */
export function formatLocalAgentTaskRevivedNotification(
  input: LocalAgentTaskRevivedNotificationInput,
): string {
  return formatTaskNotification({
    agentId: input.agentId,
    description: input.description,
    outputFile: input.outputFile,
    status: "running",
    subagentType: input.agentType,
    summary:
      `Agent ${input.agentType} task "${input.description}" was resumed and is running again. ` +
      "Wait for its completion notification; do not dispatch a duplicate agent for the same work.",
    taskId: input.agentId,
    taskType: "local_agent",
    toolUseId: input.parentToolCallId,
  });
}
