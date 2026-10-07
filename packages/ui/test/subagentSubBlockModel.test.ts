// 左栏子代理子区块的行模型契约。
// spec: apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md 的「左栏任务列表：层级态」。
//
// 只断言区块的排序与「还有 N 个」口径：这两条是 spec 明文要求、且算错会让用户看到错的层级信息。
import assert from "node:assert/strict";
import test from "node:test";
import { buildSubagentSubBlockRows } from "../src/v4/subagentSubBlockModel.js";

type Running = Parameters<typeof buildSubagentSubBlockRows>[0]["running"][number];
type Ended = Parameters<typeof buildSubagentSubBlockRows>[0]["endedItems"][number];

function running(childSessionId: string, startedAt?: number): Running {
  return {
    childSessionId,
    subagentType: "general",
    title: childSessionId,
    status: "running",
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

function ended(childSessionId: string, startedAt?: number): Ended {
  return {
    childSessionId,
    subagentType: "general",
    title: childSessionId,
    status: "success",
    ...(startedAt === undefined ? {} : { startedAt }),
  };
}

test("运行中的排在已结束之前，同组内按 startedAt 倒序且缺值排最后", () => {
  const model = buildSubagentSubBlockRows({
    running: [running("r-old", 1), running("r-none"), running("r-new", 3)],
    endedItems: [ended("e-old", 1), ended("e-none"), ended("e-new", 3)],
    endedTotal: 3,
    limit: 8,
  });

  assert.deepEqual(
    model.rows.map((row) => row.childSessionId),
    ["r-new", "r-old", "r-none", "e-new", "e-old", "e-none"],
  );
  assert.equal(model.hiddenEndedCount, 0);
});

test("超过 limit 时只显示前 limit 个已结束，运行中的不受 limit 限制", () => {
  const model = buildSubagentSubBlockRows({
    running: [running("r-1", 9), running("r-2", 8)],
    endedItems: [ended("e-1", 3), ended("e-2", 2), ended("e-3", 1)],
    endedTotal: 3,
    limit: 2,
  });

  assert.deepEqual(
    model.rows.map((row) => row.childSessionId),
    ["r-1", "r-2", "e-1", "e-2"],
  );
  assert.equal(model.hiddenEndedCount, 1);
});

test("「还有 N 个」按 endedTotal 减已显示数，不能把已加载条数当总数", () => {
  const model = buildSubagentSubBlockRows({
    running: [],
    // 只加载到 2 条，总数 5：隐藏数必须是 3 而不是 0。
    endedItems: [ended("e-1", 2), ended("e-2", 1)],
    endedTotal: 5,
    limit: 8,
  });

  assert.equal(model.rows.length, 2);
  assert.equal(model.hiddenEndedCount, 3);
});

test("空输入返回空区块且不显示「还有 N 个」", () => {
  const model = buildSubagentSubBlockRows({
    running: [],
    endedItems: [],
    endedTotal: 0,
    limit: 8,
  });

  assert.deepEqual(model.rows, []);
  assert.equal(model.hiddenEndedCount, 0);
});

test("同一 childSessionId 同时出现在运行中与已结束时只保留运行中那行", () => {
  const model = buildSubagentSubBlockRows({
    running: [running("dup", 5)],
    endedItems: [ended("dup", 4), ended("other", 3)],
    endedTotal: 2,
    limit: 8,
  });

  assert.deepEqual(
    model.rows.map((row) => row.childSessionId),
    ["dup", "other"],
  );
  // 隐藏数 = endedTotal − 已显示的已结束行数。投影的口径是
  // `childSessionIds.length - running.length`，正在跑的那个本来就不计进 endedTotal，
  // 所以被去重的重复项不需要另外加回去。
  assert.equal(model.hiddenEndedCount, 1);
});

test("状态词走 subagentDirectory.status.*，与目录面板同一套语汇", () => {
  const model = buildSubagentSubBlockRows({
    running: [{ ...running("r-1", 1), status: "waiting" }],
    endedItems: [ended("e-1", 1)],
    endedTotal: 1,
    limit: 8,
  });

  assert.deepEqual(
    model.rows.map((row) => row.statusMessageId),
    ["subagentDirectory.status.waiting", "subagentDirectory.status.success"],
  );
});
