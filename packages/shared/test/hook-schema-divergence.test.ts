// shared 与 contracts 的 workspace hook 配置 schema 分歧矩阵（P0 只固化，不改语义）：
//
//   分歧轴              shared（本测试固化）            contracts（CLI 侧测试覆盖）
//   未知字段            workspaceHookProcessConfigSchema 用 .passthrough() 保留    strip 剥离
//   timeoutMs           z.number().finite().positive()（接受 1.5）               z.number().int()（拒绝 1.5）
//   statusMessage       z.string().min(1)（空串被拒）                               无 min（空串可过）
//   matcher 外层        workspaceHookMatcherConfigSchema 用 .strict()              非 strict（未知键可过）
//
// 本文件只断言 shared 侧当前预期行为；contracts 侧对比由 CLI workspace 的
// hook-schema-divergence 测试覆盖。runtime 判定语义不在 P0 改动范围。
import assert from "node:assert/strict";
import test from "node:test";
import { workspaceHookProcessConfigSchema } from "../src/workspace-hook-config.js";

test("未知字段被 passthrough 保留", () => {
  const parsed = workspaceHookProcessConfigSchema.safeParse({
    type: "process",
    command: "node hook.mjs",
    futureField: { nested: true },
  });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data.futureField, { nested: true });
});

test("timeoutMs 接受 1.5（finite 只排除非有限数，positive 不排除小数）", () => {
  const parsed = workspaceHookProcessConfigSchema.safeParse({
    type: "process",
    command: "node hook.mjs",
    timeoutMs: 1.5,
  });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.timeoutMs, 1.5);
});

test("timeoutMs 拒绝非有限数与非正数", () => {
  for (const timeoutMs of [Infinity, NaN, 0, -1]) {
    const parsed = workspaceHookProcessConfigSchema.safeParse({
      type: "process",
      command: "node hook.mjs",
      timeoutMs,
    });
    assert.equal(parsed.success, false, `timeoutMs=${timeoutMs} 应被拒`);
  }
});

test("statusMessage 空串被拒（.min(1)）", () => {
  const parsed = workspaceHookProcessConfigSchema.safeParse({
    type: "process",
    command: "node hook.mjs",
    statusMessage: "",
  });
  assert.equal(parsed.success, false);
});
