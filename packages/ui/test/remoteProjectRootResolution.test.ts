import { describe, expect, it, vi } from "vitest";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import type {
  ProjectTree,
  RemoteProjectDirectory,
  RemoteProjectEntry,
  VirtualProject,
} from "@/project-sidebar/contract.js";
import {
  resolveRemoteProjectDirectorySelection,
  resolveRemoteProjectEntryForDirectory,
} from "@/project-sidebar/remote-project-entry.js";
import {
  requestRetainedRemoteProjectConnection,
  resolveRecentRemoteProjectPreference,
} from "@/project-sidebar/remote-project-connection.js";

const hostId = "remote:server:source-1";
const rootPath = "/home/rayn/workspace/repos";

function roots(...paths: string[]): RemoteProjectEntry["roots"] {
  return paths.map((path, index) => ({ rootPath: path, position: index, isPrimary: index === 0 }));
}
function entry(id: string, projectId: string | null, paths = [rootPath]): RemoteProjectEntry {
  return {
    id,
    hostId,
    projectId,
    name: id,
    roots: roots(...paths),
    legacyWorkspace: null,
    lastSyncedAt: 1,
  };
}
function project(id: string, deleted: boolean, paths = [rootPath]): VirtualProject {
  return {
    id,
    hostId,
    name: id,
    nameOverridden: false,
    position: 0,
    pinned: false,
    deleted,
    createdAt: 1,
    updatedAt: 1,
    roots: roots(...paths),
  };
}
/** 现场数据形态：同一 root 上一条已删除项目的残留入口排在活项目入口之前。 */
const directory: RemoteProjectDirectory = {
  hosts: [{ id: hostId, membershipId: "member-1", kind: "ssh", target: null, position: 0 }],
  entries: [entry("entry-deleted", "project-deleted"), entry("entry-live", "project-live")],
};
const tree: ProjectTree = {
  projects: [project("project-deleted", true), project("project-live", false)],
  tasks: [],
};

describe("按目录解析远端项目入口", () => {
  it("先命中已删除项目的残留入口时仍选中活项目", () => {
    const resolution = resolveRemoteProjectEntryForDirectory({
      directory,
      hostId,
      path: rootPath,
      tree,
    });
    expect(resolution?.entry.id).toBe("entry-live");
    expect(resolution?.project?.id).toBe("project-live");
    expect(resolution?.rootPath).toBe(rootPath);
  });

  it("入口顺序不影响活项目优先，且目录比较容忍尾斜杠写法", () => {
    expect(
      resolveRemoteProjectEntryForDirectory({
        directory: { ...directory, entries: [...directory.entries].reverse() },
        hostId,
        path: `${rootPath}/`,
        tree,
      })?.entry.id,
    ).toBe("entry-live");
    // 没有项目树就无法判定入口是否已软删，只能按目录顺序取首条。
    expect(
      resolveRemoteProjectEntryForDirectory({ directory, hostId, path: rootPath })?.entry.id,
    ).toBe("entry-deleted");
  });
});

