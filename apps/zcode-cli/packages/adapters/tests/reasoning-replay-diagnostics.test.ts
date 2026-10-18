import { describe, expect, it } from "vitest";
import type { ModelInputMessage } from "@zcode/contracts";
import { summarizeReasoningReplay } from "../src/model/reasoning-replay-diagnostics.js";

describe("summarizeReasoningReplay", () => {
  it("counts reasoning blocks on assistant messages", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thought" },
          { type: "text", text: "answer" },
        ],
      },
      { role: "user", content: "next" },
    ];

    expect(summarizeReasoningReplay(messages)).toEqual({
      assistantMessages: 1,
      assistantMessagesWithoutReasoning: 0,
      emptyReasoningBlocks: 0,
      reasoningBlocks: 1,
    });
  });

  it("counts an assistant message whose content is a plain string as having no reasoning", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: "" },
      { role: "user", content: "next" },
    ];

    expect(summarizeReasoningReplay(messages)).toEqual({
      assistantMessages: 1,
      assistantMessagesWithoutReasoning: 1,
      emptyReasoningBlocks: 0,
      reasoningBlocks: 0,
    });
  });

  it("counts a tool-call-only assistant message as having no reasoning", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "start" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "Read", input: { file_path: "README.md" } }],
      },
      { role: "tool", content: "result", toolCallId: "call_1", toolName: "Read" },
    ];

    expect(summarizeReasoningReplay(messages)).toEqual({
      assistantMessages: 1,
      assistantMessagesWithoutReasoning: 1,
      emptyReasoningBlocks: 0,
      reasoningBlocks: 0,
    });
  });

  it("counts empty-text reasoning blocks separately from populated ones", () => {
    const messages: ModelInputMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "   " },
          { type: "reasoning", text: "real thought" },
          { type: "text", text: "answer" },
        ],
      },
    ];

    expect(summarizeReasoningReplay(messages)).toEqual({
      assistantMessages: 1,
      assistantMessagesWithoutReasoning: 0,
      emptyReasoningBlocks: 1,
      reasoningBlocks: 2,
    });
  });

  it("ignores non-assistant messages and reports zeroes when there is no assistant turn", () => {
    const messages: ModelInputMessage[] = [
      { role: "system", content: "policy" },
      { role: "user", content: "start" },
    ];

    expect(summarizeReasoningReplay(messages)).toEqual({
      assistantMessages: 0,
      assistantMessagesWithoutReasoning: 0,
      emptyReasoningBlocks: 0,
      reasoningBlocks: 0,
    });
  });

  it("aggregates mixed assistant history", () => {
    const messages: ModelInputMessage[] = [
      { role: "user", content: "start" },
      { role: "assistant", content: [{ type: "reasoning", text: "one" }] },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call_1", name: "Read", input: {} }],
      },
      { role: "assistant", content: [{ type: "reasoning", text: "" }] },
    ];

    expect(summarizeReasoningReplay(messages)).toEqual({
      assistantMessages: 3,
      assistantMessagesWithoutReasoning: 1,
      emptyReasoningBlocks: 1,
      reasoningBlocks: 2,
    });
  });
});
