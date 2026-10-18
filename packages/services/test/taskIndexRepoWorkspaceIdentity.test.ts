import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ZCodeTaskMeta } from "@zcode/shared";
import { setDataBaseDir } from "#src/paths.js";
import { TaskIndexRepo } from "#src/session/taskIndexRepo.js";

let repo: TaskIndexRepo;
let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "zcode-task-index-workspace-identity-"));
  setDataBaseDir(tempDir);
  repo = new TaskIndexRepo();
});

afterEach(async () => {
  repo.close();
  setDataBaseDir(null);
  // Windows 需要等待 SQLite 释放文件句柄，避免临时目录清理出现 EPERM。
  await new Promise((resolve) => setTimeout(resolve, 50));
  rmSync(tempDir, { recursive: true, force: true });
});

function task(params: {
  taskId: string;
  workspaceIdentity: string;
  title?: string;
}): ZCodeTaskMeta {
  return {
    taskId: params.taskId,
    traceId: `trace-${params.taskId}`,
    title: params.title ?? params.taskId,
    workspacePath: "/workspace/project",
    workspaceIdentity: params.workspaceIdentity,
    createdAt: 10,
    updatedAt: 20,
    mode: "default",
    status: "running",
  };
}

function getRepoDatabase(target: TaskIndexRepo): {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
  };
} {
  return (
    target as unknown as {
      getDatabase(): {
        prepare(sql: string): {
          run(...params: unknown[]): unknown;
        };
      };
    }
  ).getDatabase();
}

function metaJsonWithoutWorkspaceIdentity(meta: ZCodeTaskMeta): string {
  const legacyMeta: Partial<ZCodeTaskMeta> = { ...meta };
  delete legacyMeta.workspaceIdentity;
  return JSON.stringify(legacyMeta);
}

