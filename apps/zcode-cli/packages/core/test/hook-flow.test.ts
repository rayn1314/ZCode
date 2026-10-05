import assert from "node:assert/strict";
import test from "node:test";
import { HookEventName } from "@zcode/contracts";
import { mergeHookRunResult, processHookOutput } from "../src/hooks/output.js";

/**
 * 工具链路四个事件的 processHookOutput 决策合并（spec: core/spec/hook-framework-expansion.md D7）：
 * - permissionBehavior 最严获胜（deny>ask>allow）；
 * - permissionRequestResult / updatedInput / stopShouldContinue 后写覆盖；
 * - PreToolUse/PermissionRequest 是权限事件，continue:false 会带 deny 与 preventContinuation；
 * - PostToolUse/PostToolUseFailure 是观察类事件（blockable:false，P1 接引擎后 continue:false 不阻断）。
 */

test("PreToolUse：continue:false 阻断且 preventContinuation + deny", () => {
  const result = processHookOutput(HookEventName.PreToolUse, {
    continue: false,
    reason: "no",
  });
  assert.equal(result.blockRequested, true);
  assert.equal(result.preventContinuation, true);
  assert.equal(result.permissionBehavior, "deny");
  assert.equal(result.stopReason, "no");
});

test("PreToolUse：decision approve → allow，block → deny", () => {
  const approved = processHookOutput(HookEventName.PreToolUse, { decision: "approve" });
  assert.equal(approved.permissionBehavior, "allow");
  assert.equal(approved.blockRequested, undefined);

  const blocked = processHookOutput(HookEventName.PreToolUse, { decision: "block", reason: "x" });
  assert.equal(blocked.permissionBehavior, "deny");
  assert.equal(blocked.blockRequested, true);
  assert.equal(blocked.preventContinuation, true);
});

test("PreToolUse：hookSpecificOutput 的 permissionDecision 与 updatedInput", () => {
  const result = processHookOutput(HookEventName.PreToolUse, {
    hookSpecificOutput: {
      hookEventName: HookEventName.PreToolUse,
      permissionDecision: "deny",
      permissionDecisionReason: "policy",
      updatedInput: { toolName: "Bash", args: ["--dry-run"] },
    },
  });
  assert.equal(result.permissionBehavior, "deny");
  assert.equal(result.hookPermissionDecisionReason, "policy");
  assert.deepEqual(result.updatedInput, { toolName: "Bash", args: ["--dry-run"] });
});

test("PermissionRequest：decision approve → allow", () => {
  const result = processHookOutput(HookEventName.PermissionRequest, { decision: "approve" });
  assert.equal(result.permissionBehavior, "allow");
});

test("PermissionRequest：hookSpecificOutput decision 写入 permissionRequestResult", () => {
  const result = processHookOutput(HookEventName.PermissionRequest, {
    hookSpecificOutput: {
      hookEventName: HookEventName.PermissionRequest,
      decision: { behavior: "deny", message: "no" },
    },
  });
  assert.deepEqual(result.permissionRequestResult, { behavior: "deny", message: "no" });
});

test("PostToolUse：观察类，continue:false 不阻断且不参与权限合并", () => {
  const result = processHookOutput(HookEventName.PostToolUse, {
    additionalContext: "done",
    continue: false,
    reason: "stop",
  });
  assert.equal(result.blockRequested, undefined);
  assert.equal(result.preventContinuation, undefined);
  assert.equal(result.permissionBehavior, undefined);
  assert.deepEqual(result.additionalContexts, ["done"]);
});

test("PostToolUseFailure：additionalContext 注入，continue:false 不阻断（观察类）", () => {
  const ctx = processHookOutput(HookEventName.PostToolUseFailure, {
    hookSpecificOutput: {
      hookEventName: HookEventName.PostToolUseFailure,
      additionalContext: "recover",
    },
  });
  assert.deepEqual(ctx.additionalContexts, ["recover"]);

  const blocked = processHookOutput(HookEventName.PostToolUseFailure, {
    additionalContext: "still",
    continue: false,
  });
  assert.equal(blocked.blockRequested, undefined);
  assert.equal(blocked.preventContinuation, undefined);
  assert.deepEqual(blocked.additionalContexts, ["still"]);
});

test("processHookOutput：hookSpecificOutput 事件名不匹配抛错", () => {
  assert.throws(
    () =>
      processHookOutput(HookEventName.PreToolUse, {
        hookSpecificOutput: { hookEventName: HookEventName.Stop },
      }),
    /wrong event name/,
  );
});

test("mergeHookRunResult：permissionBehavior 最严获胜 deny>ask>allow", () => {
  const target = { additionalContexts: [] };
  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "allow" });
  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "ask" });
  assert.equal(target.permissionBehavior, "ask");

  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "deny" });
  assert.equal(target.permissionBehavior, "deny");

  mergeHookRunResult(target, { additionalContexts: [], permissionBehavior: "allow" });
  assert.equal(target.permissionBehavior, "deny", "deny 之后 allow 不能覆盖");
});

test("mergeHookRunResult：permissionRequestResult / updatedInput / stopShouldContinue 后写覆盖", () => {
  const target = { additionalContexts: [] };
  mergeHookRunResult(target, {
    additionalContexts: [],
    permissionRequestResult: { behavior: "deny", message: "first" },
    updatedInput: { a: 1 },
    stopShouldContinue: false,
  });
  mergeHookRunResult(target, {
    additionalContexts: [],
    permissionRequestResult: { behavior: "allow" },
    updatedInput: { a: 2 },
    stopShouldContinue: true,
    stopReason: "again",
  });

  assert.deepEqual(target.permissionRequestResult, { behavior: "allow" });
  assert.deepEqual(target.updatedInput, { a: 2 });
  assert.equal(target.stopShouldContinue, true);
});