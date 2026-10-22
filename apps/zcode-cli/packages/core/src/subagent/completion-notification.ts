import type { ModelUsage } from "@zcode/contracts";
import { formatTaskNotification } from "../runtime-task/notification.js";
import type { SubagentFailureRecovery } from "./failure-recovery.js";
import { formatSubagentFailureGuidance } from "./failure-recovery.js";

export type LocalAgentTaskNotificationStatus = "completed" | "failed" | "stopped";

export interface LocalAgentTaskNotificationInput {
  agentId: string;
  agentType: string;
  description: string;
  error?: string;
  /**
   * 失败的「可续跑性」分类，由失败现场用 `classifySubagentFailure(error)` 现算。
   * 缺省（例如测试或非 model 失败）时退回条件式指引，不假装知道原因。
   */
  failureRecovery?: SubagentFailureRecovery;
  outputFile: string;
  parentToolCallId: string;
  result?: string;
  status: LocalAgentTaskNotificationStatus;
  totalDurationMs?: number;
  totalTokens?: number;
  totalToolUseCount?: number;
  usage?: ModelUsage;
}

export function formatLocalAgentTaskNotification(input: LocalAgentTaskNotificationInput): string {
  const notification = formatTaskNotification({
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
  const nextSteps = formatLocalAgentNextSteps(input); // next-steps 必须落在 `</task-notification>` **之前**：父侧按 XML 节读内容，闭合标签之外的
  // 散文会失联。usage 之后是 local_agent 分支内唯一的追加位（未越界到外部）。
  return nextSteps ? insertBeforeTaskNotificationClose(notification, nextSteps) : notification;
}

const TASK_NOTIFICATION_CLOSE = "</task-notification>";

function insertBeforeTaskNotificationClose(notification: string, nextSteps: string): string {
  const close = notification.lastIndexOf(TASK_NOTIFICATION_CLOSE);
  if (close < 0) return notification;
  // 只转义会破坏 XML 结构的三个字符：引号必须原样保留。指引里带着
  // `SendMessage with to: 'agent_x'`，转成 &apos;/&quot; 会让父代理多绕一步、
  // 甚至把实体当 id 抄进 to 字段。
  const escaped = nextSteps.replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
  return `${notification.slice(0, close)}<next-steps>\n${escaped}\n</next-steps>\n${notification.slice(close)}`;
}

function formatLocalAgentNotificationSummary(
  input: Pick<
    LocalAgentTaskNotificationInput,
    "agentType" | "description" | "error" | "result" | "status"
  >,
): string {
  const summary = `Agent ${input.agentType} task "${input.description}" ${input.status}.`;
  const error = input.status === "failed" && input.error?.trim() ? input.error : undefined;
  // 修复原因：失败 summary 是 Agent 卡“子智能体输出”的来源，必须保留原前缀并
  // 直接追加与 <error> 相同的失败原因；completed/stopped 文案保持不变。
  if (error) return `${summary} ${error}`;
  // 空 result 的同义短句：终态通知可能被 120k 上限截断，summary 是父代理至少还能
  // 读到的一行。丢了结论的子代理要被告知去续跑，而不是重开一个同任务的（spec
  // `subagent-continuation-copy.md` D3/D5）。
  if (input.status === "completed" && isBlankResult(input.result)) {
    return `${summary} It did the work but its final message was lost; resume it with SendMessage to its agentId instead of re-dispatching.`;
  }
  return summary;
}

/** result 缺席、空串或全空白都算「丢了结论」：provider 截断时送到这里的就是空串。 */
function isBlankResult(result: string | undefined): boolean {
  return result === undefined || result.trim().length === 0;
}

/**
 * 终态通知的下一步指引（spec `subagent-continuation-copy.md` D4/D5）。
 *
 * 子代理续跑（SendMessage 到同一 agentId，runner 复用同一子会话）比重开便宜一个量级——
 * 工具结果与上下文都还在。父代理此前没有任何地方被告知这一点，于是「一个返回空输出 /
 * 一个失败」的默认反应是重新派发，把已花的 token 与已产出的工作一起作废。
 *
 * 只按 status 分三支，不构造失败分类真相：本函数的输入里没有「为什么失败」的可靠信号，
 * 编一个 taxonomy 出来只会让父代理照着不存在的字段做决策。
 */
function formatLocalAgentNextSteps(
  input: Pick<
    LocalAgentTaskNotificationInput,
    "agentType" | "description" | "error" | "failureRecovery" | "result" | "status"
  > & { agentId: string },
): string | undefined {
  if (input.status === "completed" && isBlankResult(input.result)) {
    return [
      "This agent did the work but its final message was lost. Do NOT re-dispatch the same task.",
      `Call SendMessage with to: "${input.agentId}" to have it finish and report: say what it already covered, what is still missing, and what not to redo.`,
    ].join("\n");
  }
  if (input.status === "failed") {
    // 有分类就照实说类型与处置；没有分类（非 model 失败、旧调用点）才退回条件式文案。
    // 父代理拿到的 <error> 只是根因字符串，它读不出「瞬时抖动」还是「配置错了」，
    // 这正是上一轮它把 provider 抖动当成任务失败、直接重派的原因。
    if (input.failureRecovery) {
      return formatSubagentFailureGuidance(input.failureRecovery, input.agentId);
    }
    return [
      "This agent failed; the <error> above is the cause. If it looks like something interrupted work the agent had already done (a timeout, a provider failure, a truncated stream), resume it with SendMessage to its agentId instead of re-dispatching; otherwise fix what the error names, or change the scope and dispatch a new agent.",
    ].join("\n");
  }
  if (input.status === "stopped") {
    return [
      `This agent was stopped. If the work is still wanted, resume it with SendMessage with to: "${input.agentId}" rather than dispatching a fresh one.`,
    ].join("\n");
  }
  return undefined;
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
