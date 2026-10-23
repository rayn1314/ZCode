import { expect, it } from "vitest";
import type { LogContext, Logger, ModelInputMessage } from "@zcode/contracts";
import {
  logReasoningReplayShape,
  summarizeReasoningReplay,
} from "../../src/model/reasoning-replay-diagnostics/contract.js";
import { exampleModelReplayDiagnostics } from "../../src/model/reasoning-replay-diagnostics/contract.example.js";

interface CapturedLine {
  message: string;
  context?: LogContext;
}

function createLogger(): { logger: Logger; lines: CapturedLine[] } {
  const lines: CapturedLine[] = [];
  const logger: Logger = {
    debug: () => {},
    info: (message, context) => {
      lines.push({ message, ...(context ? { context } : {}) });
    },
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return { logger, lines };
}

function assistantWithReasoning(text: string): ModelInputMessage {
  return {
    role: "assistant",
    content: [
      { type: "reasoning", text },
      { type: "text", text: "答" },
    ],
  };
}

it("契约对象就是真实导出函数，计数口径可独立调用", () => {
  expect(exampleModelReplayDiagnostics.summarize).toBe(summarizeReasoningReplay);
  expect(exampleModelReplayDiagnostics.logShape).toBe(logReasoningReplayShape);
  expect(
    summarizeReasoningReplay([
      { role: "user", content: "开始" },
      assistantWithReasoning("   "),
      { role: "assistant", content: "无结构化内容块" },
    ]),
  ).toEqual({
    assistantMessages: 2,
    reasoningBlocks: 1,
    assistantMessagesWithoutReasoning: 1,
    // 空文本推理块单独计数：这正是落库过滤会丢弃的形态。
    emptyReasoningBlocks: 1,
  });
});

it("首轮请求（无 assistant 消息）不落日志", () => {
  const { logger, lines } = createLogger();
  logReasoningReplayShape({
    logger,
    messages: [
      { role: "system", content: "policy" },
      { role: "user", content: "开始" },
    ],
    modelId: "deepseek-v4.1-flash",
    providerId: "opencode-go-chat",
  });
  expect(lines).toEqual([]);
});

it("未注入 logger 时统计仍可调用，且完全不落日志", () => {
  expect(() =>
    logReasoningReplayShape({
      messages: [assistantWithReasoning("想法")],
      modelId: "deepseek-v4.1-flash",
      providerId: "opencode-go-chat",
    }),
  ).not.toThrow();
});

it("多轮请求只写一行 info，带稳定事件名与四个计数", () => {
  const { logger, lines } = createLogger();
  logReasoningReplayShape({
    logger,
    messages: [
      { role: "user", content: "开始" },
      assistantWithReasoning(""),
      { role: "tool", content: "结果", toolCallId: "call_1", toolName: "Read" },
    ],
    modelId: "deepseek-v4.1-flash",
    providerId: "opencode-go-chat",
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]?.message).toBe("Model reasoning replay shape inspected");
  expect(lines[0]?.context).toMatchObject({
    event: "model.reasoning.replay.shape",
    modelId: "deepseek-v4.1-flash",
    providerId: "opencode-go-chat",
    assistantMessages: 1,
    reasoningBlocks: 1,
    assistantMessagesWithoutReasoning: 0,
    emptyReasoningBlocks: 1,
  });
});
