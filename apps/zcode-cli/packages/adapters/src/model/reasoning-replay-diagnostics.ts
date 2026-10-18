import type { Logger, ModelInputMessage } from "@zcode/contracts";

/**
 * 一次模型请求里推理内容的回放形态摘要。
 *
 * 口径与落库过滤保持一致：`core` 侧的 `hasAssistantReasoningContent` 会丢弃
 * 「文本为空且无 providerOptions」的推理块，因此这里把该形态单独计数，
 * 便于判断请求里的推理块是不是被那条规则吃掉了。
 */
export interface ReasoningReplayShape {
  /** 请求里的 assistant 消息条数。 */
  assistantMessages: number;
  /** assistant 消息内 reasoning 内容块的总数。 */
  reasoningBlocks: number;
  /** 完全没有 reasoning 块的 assistant 消息条数。 */
  assistantMessagesWithoutReasoning: number;
  /** 文本为空的 reasoning 块条数。 */
  emptyReasoningBlocks: number;
}

export function summarizeReasoningReplay(
  messages: readonly ModelInputMessage[],
): ReasoningReplayShape {
  let assistantMessages = 0;
  let reasoningBlocks = 0;
  let assistantMessagesWithoutReasoning = 0;
  let emptyReasoningBlocks = 0;

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    assistantMessages += 1;

    // content 为字符串表示这条 assistant 消息没有任何结构化内容块，自然也没有推理块。
    const blocks = Array.isArray(message.content) ? message.content : [];
    const reasoning = blocks.filter((block) => block.type === "reasoning");
    if (reasoning.length === 0) {
      assistantMessagesWithoutReasoning += 1;
      continue;
    }

    reasoningBlocks += reasoning.length;
    emptyReasoningBlocks += reasoning.filter((block) => block.text.trim().length === 0).length;
  }

  return {
    assistantMessages,
    assistantMessagesWithoutReasoning,
    emptyReasoningBlocks,
    reasoningBlocks,
  };
}

/**
 * 记录模型请求的推理回放形态。
 *
 * 背景（bug：DeepSeek 系中转端点要求思考模式下回传 reasoning_content）：
 * 上游对「思考模式下历史 assistant 消息缺 reasoning_content」会直接返回 400
 * invalid_request，且这类失败偶发。而 model-io 轨迹按 MAX_ROLLOUT_FILES=3 轮转，
 * 失败发生后证据很快被覆盖，事后无法复盘（2026-10-19 实测：失败会话的轨迹已被删除，
 * 其 requestId/traceId 全库检索只命中无关会话）。这里把「有没有推理块」压缩成计数
 * 写进按天保留的主日志，使下次复现无需完整轨迹即可判断命中哪条路径。
 *
 * 只在请求已含 assistant 消息（即多轮）时记录：首轮请求没有可丢失的历史推理。
 */
export function logReasoningReplayShape(input: {
  logger?: Logger;
  messages: readonly ModelInputMessage[];
  modelId: string;
  providerId: string;
}): void {
  const shape = summarizeReasoningReplay(input.messages);
  if (shape.assistantMessages === 0) return;

  input.logger?.info("Model reasoning replay shape inspected", {
    ...shape,
    event: "model.reasoning.replay.shape",
    modelId: input.modelId,
    providerId: input.providerId,
  });
}
