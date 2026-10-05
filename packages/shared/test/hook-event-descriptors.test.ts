// HOOK_EVENT_NAMES 与 HOOK_EVENT_DESCRIPTORS 的一致性：键集合相等，
// 每个描述符的元数据字段类型合法（P0 只固化事件单源，不接引擎）。
import assert from "node:assert/strict";
import test from "node:test";
import { HOOK_EVENT_DESCRIPTORS, HOOK_EVENT_NAMES } from "../src/hooks.js";

const MATCHER_KINDS = ["toolName", "sessionSource", "compactTrigger", "subagent", "none"];

test("HOOK_EVENT_NAMES 与 HOOK_EVENT_DESCRIPTORS 键集合相等", () => {
  assert.deepEqual(new Set(HOOK_EVENT_NAMES), new Set(Object.keys(HOOK_EVENT_DESCRIPTORS)));
});

test("每个描述符的 labelKey/matcherKind/blockable/injectsContext 合法", () => {
  for (const [event, descriptor] of Object.entries(HOOK_EVENT_DESCRIPTORS)) {
    assert.ok(
      (HOOK_EVENT_NAMES as readonly string[]).includes(event),
      `HOOK_EVENT_DESCRIPTORS 含未知事件键: ${event}`,
    );
    assert.equal(typeof descriptor.labelKey, "string", `${event} labelKey 类型`);
    assert.ok(descriptor.labelKey.length > 0, `${event} labelKey 为空字符串`);
    assert.ok(
      MATCHER_KINDS.includes(descriptor.matcherKind),
      `${event} matcherKind 非法: ${descriptor.matcherKind}`,
    );
    assert.equal(typeof descriptor.blockable, "boolean", `${event} blockable 类型`);
    assert.equal(typeof descriptor.injectsContext, "boolean", `${event} injectsContext 类型`);
  }
});
