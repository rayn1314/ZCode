// session/goal 的 `start` 参数契约（面板「保存」/「保存并运行」语义）：
// 1) `start: false` 新建目标落 paused、编辑已运行目标保持 active、其余保持 paused；
// 2) 缺省（/goal 文本命令）保持既有行为：一律 active；
// 3) 带 start 的请求必须通过 strict 的 zcodeSessionGoalParamsSchema。
import assert from "node:assert/strict";
import test from "node:test";
import { zcodeSessionGoalParamsSchema } from "@zcode/shared";
import { resolveGoalStartStatus } from "../src/zcode-protocol/server-operations.js";

test("start:false 时新建落 paused、编辑 active 保持 active、其余落 paused", () => {
  assert.equal(resolveGoalStartStatus(false, null), "paused");
  assert.equal(resolveGoalStartStatus(false, "active"), "active");
  assert.equal(resolveGoalStartStatus(false, "paused"), "paused");
  assert.equal(resolveGoalStartStatus(false, "complete"), "paused");
  assert.equal(resolveGoalStartStatus(false, "deadline_reached"), "paused");
});

test("start 缺省或 true 时一律 active（保持 /goal 既有语义）", () => {
  assert.equal(resolveGoalStartStatus(true, null), "active");
  assert.equal(resolveGoalStartStatus(true, "paused"), "active");
  assert.equal(resolveGoalStartStatus(true, "active"), "active");
});

test("带 start:false 的 set 请求通过 strict 协议 schema", () => {
  const parsed = zcodeSessionGoalParamsSchema.parse({
    sessionId: "sess_goal_start",
    action: "set",
    objective: "write the release notes",
    endAtMs: 1_900_000_000_000,
    start: false,
  });
  assert.equal(parsed.start, false);
});

test("不带 start 的请求通过 strict 协议 schema，解析后缺省为 true", () => {
  const parsed = zcodeSessionGoalParamsSchema.parse({
    sessionId: "sess_goal_start",
    action: "replace",
    objective: "write the release notes",
  });
  assert.equal(parsed.start, undefined);
});
