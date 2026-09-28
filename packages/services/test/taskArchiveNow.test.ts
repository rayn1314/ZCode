import assert from "node:assert/strict";
import test from "node:test";
import type { ZCodeTaskMeta } from "@zcode/shared";
import type { TaskIndexRepo } from "../src/session/taskIndexRepo.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

type Options = Parameters<typeof createZCodeTaskServiceAdapter>[0];

const staleMeta = {
  taskId: "stale-example",
  traceId: "trace-example",
  title: "Stale example",
  workspacePath: "/example/workspace",
  workspaceIdentity: "example-identity",
  createdAt: 1,
  updatedAt: 2,
  mode: "build" as const,
  provider: "glm" as const,
};

interface ArchiveCall {
  workspacePath: string;
  workspaceIdentity?: string;
  olderThanDays: number;
}

function createArchiveService(settings: { enabled: boolean; olderThanDays: number } | "error") {
  const archiveCalls: ArchiveCall[] = [];
  const emitted: Array<{ workspacePath: string; taskId?: string; reason: string }> = [];
  const disposable = () => ({ dispose() {} });
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      disposeAll() {},
    } as unknown as Options["zcodeAgentService"],
    taskIndexRepo: {
      async archiveStaleTasks(params: ArchiveCall): Promise<ZCodeTaskMeta[]> {
        archiveCalls.push(params);
        return [
          {
            ...staleMeta,
            workspacePath: params.workspacePath,
            workspaceIdentity: params.workspaceIdentity,
          },
        ];
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
        if (settings === "error") {
          throw new Error("settings unavailable");
        }
        return {
          taskAutoArchiveEnabled: settings.enabled,
          taskAutoArchiveOlderThanDays: settings.olderThanDays,
        };
      },
    } as unknown as Options["settingService"],
  });
  return { service, archiveCalls, emitted };
}

test("manual archive ignores the auto toggle, reuses the retention setting and dedups workspaces", async () => {
  const { service, archiveCalls, emitted } = createArchiveService({
    enabled: false,
    olderThanDays: 14,
  });
  try {
    const result = await service.archiveStaleTasksForWorkspaces({
      workspaceScopes: [
        { workspacePath: "/example/workspace", workspaceIdentity: "example-identity" },
        // 同一 workspace 的重复 scope 只扫描一次。
        { workspacePath: "/example/workspace", workspaceIdentity: "example-identity" },
        { workspacePath: "/example/other" },
      ],
    });

    assert.deepEqual(result, { archivedCount: 2, scannedWorkspaceCount: 2, olderThanDays: 14 });
    assert.deepEqual(
      archiveCalls.map((call) => [call.workspacePath, call.olderThanDays]),
      [
        ["/example/workspace", 14],
        ["/example/other", 14],
      ],
    );
    // 归档后的归属变更沿用既有 task_meta_changed 广播收敛路径。
    assert.deepEqual(
      emitted.map((event) => [event.workspacePath, event.taskId, event.reason]),
      [
        ["/example/workspace", staleMeta.taskId, "task_meta_changed"],
        ["/example/other", staleMeta.taskId, "task_meta_changed"],
      ],
    );
  } finally {
    service.disposeAll();
  }
});

test("manual archive falls back to the default retention when settings cannot be read", async () => {
  const { service, archiveCalls } = createArchiveService("error");
  try {
    const result = await service.archiveStaleTasksForWorkspaces({
      workspaceScopes: [{ workspacePath: "/example/workspace" }],
    });

    assert.equal(result.olderThanDays, 7);
    assert.equal(archiveCalls[0]?.olderThanDays, 7);
  } finally {
    service.disposeAll();
  }
});
