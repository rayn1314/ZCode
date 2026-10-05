import assert from "node:assert/strict";
import test from "node:test";
import {
  HookEventName,
  HookOutcome,
  SessionEventType,
  type HookInput,
  type SessionEvent,
} from "@zcode/contracts";
import { mergeHookRunResult, processHookOutput } from "../src/hooks/output.js";
import { createInMemoryHookRunner } from "../src/hooks/runner.js";

/**
 * P3 协议补全与第二波观察类事件契约（spec: core/spec/hook-framework-expansion.md
 * §4.2、§7、§9）：
 * - PostToolUse 支持 updatedToolOutput 注入（hookSpecificOutput 与顶层兼容字段）；
 * - 顶层 updatedToolOutput 是兼容别名，优先级低于 hookSpecificOutput（后写覆盖）；
 * - PermissionDenied / PostToolBatch / Notification / PreModelSwitch / PostModelSwitch
 *   的 HookSpecificOutput additionalContext 注入；
 * - mergeHookRunResult 对 updatedToolOutput 做后写覆盖。
 */

test("PostToolUse hookSpecificOutput.updatedToolOutput 注入", () => {
  const result = processHookOutput(HookEventName.PostToolUse, {
    hookSpecificOutput: {
      hookEventName: HookEventName.PostToolUse,
      updatedToolOutput: { text: "rewritten" },
    },
  });
  assert.deepEqual(result.updatedToolOutput, { text: "rewritten" });
});

test("PostToolUse 顶层 updatedToolOutput 注入", () => {
  const result = processHookOutput(HookEventName.PostToolUse, {
    updatedToolOutput: "top-level",
  });
  assert.equal(result.updatedToolOutput, "top-level");
});

test("PostToolUse 顶层 updatedToolOutput 被 hookSpecificOutput 后写覆盖", () => {
  const result = processHookOutput(HookEventName.PostToolUse, {
    updatedToolOutput: "top-level",
    hookSpecificOutput: {
      hookEventName: HookEventName.PostToolUse,
      updatedToolOutput: "specific",
    },
  });
  assert.equal(result.updatedToolOutput, "specific");
});

test("非 PostToolUse 事件忽略顶层 updatedToolOutput", () => {
  const result = processHookOutput(HookEventName.PreToolUse, {
    updatedToolOutput: "ignored",
  });
  assert.equal(result.updatedToolOutput, undefined);
});

test("第二波新事件 HookSpecificOutput 的 additionalContext 注入", () => {
  for (const event of [
    HookEventName.PermissionDenied,
    HookEventName.PostToolBatch,
    HookEventName.Notification,
    HookEventName.PreModelSwitch,
    HookEventName.PostModelSwitch,
  ]) {
    const result = processHookOutput(event, {
      hookSpecificOutput: { hookEventName: event, additionalContext: "ctx" },
    });
    assert.deepEqual(result.additionalContexts, ["ctx"], `event ${event} 应注入上下文`);
    assert.equal(result.blockRequested, undefined, `event ${event} 不应产生阻断字段`);
  }
});

test("第二波新事件不可阻断：continue:false 不产生阻断字段", () => {
  for (const event of [
    HookEventName.PermissionDenied,
    HookEventName.PostToolBatch,
    HookEventName.Notification,
    HookEventName.PreModelSwitch,
    HookEventName.PostModelSwitch,
  ]) {
    const result = processHookOutput(event, {
      continue: false,
      reason: "should be ignored",
    });
    assert.equal(result.blockRequested, undefined, `event ${event} 不应阻断`);
    assert.equal(result.preventContinuation, undefined, `event ${event} 不应禁止续跑`);
  }
});

