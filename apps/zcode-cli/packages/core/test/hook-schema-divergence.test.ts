import assert from "node:assert/strict";
import test from "node:test";
import {
  HookMatcherConfigSchema,
  HookProcessConfigSchema,
} from "@zcode/contracts";
import {
  workspaceHookMatcherConfigSchema,
  workspaceHookProcessConfigSchema,
} from "@zcode/shared/workspace-hook-discovery";

/**
 * contracts 副本 vs shared schema 的四轴分歧是当前预期行为（P0 不收敛，只固化）：
 * 1. contracts HookProcessConfigSchema 无 passthrough（未知字段被 strip）；
 *    shared workspaceHookProcessConfigSchema 是 passthrough（未知字段保留）。
 * 2. contracts timeoutMs 用 int()（1.5 拒绝）；shared 用 finite()（1.5 接受）。
 * 3. contracts statusMessage 无 min(1)（空串接受）；shared 有 min(1)（空串拒绝）。
 * 4. contracts HookMatcherConfigSchema 非 strict；shared workspaceHookMatcherConfigSchema 是 strict。
 */

test("分歧1：未知字段 contracts strip vs shared passthrough 保留", () => {
  const value = { type: "process", command: "echo", extraField: "x" };

  const contracts = HookProcessConfigSchema.safeParse(value);
  assert.ok(contracts.success);
  assert.equal("extraField" in contracts.data, false, "contracts 应 strip 未知字段");

  const shared = workspaceHookProcessConfigSchema.safeParse(value);
  assert.ok(shared.success);
  assert.equal("extraField" in shared.data, true, "shared 应保留未知字段");
});

test("分歧2：timeoutMs contracts int() 拒绝 1.5 vs shared finite() 接受 1.5", () => {
  const value = { type: "process", command: "echo", timeoutMs: 1.5 };

  const contracts = HookProcessConfigSchema.safeParse(value);
  assert.equal(contracts.success, false, "contracts int() 应拒绝 1.5");

  const shared = workspaceHookProcessConfigSchema.safeParse(value);
  assert.equal(shared.success, true, "shared finite() 应接受 1.5");
});

test("分歧3：statusMessage contracts 空串接受 vs shared min(1) 空串拒绝", () => {
  const value = { type: "process", command: "echo", statusMessage: "" };

  const contracts = HookProcessConfigSchema.safeParse(value);
  assert.equal(contracts.success, true, "contracts 无 min(1) 应接受空串");

  const shared = workspaceHookProcessConfigSchema.safeParse(value);
  assert.equal(shared.success, false, "shared min(1) 应拒绝空串");
});

test("分歧4：matcher schema contracts 非 strict vs shared strict", () => {
  const value = {
    matcher: "x",
    hooks: [{ type: "process", command: "echo" }],
    extraKey: "y",
  };

  const contracts = HookMatcherConfigSchema.safeParse(value);
  assert.equal(contracts.success, true, "contracts 非 strict 应接受未知键并 strip");

  const shared = workspaceHookMatcherConfigSchema.safeParse(value);
  assert.equal(shared.success, false, "shared strict 应拒绝未知键");
});