describe("TaskIndexRepo workspace identity normalization", () => {
  it("归档条件删除只影响相同路径下指定 identity，冷启动仍保留 tombstone", async () => {
    const first = task({
      taskId: "same-id",
      workspaceIdentity: "remote:ssh:first:22:coder:/workspace/project",
    });
    const second = task({
      taskId: "same-id",
      workspaceIdentity: "remote:ssh:second:22:coder:/workspace/project",
    });
    for (const meta of [first, second]) {
      await repo.syncTaskMeta({ meta });
      await repo.updateTaskState({ ...meta, patch: { archived: true } });
    }
    expect(await repo.deleteArchivedTask(first)).toEqual(
      expect.objectContaining({ taskId: first.taskId }),
    );
    repo.close();
    repo = new TaskIndexRepo();
    expect(await repo.getTaskMeta(first)).toBeNull();
    expect(await repo.getTaskMeta(second)).toEqual(
      expect.objectContaining({ workspaceIdentity: second.workspaceIdentity }),
    );
    expect(await repo.deleteArchivedTask(first)).toBeNull();
  });

  it("以 SQLite remote workspace_key 覆盖 SSH 旧列和 meta_json 中过期的 identity", async () => {
    const workspaceIdentity = "remote:ssh:dev.example.test:22:coder:/workspace/project";
    const staleWorkspaceIdentity = "remote:ssh:stale.example.test:22:coder:/workspace/project";
    const meta = task({ taskId: "ssh-running", workspaceIdentity });
    await repo.syncTaskMeta({ meta });

    getRepoDatabase(repo)
      .prepare(
        `UPDATE tasks
        SET workspace_identity = ?, meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(
        staleWorkspaceIdentity,
        JSON.stringify({
          ...meta,
          workspaceIdentity: staleWorkspaceIdentity,
        }),
        workspaceIdentity,
        meta.taskId,
      );

    await expect(
      repo.listTaskMetas({
        workspacePath: meta.workspacePath,
        workspaceIdentity,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: meta.taskId,
        workspacePath: meta.workspacePath,
        workspaceIdentity,
      }),
    ]);
  });

  it("WSL 旧行 identity 列为空时从合法 remote workspace_key 恢复", async () => {
    const workspaceIdentity = "remote:wsl:ubuntu:/workspace/project";
    const meta = task({ taskId: "wsl-running", workspaceIdentity });
    await repo.syncTaskMeta({ meta });

    getRepoDatabase(repo)
      .prepare(
        `UPDATE tasks
        SET workspace_identity = NULL, meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(metaJsonWithoutWorkspaceIdentity(meta), workspaceIdentity, meta.taskId);

    await expect(
      repo.listTaskMetas({
        workspacePath: meta.workspacePath,
        workspaceIdentity,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        taskId: meta.taskId,
        workspaceIdentity,
      }),
    ]);
  });

  it("相同 path 和 taskId 的不同 SSH identity 仍保持隔离", async () => {
    const identityA = "remote:ssh:a.example.test:22:coder:/workspace/project";
    const identityB = "remote:ssh:b.example.test:22:coder:/workspace/project";
    const taskA = task({
      taskId: "shared-task",
      workspaceIdentity: identityA,
      title: "host-a",
    });
    const taskB = task({
      taskId: "shared-task",
      workspaceIdentity: identityB,
      title: "host-b",
    });
    await repo.syncTaskMeta({ meta: taskA });
    await repo.syncTaskMeta({ meta: taskB });

    const database = getRepoDatabase(repo);
    database
      .prepare(
        `UPDATE tasks
        SET meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(metaJsonWithoutWorkspaceIdentity(taskA), identityA, taskA.taskId);
    database
      .prepare(
        `UPDATE tasks
        SET meta_json = ?
        WHERE workspace_key = ? AND task_id = ?`,
      )
      .run(metaJsonWithoutWorkspaceIdentity(taskB), identityB, taskB.taskId);

    const [listedA, listedB] = await Promise.all([
      repo.listTaskMetas({
        workspacePath: taskA.workspacePath,
        workspaceIdentity: identityA,
      }),
      repo.listTaskMetas({
        workspacePath: taskB.workspacePath,
        workspaceIdentity: identityB,
      }),
    ]);

    expect(listedA).toEqual([
      expect.objectContaining({
        title: "host-a",
        workspaceIdentity: identityA,
      }),
    ]);
    expect(listedB).toEqual([
      expect.objectContaining({
        title: "host-b",
        workspaceIdentity: identityB,
      }),
    ]);
  });

  it("queryTaskList 支持按会话 ID（task_id）搜索，摘要直接返回会话 ID", async () => {
    const meta = task({
      taskId: "sess_3e834f0b",
      workspaceIdentity: "local",
      title: "排查登录超时",
    });
    await repo.syncTaskMeta({
      meta,
      searchableText: "这段正文不包含会话标识，只靠 ID 定位",
    });
    const scopes = [
      {
        workspacePath: meta.workspacePath,
        workspaceIdentity: meta.workspaceIdentity,
      },
    ];

    // 完整会话 ID 可命中。
    const byFullId = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "sess_3e834f0b",
    });
    expect(byFullId.total).toBe(1);
    expect(byFullId.items[0]).toMatchObject({
      taskId: "sess_3e834f0b",
      title: "排查登录超时",
      searchSnippet: "sess_3e834f0b",
    });
    expect(byFullId.items[0].searchSnippets).toEqual(["sess_3e834f0b"]);

    // 部分 ID 同样可命中。
    const byPartialId = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "3e834f0b",
    });
    expect(byPartialId.total).toBe(1);
    expect(byPartialId.items[0].searchSnippet).toBe("sess_3e834f0b");

    // 无关词不命中。
    const unrelated = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: scopes,
      sortBy: "updated",
      search: "完全不存在的关键词xyz",
    });
    expect(unrelated.total).toBe(0);
  });

  it("queryTaskList 按 ID 搜索时，正文命中但 task_id 不同仍返回正文摘要而不是 ID", async () => {
    const meta = task({
      taskId: "sess_aaaa1111",
      workspaceIdentity: "local",
      title: "另一场会话",
    });
    await repo.syncTaskMeta({
      meta,
      // 正文恰好提到了别的会话 ID，本任务自己的 task_id 不含它。
      searchableText: "参考了 sess_3e834f0b 的排查过程",
    });
    const result = await repo.queryTaskList({
      kind: "active",
      workspaceScopes: [
        {
          workspacePath: meta.workspacePath,
          workspaceIdentity: meta.workspaceIdentity,
        },
      ],
      sortBy: "updated",
      search: "sess_3e834f0b",
    });
    expect(result.total).toBe(1);
    // 摘要来自正文（含匹配词），而不是被误换成其他任务的 task_id。
    expect(result.items[0].taskId).toBe("sess_aaaa1111");
    expect(result.items[0].searchSnippet).toContain("sess_3e834f0b");
    expect(result.items[0].searchSnippet).not.toBe("sess_aaaa1111");
  });
});
