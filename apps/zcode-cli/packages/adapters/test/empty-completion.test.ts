import assert from "node:assert/strict";
import test from "node:test";
import { isZeroOutputModelCompletion } from "../src/model/runner-diagnostics.js";

/**
 * 核心契约：适配器的"空 completion 重试一次"闸门只看两件事——
 * 没有可交付输出（正文与工具调用都为空），以及 provider 给出过终态但终态不是正常结束。
 *
 * 回归背景：曾经额外要求 `reasoningLength === 0`，把"推理被上游截断、正文为空"
 * 这一类整体挡在重试之外，turn 于是被静默当成正常收尾。reasoning 是内部思考，
 * 不是可交付输出，不能作为判据。
 */
test("命中：终态非正常结束且没有任何可交付输出", () => {
  for (const finishReason of ["other", "unknown", "length", "error"]) {
    assert.equal(
      isZeroOutputModelCompletion({ finishReason, textLength: 0, toolCallCount: 0 }),
      true,
      `${finishReason} 应当被判为可疑空 completion`,
    );
  }
});

test("不命中：正常终态", () => {
  for (const finishReason of ["stop", "tool-calls", "tool_calls", " STOP ", "Tool-Calls"]) {
    assert.equal(
      isZeroOutputModelCompletion({ finishReason, textLength: 0, toolCallCount: 0 }),
      false,
      `${finishReason} 是正常终态，不应触发重试`,
    );
  }
});

test("不命中：有可交付输出", () => {
  assert.equal(
    isZeroOutputModelCompletion({ finishReason: "other", textLength: 1, toolCallCount: 0 }),
    false,
  );
  assert.equal(
    isZeroOutputModelCompletion({ finishReason: "other", textLength: 0, toolCallCount: 1 }),
    false,
  );
});

test("不命中：有明确原因的终态交给 core 处理", () => {
  // 上下文超限、拒答、内容过滤都有明确原因（见 EMPTY_COMPLETION_RETRY_EXCLUSIONS），
  // 重试改变不了结果，交给 core 走各自的失败链。
  for (const finishReason of [
    "content-filter",
    "content_filter",
    "refusal",
    "context_exceeded",
    "context_length_exceeded",
    "prompt_too_long",
  ]) {
    assert.equal(
      isZeroOutputModelCompletion({ finishReason, textLength: 0, toolCallCount: 0 }),
      false,
      `${finishReason} 有明确原因，不应触发适配器重试`,
    );
  }
});

test("不命中：provider 没有给出终态信号", () => {
  // 没有 finishReason 的流由 core 与流恢复处理，不由适配器重试。
  assert.equal(
    isZeroOutputModelCompletion({ finishReason: undefined, textLength: 0, toolCallCount: 0 }),
    false,
  );
});
