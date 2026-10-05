import assert from "node:assert/strict";
import test from "node:test";
import { HOOK_EVENT_NAMES } from "@zcode/shared";
import {
  HookSpecificOutputSchema,
  HooksRuntimeConfigPatchSchema,
  canonicalWorkspaceHookEntrySchema,
} from "@zcode/contracts";

/**
 * contracts 侧 schema 副本的事件键集合必须与事件单源 HOOK_EVENT_NAMES 相等
 * （spec: core/spec/hook-framework-expansion.md §1.4/§5.2）。
 * P0 不收敛 contracts 副本与 shared schema 的字段差异（见 hook-schema-divergence.test.ts），
 * 但事件键集合必须一致：每个合法事件名都应被接受，非法事件名必须被拒绝。
 */

function matcherGroup() {
  return [{ matcher: "*", hooks: [{ type: "process", command: "echo hi" }] }];
}

function canonicalEntry(event: string): Record<string, unknown> {
  return {
    reviewItemId: "review_1",
    event,
    matcherIndex: 0,
    hookIndex: 0,
    sourceFileIndex: 0,
    sourceRelativePath: "zcode.json",
    matcher: null,
    command: "echo hi",
    resolvedTimeoutMs: 1000,
    resolvedMaxOutputBytes: 1024,
    sourceRootEnabled: true,
    declarationEnabled: true,
    runtimeHooksEnabled: true,
    configuredEnabled: true,
    editable: true,
    declarationDigestAlgorithm: "sha256",
    hookDeclarationDigest: "a".repeat(64),
    type: "process",
  };
}

test("HooksRuntimeConfigPatchSchema：events 形状键集合与 HOOK_EVENT_NAMES 相等", () => {
  const eventsShape = HooksRuntimeConfigPatchSchema.shape.events.unwrap().shape;
  assert.deepEqual(Object.keys(eventsShape).sort(), [...HOOK_EVENT_NAMES].sort());
});

test("HooksRuntimeConfigPatchSchema：合法事件名接受、非法事件名拒绝", () => {
  for (const event of HOOK_EVENT_NAMES) {
    const parsed = HooksRuntimeConfigPatchSchema.safeParse({ events: { [event]: matcherGroup() } });
    assert.equal(parsed.success, true, `${event} 应被接受`);
  }
  const invalid = HooksRuntimeConfigPatchSchema.safeParse({
    events: { NotARealEvent: matcherGroup() },
  });
  assert.equal(invalid.success, false, "未知事件键应被 strict 拒绝");
});

test("canonicalWorkspaceHookEntrySchema：合法事件名接受、非法事件名拒绝", () => {
  for (const event of HOOK_EVENT_NAMES) {
    const parsed = canonicalWorkspaceHookEntrySchema.safeParse(canonicalEntry(event));
    assert.equal(parsed.success, true, `${event} 应被接受`);
  }
  const invalid = canonicalWorkspaceHookEntrySchema.safeParse(canonicalEntry("NotARealEvent"));
  assert.equal(invalid.success, false, "未知事件名应被 enum 拒绝");
});

test("HookSpecificOutputSchema：合法事件名接受、非法事件名拒绝", () => {
  for (const event of HOOK_EVENT_NAMES) {
    const parsed = HookSpecificOutputSchema.safeParse({ hookEventName: event });
    assert.equal(parsed.success, true, `${event} 应被接受`);
  }
  const invalid = HookSpecificOutputSchema.safeParse({ hookEventName: "NotARealEvent" });
  assert.equal(invalid.success, false, "未知事件名应被 discriminatedUnion 拒绝");
});