describe("重连/选目录不得退化成新建项目", () => {
  it("目录已有活项目时打开它，即使偏好里没有入口标识", () => {
    // 现场形态：偏好只有目录（没有 preferredProjectEntryId / preferredWorkspaceTabId）。
    const directoryOnly: RemoteConnectionOpenPreference = {
      preferredSourceServerId: "source-1",
      preferredDirectoryPath: rootPath,
    };
    expect(
      resolveRemoteProjectDirectorySelection({
        directory,
        hostId,
        path: rootPath,
        tree,
        preference: directoryOnly,
      }),
    ).toMatchObject({ kind: "open-project", draftProjectId: "project-live" });
  });

  it("偏好指向已删除的入口时仍打开同根的活项目", () => {
    expect(
      resolveRemoteProjectDirectorySelection({
        directory,
        hostId,
        path: rootPath,
        tree,
        preference: { preferredProjectEntryId: "entry-deleted" },
      }),
    ).toMatchObject({ kind: "open-project", draftProjectId: "project-live" });
  });

  it("目录确实没有活项目时才允许失败或进入新建", () => {
    const deletedOnly = { ...directory, entries: [entry("entry-deleted", "project-deleted")] };
    const deletedTree: ProjectTree = { projects: [project("project-deleted", true)], tasks: [] };
    expect(
      resolveRemoteProjectDirectorySelection({
        directory: deletedOnly,
        hostId,
        path: rootPath,
        tree: deletedTree,
        preference: { preferredProjectEntryId: "entry-deleted" },
      }),
    ).toEqual({ kind: "not-found" });
    expect(
      resolveRemoteProjectDirectorySelection({
        directory: deletedOnly,
        hostId,
        path: rootPath,
        tree: deletedTree,
      }),
    ).toEqual({ kind: "create-project" });
    expect(
      resolveRemoteProjectDirectorySelection({
        directory: { hosts: directory.hosts, entries: [] },
        hostId,
        path: rootPath,
        tree: deletedTree,
        preference: { preferredWorkspaceTabId: "tab-1" },
      }),
    ).toEqual({ kind: "cancelled" });
  });

  it("会话重连只恢复原选择，不解析草稿归属", () => {
    expect(
      resolveRemoteProjectDirectorySelection({
        directory: { ...directory, entries: [entry("entry-deleted", "project-deleted")] },
        hostId,
        path: rootPath,
        tree: { projects: [project("project-deleted", true)], tasks: [] },
        preference: { preferredWorkspaceTabId: "tab-1" },
      }),
    ).toEqual({ kind: "open-project", entry: expect.objectContaining({ id: "entry-deleted" }) });
  });
});

describe("最近远程项目偏好", () => {
  const input = { sourceServerId: "source-1", path: rootPath, profileId: "profile-1" };
  it("同根存在已删除项目的残留入口时仍固定活项目入口", () => {
    expect(resolveRecentRemoteProjectPreference(directory, { ...input, tree })).toEqual({
      preferredProfileId: "profile-1",
      preferredDirectoryPath: rootPath,
      preferredProjectEntryId: "entry-live",
    });
  });
  it("目录只剩已删除项目时不再生成打开意图", () => {
    expect(
      resolveRecentRemoteProjectPreference(
        { ...directory, entries: [entry("entry-deleted", "project-deleted")] },
        { ...input, tree: { projects: [project("project-deleted", true)], tasks: [] } },
      ),
    ).toBeNull();
  });
});

describe("未加载页签的重连交接", () => {
  const host = { id: hostId, membershipId: "member-1", kind: "ssh", target: null, position: 0 };
  const pendingCredentials = async () => {
    throw Object.assign(new Error("credentials required"), { code: "credentials-required" });
  };
  it("项目树可用时把向导偏好固定到活项目入口", async () => {
    const openWizard = vi.fn();
    await requestRetainedRemoteProjectConnection({
      workspaceKey: `${hostId}:${rootPath}`,
      service: { readDirectory: async () => directory, connectHost: pendingCredentials } as never,
      readTree: async () => tree,
      openWizard,
    });
    expect(openWizard).toHaveBeenCalledWith(
      expect.objectContaining({
        preferredProjectEntryId: "entry-live",
        preferredDirectoryPath: rootPath,
      }),
    );
  });
  it("原入口在连接期间被替换时不打开旧意图", async () => {
    const openWizard = vi.fn();
    let reads = 0;
    await requestRetainedRemoteProjectConnection({
      workspaceKey: `${hostId}:${rootPath}`,
      service: {
        readDirectory: async () => {
          reads += 1;
          return reads === 1
            ? directory
            : { hosts: [host], entries: [entry("entry-other", "project-live")] };
        },
        connectHost: pendingCredentials,
      } as never,
      readTree: async () => tree,
      openWizard,
    });
    expect(openWizard).not.toHaveBeenCalled();
  });
});
