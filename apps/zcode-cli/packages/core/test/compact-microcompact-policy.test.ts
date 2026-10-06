import assert from "node:assert/strict";
import test from "node:test";
import {
  MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE,
  maybeLocalMicrocompactMessages,
} from "../src/compact/microcompact.js";
import type { LocalMicrocompactMessage } from "../src/compact/microcompact.js";
import { resolveLocalMicrocompactConfig } from "../src/runtime/methods/compact-policy-config.js";

/**
 * 局部压缩（microcompact）策略契约（spec: core/spec/context-compaction-controls.md §2 D1、§3.2）：
 * - `keepRecentToolResults` 决定保留最近几组工具结果；
 * - `clearErrorResults=false` 时失败的工具结果不参与清理；
 * - 含媒体（image/video/file）的工具结果永不清；
 * - `enabled` 非 true 时整体不动（默认关闭 = 维持现状）。
 */

function assistantWithToolCall(id: string): LocalMicrocompactMessage {
  return {
    content: `calling ${id}`,
    role: "assistant",
    toolCalls: [{ input: {}, name: "Read" }],
  };
}

function toolResult(
  id: string,
  options: { content?: LocalMicrocompactMessage["content"]; isError?: boolean } = {},
): LocalMicrocompactMessage {
  return {
    content: options.content ?? `result body of ${id} `.repeat(20),
    isError: options.isError,
    role: "tool",
    toolCallId: id,
    toolName: "Read",
  };
}

/** 三个"assistant 起始轮"，每轮一个可清理工具结果。 */
function threeToolRounds(): LocalMicrocompactMessage[] {
  return [
    assistantWithToolCall("call-1"),
    toolResult("call-1"),
    assistantWithToolCall("call-2"),
    toolResult("call-2"),
    assistantWithToolCall("call-3"),
    toolResult("call-3"),
  ];
}

function microcompactConfig(
  overrides: Partial<Parameters<typeof maybeLocalMicrocompactMessages>[0]["config"]> = {},
): Parameters<typeof maybeLocalMicrocompactMessages>[0]["config"] {
  // thresholdTokens:0 + minTokenSavings:1 让判定只由 keep/clear 语义决定，
  // 不依赖 token 估算的具体数值。
  return { enabled: true, minTokenSavings: 1, thresholdTokens: 0, ...overrides };
}

test("enabled:false 时局部压缩整体不动", () => {
  const result = maybeLocalMicrocompactMessages({
    config: { enabled: false, minTokenSavings: 1, thresholdTokens: 0 },
    messages: threeToolRounds(),
  });
  assert.equal(result.decision.reason, "disabled");
  assert.equal(result.payload, undefined);
  assert.equal(
    result.messages.some((message) => message.content === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE),
    false,
  );
});

test("默认关闭：未显式开启时运行时的门把 microcompact 压成 enabled:false", () => {
  // 这个门在 resolveLocalMicrocompactConfig（runtime/methods/compact-policy-config.ts）：
  // 缺省即关。局部压缩会就地改写历史里的工具结果正文，必须显式开启。
  const threshold = 166_000;
  const unset = resolveLocalMicrocompactConfig({ contextWindow: 200_000 });
  assert.equal(unset.enabled, false);
  assert.equal(unset.thresholdTokens, Math.min(Math.floor(threshold * 0.9), threshold - 2_000));

  const enabled = resolveLocalMicrocompactConfig({
    contextWindow: 200_000,
    microcompact: { enabled: true, keepRecentToolResults: 2 },
  });
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.keepRecentToolResults, 2);
});

test("keepRecentToolResults 决定保留最近几组工具结果", () => {
  const result = maybeLocalMicrocompactMessages({
    config: microcompactConfig({ keepRecentToolResults: 1 }),
    messages: threeToolRounds(),
  });
  assert.equal(result.payload?.clearedToolCallIds.length, 2);
  assert.deepEqual(result.payload?.keptToolCallIds, ["call-3"]);
  assert.equal(result.messages[1]?.content, MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE);
  assert.equal(result.messages[3]?.content, MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE);
  assert.notEqual(result.messages[5]?.content, MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE);
});

test("keepRecentToolResults 覆盖全部候选组时没有可清理内容", () => {
  const result = maybeLocalMicrocompactMessages({
    config: microcompactConfig({ keepRecentToolResults: 5 }),
    messages: threeToolRounds(),
  });
  assert.equal(result.decision.reason, "nothing_to_clear");
  assert.equal(result.payload, undefined);
});

test("clearErrorResults=false 时失败的工具结果不参与清理，也不计入候选组", () => {
  const messages = threeToolRounds();
  messages[1] = toolResult("call-1", { isError: true });

  const notCleared = maybeLocalMicrocompactMessages({
    config: microcompactConfig({ clearErrorResults: false, keepRecentToolResults: 1 }),
    messages,
  });
  // 只剩 call-2 / call-3 两个候选组，保留 1 组 → 只清 call-2，失败的 call-1 原文保留。
  assert.deepEqual(notCleared.payload?.clearedToolCallIds, ["call-2"]);
  assert.equal(
    String(notCleared.messages[1]?.content).startsWith("result body of call-1"),
    true,
  );

  const cleared = maybeLocalMicrocompactMessages({
    config: microcompactConfig({ clearErrorResults: true, keepRecentToolResults: 1 }),
    messages,
  });
  assert.equal(cleared.payload?.clearedToolCallIds.includes("call-1"), true);
  assert.equal(cleared.messages[1]?.content, MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE);
});

test("含媒体的工具结果永不清", () => {
  const messages = threeToolRounds();
  messages[1] = toolResult("call-1", {
    content: [
      { type: "text", text: "screenshot" },
      { data: "aGVsbG8=", mediaType: "image/png", type: "image" },
    ] as unknown as LocalMicrocompactMessage["content"],
  });

  const result = maybeLocalMicrocompactMessages({
    config: microcompactConfig({ keepRecentToolResults: 1 }),
    messages,
  });
  assert.equal(result.payload?.clearedToolCallIds.includes("call-1"), false);
  assert.equal(Array.isArray(result.messages[1]?.content), true);
});
