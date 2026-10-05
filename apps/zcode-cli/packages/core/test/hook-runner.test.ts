import assert from "node:assert/strict";
import test from "node:test";
import {
  HookEventName,
  HookOutcome,
  SessionEventType,
  type HookInput,
  type SessionEvent,
} from "@zcode/contracts";
import { createInMemoryHookRunner } from "../src/hooks/runner.js";
import {
  matchesHookMatcher,
  mergeHookRunResult,
  processHookOutput,
} from "../src/hooks/output.js";

/**
 * In-memory hook runner 的基线契约（spec: core/spec/hook-framework-expansion.md D7）：
 * - matcher 命中/不命中决定是否执行；
 * - continue:false（exit 2 的 JSON 语义）阻断并把 permissionBehavior 置 deny；
 * - callback 抛错（非零退出路径）只记失败事件，不把 blockRequested 置真；
 * - 超时只记 timed_out 事件，不阻断；
 * - processHookOutput 负责 additionalContext 注入；
 * - 权限合并 deny>ask>allow，alwaysAsk 不被 allow 静默放行。
 */

function makeInput(
  hookEventName: HookEventName,
  extra: Record<string, unknown> = {},
): HookInput {
  return {
    hookEventName,
    cwd: "/tmp",
    mode: "plan",
    sessionId: "sess_1",
    timestamp: "2026-10-05T00:00:00.000Z",
    traceId: "trace_1",
    turnId: "turn_1",
    ...extra,
  } as HookInput;
}

test("matchesHookMatcher：通配/字面量/正则/不命中", () => {
  assert.equal(matchesHookMatcher("Bash", undefined), true);
  assert.equal(matchesHookMatcher("Bash", "*"), true);
  assert.equal(matchesHookMatcher("Bash", "Bash|Write"), true);
  assert.equal(matchesHookMatcher("Read", "Bash|Write"), false);
  assert.equal(matchesHookMatcher("Bash", "^(Bash|Write)$"), true);
  assert.equal(matchesHookMatcher("Read", "^(Bash|Write)$"), false);
  assert.equal(matchesHookMatcher("", "Bash|Write"), false);
});

test("runner：matcher 命中才执行，不命中不产生 blockRequested", async () => {
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.PreToolUse,
        matcher: "Bash",
        callback: () => ({ continue: false, reason: "blocked" }),
      },
    ],
  });

  const hit = await runner.run(makeInput(HookEventName.PreToolUse), { matchValue: "Bash" });
  assert.equal(hit.blockRequested, true);
  assert.equal(hit.stopReason, "blocked");

  const miss = await runner.run(makeInput(HookEventName.PreToolUse), { matchValue: "Read" });
  assert.equal(miss.blockRequested, undefined);
});

test("runner：continue:false（exit 2 的 JSON 语义）阻断并置 deny", async () => {
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.PreToolUse,
        callback: () => ({ continue: false, reason: "policy" }),
      },
    ],
  });

  const result = await runner.run(makeInput(HookEventName.PreToolUse));
  assert.equal(result.blockRequested, true);
  assert.equal(result.stopReason, "policy");
  assert.equal(result.permissionBehavior, "deny");
  assert.equal(result.preventContinuation, true);
});

test("runner：callback 抛错（非零退出路径）不把 blockRequested 置真", async () => {
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    emitEvent: async (event) => {
      events.push(event);
    },
    hooks: [
      {
        event: HookEventName.PreToolUse,
        callback: () => {
          throw new Error("hook process exploded");
        },
      },
    ],
  });

  const result = await runner.run(makeInput(HookEventName.PreToolUse));
  assert.equal(result.blockRequested, undefined);

  const failed = events.find((event) => event.type === SessionEventType.HookRunFailed);
  assert.ok(failed, "应发出 HookRunFailed 事件");
  assert.equal(failed.payload.outcome, HookOutcome.Failed);
});

test("runner：超时只记 timed_out 事件，不阻断", async () => {
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    defaultTimeoutMs: 20,
    emitEvent: async (event) => {
      events.push(event);
    },
    hooks: [
      {
        event: HookEventName.PreToolUse,
        timeoutMs: 20,
        // 回调挂起直到超时信号 abort 才 reject（模拟真实进程永不返回）。
        callback: (_input, context) =>
          new Promise((_resolve, reject) => {
            context.signal?.addEventListener(
              "abort",
              () => reject(new Error("aborted by timeout")),
              { once: true },
            );
          }),
      },
    ],
  });

  // runner 的超时定时器是 unref 的；测试进程没有其它活跃句柄时它不会触发，
  // 这里用一个 ref 的 interval 保持事件循环存活，让超时正常发生。
  const keepAlive = setInterval(() => {}, 50);
  try {
    const result = await runner.run(makeInput(HookEventName.PreToolUse));
    assert.equal(result.blockRequested, undefined);
  } finally {
    clearInterval(keepAlive);
  }

  const failed = events.find((event) => event.type === SessionEventType.HookRunFailed);
  assert.ok(failed, "应发出 HookRunFailed 事件");
  assert.equal(failed.payload.outcome, HookOutcome.TimedOut);
});

test("processHookOutput：additionalContext 注入 additionalContexts", () => {
  const result = processHookOutput(HookEventName.SessionStart, {
    additionalContext: "ctx-a",
    additional_context: "ctx-b",
  });
  assert.deepEqual(result.additionalContexts, ["ctx-a", "ctx-b"]);
  assert.equal(result.blockRequested, undefined);
});

test("processHookOutput：hookSpecificOutput 的 additionalContext 也注入", () => {
  const result = processHookOutput(HookEventName.PostToolUse, {
    hookSpecificOutput: {
      hookEventName: HookEventName.PostToolUse,
      additionalContext: "ctx-specific",
    },
  });
  assert.deepEqual(result.additionalContexts, ["ctx-specific"]);
});

test("mergeHookRunResult：权限合并 deny>ask>allow，alwaysAsk 不被 allow 静默放行", () => {
  const target = { additionalContexts: [] };
  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "allow" });
  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "ask" });
  assert.equal(target.permissionBehavior, "ask", "ask 应压过 allow");

  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "deny" });
  assert.equal(target.permissionBehavior, "deny", "deny 应压过 ask");

  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "allow" });
  assert.equal(target.permissionBehavior, "deny", "deny 之后 allow 不能覆盖");
});