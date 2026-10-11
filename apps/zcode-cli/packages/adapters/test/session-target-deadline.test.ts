import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ProjectId, SessionId, SessionStorePort } from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store.js";

/**
 * 会话目标截止时间（endAtMs / deadlineGraceUsed）在真实 SQLite 上的行为契约。
 * 覆盖四件事：迁移重建后的新列与五值 status 约束、收尾标志的重置规则、
 * 记账 SQL 兜底翻状态（含预算优先）、以及面板用的工作区列表查询。
 */

const SESSION = "sess_deadline" as SessionId;
const OTHER_SESSION = "sess_deadline_other" as SessionId;

async function withStore<T>(run: (store: SessionStorePort) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-session-target-deadline-"));
  const store = createSqliteSessionStore({ dbPath: join(rootDir, "sessions.db") });
  try {
    for (const [id, directory, title] of [
      [SESSION, rootDir, "deadline session"],
      [OTHER_SESSION, join(rootDir, "other-workspace"), "other session"],
    ] as const) {
      await store.createSession({
        id,
        projectID: "proj_test" as ProjectId,
        slug: `slug-${id}`,
        directory,
        path: directory,
        title,
        version: "1",
      });
    }
    return await run(store);
  } finally {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("迁移后新列为空默认，且 status 接受 deadline_reached", async () => {
  await withStore(async (store) => {
    const created = await store.setTarget({
      objective: "ship the deadline feature",
      sessionID: SESSION,
      status: "active",
    });
    assert.equal(created.endAtMs, null);
    assert.equal(created.deadlineGraceUsed, false);

    // check 约束没扩成五值的话这条 update 会直接抛错。
    const stopped = await store.updateTargetStatus({
      sessionID: SESSION,
      status: "deadline_reached",
    });
    assert.ok(stopped);
    assert.equal(stopped.status, "deadline_reached");
    assert.equal((await store.readTarget({ sessionID: SESSION }))?.status, "deadline_reached");
  });
});

test("setTarget 写入截止时间并在 replace 时重置收尾标志", async () => {
  await withStore(async (store) => {
    const deadline = Date.now() + 3_600_000;
    const first = await store.setTarget({
      objective: "first objective",
      sessionID: SESSION,
      status: "active",
      endAtMs: deadline,
    });
    assert.equal(first.endAtMs, deadline);

    await store.markTargetDeadlineGraceUsed!({
      sessionID: SESSION,
      targetID: first.targetID,
    });
    assert.equal((await store.readTarget({ sessionID: SESSION }))?.deadlineGraceUsed, true);

    // replace 是同一目标对象换 objective：收尾机会必须重新给一次。
    const replaced = await store.setTarget({
      objective: "replaced objective",
      sessionID: SESSION,
      status: "active",
      endAtMs: deadline,
    });
    assert.equal(replaced.deadlineGraceUsed, false);
    assert.equal(replaced.endAtMs, deadline);

    // 不带 endAtMs 的 set（会话内 /goal 文本）清掉截止时间。
    const cleared = await store.setTarget({
      objective: "no deadline",
      sessionID: SESSION,
      status: "active",
    });
    assert.equal(cleared.endAtMs, null);
  });
});

test("updateTargetStatus：激活重置收尾标志，暂停保留；endAtMs 可重设也可清除", async () => {
  await withStore(async (store) => {
    const deadline = Date.now() + 60_000;
    const target = await store.setTarget({
      objective: "resume semantics",
      sessionID: SESSION,
      status: "active",
      endAtMs: deadline,
    });
    await store.markTargetDeadlineGraceUsed!({ sessionID: SESSION, targetID: target.targetID });

    // 暂停不重置：目标生命周期没有重新开始。
    const paused = await store.updateTargetStatus({ sessionID: SESSION, status: "paused" });
    assert.equal(paused?.deadlineGraceUsed, true);
    assert.equal(paused?.endAtMs, deadline);

    // 恢复（active）重置收尾标志，并保持原截止时间。
    const resumed = await store.updateTargetStatus({ sessionID: SESSION, status: "active" });
    assert.equal(resumed?.deadlineGraceUsed, false);
    assert.equal(resumed?.endAtMs, deadline);

    // 显式重设新截止时间。
    const newDeadline = deadline + 600_000;
    const retimed = await store.updateTargetStatus({
      sessionID: SESSION,
      status: "active",
      endAtMs: newDeadline,
    });
    assert.equal(retimed?.endAtMs, newDeadline);

    // 显式传 null 表示不再设截止。
    const cleared = await store.updateTargetStatus({
      sessionID: SESSION,
      status: "active",
      endAtMs: null,
    });
    assert.equal(cleared?.endAtMs, null);
  });
});

test("记账 SQL 兜底：仅在收尾标志已用且已过点时翻 deadline_reached；预算优先", async () => {
  await withStore(async (store) => {
    const past = Date.now() - 60_000;
    const target = await store.setTarget({
      objective: "accounting backstop",
      sessionID: SESSION,
      status: "active",
      endAtMs: past,
    });

    // 收尾标志未用：SQL 不翻，收尾轮仍由续跑候选放行。
    const beforeGrace = await store.accountTargetUsage!({
      sessionID: SESSION,
      targetID: target.targetID,
      tokensUsedDelta: 1,
    });
    assert.equal(beforeGrace?.status, "active");

    await store.markTargetDeadlineGraceUsed!({ sessionID: SESSION, targetID: target.targetID });
    const afterGrace = await store.accountTargetUsage!({
      sessionID: SESSION,
      targetID: target.targetID,
      tokensUsedDelta: 1,
    });
    assert.equal(afterGrace?.status, "deadline_reached");
  });
});

test("finishTargetRun 兜底：收尾轮结束时同一条 SQL 翻 deadline_reached", async () => {
  await withStore(async (store) => {
    const startedAt = Date.now();
    const target = await store.setTarget({
      objective: "finish run backstop",
      sessionID: SESSION,
      status: "active",
      endAtMs: startedAt - 60_000,
    });
    await store.startTargetRun!({
      sessionID: SESSION,
      targetID: target.targetID,
      inputID: "input_1",
      startedAtMs: startedAt,
    });
    // 收尾标志未用时不翻状态：该轮可能是收尾轮之前的普通轮。
    const beforeGrace = await store.finishTargetRun!({
      sessionID: SESSION,
      targetID: target.targetID,
      inputID: "input_1",
      endedAtMs: startedAt + 1_000,
    });
    assert.equal(beforeGrace?.status, "active");

    await store.markTargetDeadlineGraceUsed!({ sessionID: SESSION, targetID: target.targetID });
    await store.startTargetRun!({
      sessionID: SESSION,
      targetID: target.targetID,
      inputID: "input_2",
      startedAtMs: startedAt + 2_000,
    });
    const afterGrace = await store.finishTargetRun!({
      sessionID: SESSION,
      targetID: target.targetID,
      inputID: "input_2",
      endedAtMs: startedAt + 3_000,
    });
    assert.equal(afterGrace?.status, "deadline_reached");
    assert.equal(afterGrace?.activeInputId, null);
  });
});

test("预算与截止同时满足时先翻 budget_limited（不再翻 deadline_reached）", async () => {
  await withStore(async (store) => {
    const target = await store.setTarget({
      objective: "budget beats deadline",
      sessionID: SESSION,
      status: "active",
      tokenBudget: 10,
      endAtMs: Date.now() - 60_000,
    });
    await store.markTargetDeadlineGraceUsed!({ sessionID: SESSION, targetID: target.targetID });

    const accounted = await store.accountTargetUsage!({
      sessionID: SESSION,
      targetID: target.targetID,
      tokensUsedDelta: 10,
    });
    assert.equal(accounted?.status, "budget_limited");
  });
});

test("createTarget 带上截止时间，且已存在目标时不覆盖", async () => {
  await withStore(async (store) => {
    const deadline = Date.now() + 900_000;
    const created = await store.createTarget({
      objective: "created with deadline",
      sessionID: SESSION,
      tokenBudget: 1000,
      endAtMs: deadline,
    });
    assert.equal(created?.endAtMs, deadline);
    assert.equal(created?.deadlineGraceUsed, false);
    assert.equal(created?.tokenBudget, 1000);

    // insert or ignore：已有目标时返回 null（不覆盖）。
    const again = await store.createTarget({ objective: "ignored", sessionID: SESSION });
    assert.equal(again, null);
    assert.equal((await store.readTarget({ sessionID: SESSION }))?.objective, "created with deadline");
  });
});

test("listTargets 按工作区过滤并带上承载会话的展示身份", async () => {
  await withStore(async (store) => {
    const deadline = Date.now() + 120_000;
    await store.setTarget({
      objective: "workspace scoped",
      sessionID: SESSION,
      status: "active",
      endAtMs: deadline,
    });
    await store.setTarget({
      objective: "other workspace",
      sessionID: OTHER_SESSION,
      status: "active",
    });

    const scopedDir = (await store.getSession(SESSION))?.directory;
    const scoped = await store.listTargets!({ directory: scopedDir });
    assert.equal(scoped.length, 1);
    assert.equal(scoped[0]?.sessionID, SESSION);
    assert.equal(scoped[0]?.sessionTitle, "deadline session");
    assert.equal(scoped[0]?.workspacePath, scopedDir);
    assert.equal(scoped[0]?.archived, false);
    assert.equal(scoped[0]?.goal.objective, "workspace scoped");
    assert.equal(scoped[0]?.goal.endAtMs, deadline);

    const all = await store.listTargets!({});
    assert.equal(all.length, 2);
  });
});

test("listTargets 默认排除已归档会话的目标", async () => {
  await withStore(async (store) => {
    await store.setTarget({ objective: "archived goal", sessionID: SESSION, status: "active" });
    await store.updateSession({ id: SESSION, timeArchived: Date.now() });

    assert.equal((await store.listTargets!({})).length, 0);
    const withArchived = await store.listTargets!({ includeArchived: true });
    assert.equal(withArchived.length, 1);
    assert.equal(withArchived[0]?.archived, true);
  });
});
