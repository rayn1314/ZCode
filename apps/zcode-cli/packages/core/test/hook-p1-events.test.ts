import assert from "node:assert/strict";
import test from "node:test";
import { HookEventName } from "@zcode/contracts";
import { processHookOutput } from "../src/hooks/output.js";

/**
 * P1 新事件契约（spec: core/spec/hook-framework-expansion.md §3 D5、§4.1）：
 * - PreCompact 可阻断：continue:false 产生 blockRequested；
 * - PostCompact / SubagentStart / SessionEnd 不可阻断：continue:false 不产生阻断字段，
 *   但 additionalContext 仍注入；
 * - Stop 的 decision:"block" 语义是"请求继续"，不受 blockable 抑制（stopShouldContinue 保持）；
 * - 新事件的 HookSpecificOutput additionalContext 注入。
 */

test("PreCompact 可阻断：continue:false 产生 blockRequested", () => {
  const result = processHookOutput(HookEventName.PreCompact, {
    continue: false,
    reason: "hold on",
  });
  assert.equal(result.blockRequested, true);
  assert.equal(result.stopReason, "hold on");
});

test("PostCompact 不可阻断：continue:false 不产生 blockRequested，additionalContext 仍注入", () => {
  const result = processHookOutput(HookEventName.PostCompact, {
    additionalContext: "compacted",
    continue: false,
    reason: "should be ignored",
  });
  assert.equal(result.blockRequested, undefined);
  assert.equal(result.preventContinuation, undefined);
  assert.deepEqual(result.additionalContexts, ["compacted"]);
});

test("SubagentStart 不可阻断：continue:false 不产生阻断字段", () => {
  const result = processHookOutput(HookEventName.SubagentStart, {
    continue: false,
    reason: "should be ignored",
  });
  assert.equal(result.blockRequested, undefined);
  assert.equal(result.preventContinuation, undefined);
});

test("SessionEnd 不可阻断：continue:false 不产生阻断字段", () => {
  const result = processHookOutput(HookEventName.SessionEnd, {
    continue: false,
    reason: "should be ignored",
  });
  assert.equal(result.blockRequested, undefined);
  assert.equal(result.preventContinuation, undefined);
});

test("Stop decision:block 不受 blockable 抑制（stopShouldContinue 保持）", () => {
  const result = processHookOutput(HookEventName.Stop, {
    decision: "block",
    reason: "keep going",
    systemMessage: "continue",
  });
  assert.equal(result.stopShouldContinue, true);
  assert.equal(result.blockRequested, undefined);
  assert.deepEqual(result.additionalContexts, ["continue", "keep going"]);
});

test("新事件 HookSpecificOutput 的 additionalContext 注入", () => {
  for (const event of [
    HookEventName.PreCompact,
    HookEventName.PostCompact,
    HookEventName.SubagentStart,
    HookEventName.SubagentStop,
    HookEventName.SessionEnd,
  ]) {
    const result = processHookOutput(event, {
      hookSpecificOutput: { hookEventName: event, additionalContext: "ctx" },
    });
    assert.deepEqual(result.additionalContexts, ["ctx"], `event ${event} 应注入上下文`);
    assert.equal(result.blockRequested, undefined);
  }
});