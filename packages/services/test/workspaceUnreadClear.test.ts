import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];

const scope = { workspacePath: "/example/workspace", workspaceIdentity: "example-identity" };

function taskMeta(taskId: string): ZCodeTaskMeta {
  return {
    taskId,
    traceId: `trace-${taskId}`,
    title: taskId,
    workspacePath: scope.workspacePath,
    workspaceIdentity: scope.workspaceIdentity,
    createdAt: 1,
    updatedAt: 2,
    mode: "build",
    provider: "glm",
  };
}

/** 未读分布：普通一条（蓝点口径内，应被清）、置顶/归档/已删除各一条（口径外，都不应被清）。 */
async function seedWorkspace(repo: TaskIndexRepo): Promise<void> {
  const taskIds = [
    "unread-plain",
    "unread-pinned",
    "unread-archived",
    "read-task",
    "unread-deleted",
  ];
  for (const taskId of taskIds) {
    await repo.syncTaskMeta({ meta: taskMeta(taskId) });
  }
  await repo.updateTaskState({ ...scope, taskId: "unread-plain", patch: { unreadAt: 1_000 } });
  await repo.updateTaskState({
    ...scope,
    taskId: "unread-pinned",
    patch: { unreadAt: 2_000, pinned: true },
  });
  await repo.updateTaskState({
    ...scope,
    taskId: "unread-archived",
    patch: { unreadAt: 3_000, archived: true },
  });
  await repo.updateTaskState({ ...scope, taskId: "unread-deleted", patch: { unreadAt: 4_000 } });
  await repo.updateTaskState({ ...scope, taskId: "unread-deleted", patch: { deleted: true } });
}

test("clearWorkspaceUnread clears exactly the blue-dot scope and leaves pinned/archived unread", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-clear-"));
  const path = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  try {
    await seedWorkspace(repo);
    const beforeRows = await repo.listTaskMetas({ ...scope, includeDeleted: true });
    const unreadBefore = beforeRows.filter((task) => typeof task.unreadAt === "number").length;

    const result = await repo.clearWorkspaceUnread(scope);

    // 蓝点口径 = timeline membership：置顶与归档的未读不点亮项目行蓝点，因此保持不动。
    assert.deepEqual(result.clearedTaskIds, ["unread-plain"]);

    const afterRows = await repo.listTaskMetas({ ...scope, includeDeleted: true });
    const stillUnread = afterRows.filter((task) => typeof task.unreadAt === "number");
    assert.deepEqual(stillUnread.map((task) => task.taskId).sort(), [
      "unread-archived",
      "unread-deleted",
      "unread-pinned",
    ]);
    assert.equal(unreadBefore, 4);

    // 清零后水位不能被重置：否则同毫秒的两次未读会分配到同一个 CAS 版本。
    repo.close();
    const database = new DatabaseSync(path);
    try {
      const row = database
        .prepare("SELECT last_unread_at FROM tasks WHERE task_id = ?")
        .get("unread-plain") as { last_unread_at: number } | undefined;
      assert.ok((row?.last_unread_at ?? 0) > 0);
      const cleared = database
        .prepare("SELECT unread_at FROM tasks WHERE task_id = ?")
        .get("unread-plain") as { unread_at: number | null } | undefined;
      assert.equal(cleared?.unread_at, null);
    } finally {
      database.close();
    }
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearWorkspaceUnread is a no-op when the workspace has no unread task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-empty-"));
  const path = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  try {
    await repo.syncTaskMeta({ meta: taskMeta("read-task") });
    const result = await repo.clearWorkspaceUnread(scope);
    assert.deepEqual(result, { clearedTaskIds: [] });
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("clearWorkspaceUnread is a no-op when every unread task sits outside the blue-dot scope", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zcode-unread-pinned-only-"));
  const path = join(dir, "tasks.sqlite");
  const repo = new TaskIndexRepo(path);
  try {
    await repo.syncTaskMeta({ meta: taskMeta("pinned-only") });
    await repo.updateTaskState({
      ...scope,
      taskId: "pinned-only",
      patch: { unreadAt: 5_000, pinned: true },
    });

    assert.deepEqual(await repo.clearWorkspaceUnread(scope), { clearedTaskIds: [] });

    const rows = await repo.listTaskMetas(scope);
    assert.equal(typeof rows[0]?.unreadAt, "number");
  } finally {
    repo.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function createUnreadClearService(behaviour: "clear" | "empty" | "error") {
  const calls: Array<{ workspacePath: string; workspaceIdentity?: string }> = [];
  const emitted: Array<{ workspacePath: string; taskId?: string; reason: string }> = [];
  const disposable = () => ({ dispose() {} });
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async clearWorkspaceUnread(params: { workspacePath: string; workspaceIdentity?: string }) {
        calls.push(params);
        if (behaviour === "error") {
          throw new Error("task index unavailable");
        }
        return { clearedTaskIds: behaviour === "empty" ? [] : ["unread-a", "unread-b"] };
      },
      close() {},
    } as unknown as TaskIndexRepo,
    taskIndexSyncer: {
      onSessionTerminalEvent: disposable,
      onSessionReadyEvent: disposable,
      disposeAll() {},
      emitWorkspaceTaskListChanged(
        params: { workspacePath: string; taskId?: string },
        _taskMeta: unknown,
        reason: string,
      ) {
        emitted.push({ ...params, reason });
      },
    } as unknown as Options["taskIndexSyncer"],
    settingService: {
      async get() {
        return { taskAutoArchiveEnabled: false, taskAutoArchiveOlderThanDays: 7 };
      },
    } as unknown as Options["settingService"],
  });
  return { service, calls, emitted };
}

test("markWorkspaceTasksRead broadcasts exactly one membership refresh for the cleared workspace", async () => {
  const { service, calls, emitted } = createUnreadClearService("clear");
  try {
    const result = await service.markWorkspaceTasksRead(scope);

    assert.deepEqual(result, { clearedTaskIds: ["unread-a", "unread-b"] });
    assert.deepEqual(calls, [scope]);
    // 批次只发一条事件，且不指向具体 task：unread 归属变化只需驱动 membership 重拉。
    assert.deepEqual(emitted, [
      {
        workspacePath: scope.workspacePath,
        workspaceIdentity: scope.workspaceIdentity,
        reason: "task_meta_changed",
      },
    ]);
  } finally {
    service.disposeAll();
  }
});

test("markWorkspaceTasksRead stays silent when nothing was unread", async () => {
  const { service, emitted } = createUnreadClearService("empty");
  try {
    const result = await service.markWorkspaceTasksRead(scope);
    assert.deepEqual(result, { clearedTaskIds: [] });
    assert.deepEqual(emitted, []);
  } finally {
    service.disposeAll();
  }
});

test("markWorkspaceTasksRead surfaces storage failures without broadcasting", async () => {
  const { service, emitted } = createUnreadClearService("error");
  try {
    await assert.rejects(() => service.markWorkspaceTasksRead(scope), /task index unavailable/);
    assert.deepEqual(emitted, []);
  } finally {
    service.disposeAll();
  }
});