test("mergeHookRunResult 对 updatedToolOutput 后写覆盖", () => {
  const target = { additionalContexts: [] as string[] };
  mergeHookRunResult(target, { additionalContexts: [], updatedToolOutput: "first" });
  assert.equal(target.updatedToolOutput, "first");

  mergeHookRunResult(target, { additionalContexts: [], updatedToolOutput: "second" });
  assert.equal(target.updatedToolOutput, "second");

  // next 未携带 updatedToolOutput 时保留既有值。
  mergeHookRunResult(target, { additionalContexts: ["ctx"] });
  assert.equal(target.updatedToolOutput, "second");
  assert.deepEqual(target.additionalContexts, ["ctx"]);
});

function makeInput(hookEventName: HookEventName, extra: Record<string, unknown> = {}): HookInput {
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

test("runner：once hook 只执行一次", async () => {
  let calls = 0;
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.SessionStart,
        once: true,
        source: "config.SessionStart.0.0",
        callback: () => {
          calls += 1;
          return { additionalContext: "once" };
        },
      },
    ],
  });

  const first = await runner.run(makeInput(HookEventName.SessionStart));
  const second = await runner.run(makeInput(HookEventName.SessionStart));
  assert.equal(calls, 1);
  assert.equal(first.additionalContexts.length, 1);
  assert.equal(second.additionalContexts.length, 0, "第二次执行应被 once 跳过");
});

test("runner：once hook 失败后也不再执行", async () => {
  let calls = 0;
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.SessionStart,
        once: true,
        source: "config.SessionStart.0.0",
        callback: () => {
          calls += 1;
          throw new Error("boom");
        },
      },
    ],
  });

  await runner.run(makeInput(HookEventName.SessionStart));
  await runner.run(makeInput(HookEventName.SessionStart));
  assert.equal(calls, 1, "失败后 once hook 也应跳过");
});

test("runner：不同 source 的 once hook 各自执行一次", async () => {
  let calls = 0;
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.SessionStart,
        once: true,
        source: "config.SessionStart.0.0",
        callback: () => {
          calls += 1;
        },
      },
      {
        event: HookEventName.SessionStart,
        once: true,
        source: "config.SessionStart.0.1",
        callback: () => {
          calls += 1;
        },
      },
    ],
  });

  await runner.run(makeInput(HookEventName.SessionStart));
  await runner.run(makeInput(HookEventName.SessionStart));
  assert.equal(calls, 2);
});

test("runner：failClosed 把可阻断事件的同步失败转化为阻断", async () => {
  const events: SessionEvent[] = [];
  const runner = createInMemoryHookRunner({
    emitEvent: async (event) => {
      events.push(event);
    },
    hooks: [
      {
        event: HookEventName.PreToolUse,
        failClosed: true,
        callback: () => {
          throw new Error("denied by fail-closed hook");
        },
      },
    ],
  });

  const result = await runner.run(makeInput(HookEventName.PreToolUse));
  assert.equal(result.blockRequested, true);
  assert.equal(result.stopReason, "denied by fail-closed hook");
  assert.equal(result.permissionBehavior, "deny");
  assert.equal(result.preventContinuation, true);

  const blocked = events.find((event) => event.type === SessionEventType.HookRunBlocked);
  assert.ok(blocked, "应发出 HookRunBlocked 事件");
  assert.equal(blocked.payload.outcome, HookOutcome.Blocked);
});

test("runner：failClosed 对不可阻断事件无效（保持 fail-open）", async () => {
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.PostToolUse,
        failClosed: true,
        callback: () => {
          throw new Error("post tool hook exploded");
        },
      },
    ],
  });

  const result = await runner.run(makeInput(HookEventName.PostToolUse));
  assert.equal(result.blockRequested, undefined);
  assert.equal(result.stopReason, undefined);
  assert.equal(result.permissionBehavior, undefined);
});

test("runner：未配置 failClosed 的可阻断事件失败仍不阻断", async () => {
  const runner = createInMemoryHookRunner({
    hooks: [
      {
        event: HookEventName.PreToolUse,
        callback: () => {
          throw new Error("default fail-open");
        },
      },
    ],
  });

  const result = await runner.run(makeInput(HookEventName.PreToolUse));
  assert.equal(result.blockRequested, undefined);
});
