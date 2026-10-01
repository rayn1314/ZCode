import { createMessageId, traceContextToLogContext } from "../deps.js";
import type { MessageId } from "../deps.js";
import { createRuntimeCommandId, type SubagentMessageRuntimeCommand } from "../command-queue.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  EnqueueSubagentMessageInput,
  EnqueueSubagentMessageResult,
} from "../types.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import { escapeXml } from "../../runtime-task/notification.js";
import { isTerminalRuntimeTask } from "../../runtime-task/registry.js";

function formatSubagentMessage(input: {
  agentId: string;
  agentType: string;
  summary: string;
  message: string;
}): string {
  return [
    "<subagent-message>",
    `<agent-id>${escapeXml(input.agentId)}</agent-id>`,
    `<agent-type>${escapeXml(input.agentType)}</agent-type>`,
    `<summary>${escapeXml(input.summary)}</summary>`,
    `<message>${escapeXml(input.message)}</message>`,
    "</subagent-message>",
  ].join("\n");
}

export function enqueueSubagentMessage(
  this: AgentRuntimeInternal,
  input: EnqueueSubagentMessageInput,
): EnqueueSubagentMessageResult | undefined {
  const branchGeneration =
    this.runtimeTaskRegistry.get(input.agentId)?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch subagent response", {
      ...traceContextToLogContext(input.traceContext),
      agentId: input.agentId,
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "subagent.response.stale_branch_dropped",
      module: "core.runtime",
      responseId: input.responseId,
    });
    return undefined;
  }
  const command = {
    branchGeneration,
    responseId: input.responseId,
    agentId: input.agentId,
    agentType: input.agentType,
    childSessionId: input.childSessionId,
    childToolCallId: input.childToolCallId,
    ...(input.parentToolCallId ? { parentToolCallId: input.parentToolCallId } : {}),
    summary: input.summary,
    messageLength: input.message.length,
    traceContext: input.traceContext,
    createdAt: new Date(),
    id: createRuntimeCommandId(),
    mode: "subagent-message" as const,
    priority: "next" as const,
    source: "subagent_message" as const,
    text: formatSubagentMessage(input),
  } satisfies SubagentMessageRuntimeCommand;

  this.logger?.debug("Subagent response enqueued into runtime command queue", {
    ...traceContextToLogContext(command.traceContext),
    agentId: command.agentId,
    commandId: command.id,
    event: "subagent.response.runtime_enqueued",
    messageLength: command.messageLength,
    module: "core.runtime",
    queueSize: this.runtimeCommandQueue.size() + 1,
    responseId: command.responseId,
    summary: command.summary.slice(0, 200),
  });
  this.enqueueRuntimeCommand(command);
  // 回复只有「协调者让出当前工具等待」之后才可能被读到。协调者若正前台 await 这个
  // agent 的 Agent 工具（tool_use 与 tool_result 之间不能插 user 消息），唯一合法的
  // 放行方式就是 requestBackground：Agent 工具先返回 async_launched，已入队的回复
  // 随后在 prompt command 之后的 drain / mid-turn 注入被消费。必须先入队再转后台，
  // 保证 Agent 结果返回时消息已经在队列里。
  const task = this.runtimeTaskRegistry.get(input.agentId);
  if (
    !task ||
    task.type !== "local_agent" ||
    task.isBackgrounded ||
    isTerminalRuntimeTask(task)
  ) {
    return undefined;
  }
  if (task.foregroundModelOverride === true) {
    // 借用的前台模型覆盖（闲时轮）下 runner 的 Promise.race 不认 background 请求；
    // requestBackground 只会改快照、放行不了等待，必须诚实报告 busy 而不是假装释放。
    return { foregroundWaitReleased: false, foregroundWaitBusy: true };
  }
  if (!this.runtimeTaskRegistry.requestBackground(input.agentId)) {
    return undefined;
  }
  this.logger?.info("Foreground agent wait released by subagent response", {
    ...traceContextToLogContext(command.traceContext),
    agentId: command.agentId,
    event: "subagent.response.foreground_wait_released",
    module: "core.runtime",
    responseId: command.responseId,
  });
  return { foregroundWaitReleased: true };
}

export async function persistSubagentMessageCommand(
  this: AgentRuntimeInternal,
  command: SubagentMessageRuntimeCommand,
  midTurn = false,
): Promise<MessageId> {
  await this.ensureContextInitialized(command.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "subagent_reply_steer" : "subagent_reply";
  this.messageHistory.addUser(command.text, runtimeInputMetadata(inputPresentation));
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    sessionId: this.sessionId,
    source: "subagent_message",
    text: command.text,
    traceContext: command.traceContext,
    visibility: "model-only",
    metadata: {
      inputPresentation,
      subagentMessage: {
        responseId: command.responseId,
        agentId: command.agentId,
        agentType: command.agentType,
        childSessionId: command.childSessionId,
        childToolCallId: command.childToolCallId,
        ...(command.parentToolCallId ? { parentToolCallId: command.parentToolCallId } : {}),
      },
    },
  });
  return messageID;
}
