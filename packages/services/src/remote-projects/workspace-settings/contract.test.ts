import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { projectStorage } from "#src/project-storage/index.js";
import {
  createRemoteProjectService,
  projectWorkspaceSettings,
} from "#src/remote-projects/index.js";
import { appSettingsSchema } from "@zcode/shared";
import type { RemoteProjectCache } from "#src/remote-projects/contract.js";
const databases: DatabaseSync[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys=ON");
  const directory = await mkdtemp(join(tmpdir(), "remote-project-test-"));
  directories.push(directory);
  await projectStorage.migrate(db, { backupDirectories: [directory] });
  const afterChange = vi.fn();
  const service = createRemoteProjectService({
    database: async () => db,
    afterChange,
    now: () => 100,
  });
  const target = { kind: "ssh" as const, host: "example.test", username: "user" };
  await service.saveHost({ id: "source", target });
  const project: RemoteProjectCache = {
    projectId: "p",
    name: "Remote",
    roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
  };
  return { db, service, afterChange, target, project };
}
describe("workspace settings projection", () => {
  it("只从本机保留入口派生兼容集合；删除入口不因活动目录或旧快照复活", async () => {
    const { db, service, target, project } = await fixture();
    await service.saveHost({ id: "remote:server:retained", target });
    const saved = await service.addEntry({ hostId: "remote:server:retained", project });
    const repository = projectStorage.repository(db);
    const local = repository.saveProject({ roots: ["/local", "/shared"], name: "local" });
    repository.saveProject({ roots: ["/shared"], name: "other" });
    const settings = appSettingsSchema.parse({
      lastWorkspaceSession: [{ kind: "local", workspacePath: "/old-removed" }],
      recentProjects: ["/old-removed"],
      lastActiveWorkspace: {
        kind: "remote",
        target,
        workspacePath: "/repo",
        workspaceIdentity: "remote:server:retained:/repo",
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
    });
    const result = projectWorkspaceSettings(
      repository.readTree({ includeTasks: false }).projects,
      await service.readDirectory(),
      settings,
    );
    // 修复原因：项目仓库已将新建项目放到最前，兼容投影应按该顺序去重 roots。
    expect(result.recentProjects).toEqual(["/shared", "/local"]);
    expect(result.lastWorkspaceSession).toHaveLength(3);
    expect(result.lastActiveTabIndex).toBe(2);
    expect(result.lastActiveWorkspace).toMatchObject({
      workspaceIdentity: "remote:server:retained:/repo",
    });
    expect(result.lastWorkspaceSession?.at(-1)).toMatchObject({
      // 修复原因：host.id 是 Source Server 的 route 身份（remote:server:<sourceServerId>），
      // 权威稳定身份必须由它构造；host.target 只是 relay 的 transport，不能拿它现算。
      workspaceIdentity: "remote:server:retained:/repo",
      target,
    });
    await service.removeEntry(saved.id);
    repository.deleteProject(local.id);
    const removed = projectWorkspaceSettings(
      repository.readTree({ includeTasks: false }).projects,
      await service.readDirectory(),
      { ...settings, ...result },
    );
    expect(removed.recentProjects).toEqual(["/shared"]);
    expect(removed.lastWorkspaceSession).toEqual([
      { kind: "local", workspacePath: "/shared", workspacePurpose: "project" },
    ]);
    expect(removed.lastActiveWorkspace).toBeNull();
  });

  it("活动 conversation 只保留选择不写兼容项目集合，移除连接后清空且 null 不回读旧值", async () => {
    const { service, target } = await fixture();
    await service.removeHost("source");
    const settings = appSettingsSchema.parse({
      lastActiveWorkspace: {
        kind: "remote",
        workspacePath: "/chat",
        workspacePurpose: "conversation",
        workspaceIdentity: "remote:ssh:example.test:22:user:/chat",
        target,
        lastOpenedAt: 1,
        lastConnectionStatus: "connected",
      },
    });
    await service.saveHost({ id: "remote:ssh:example.test:22:user", target });
    const first = projectWorkspaceSettings([], await service.readDirectory(), settings);
    expect(first.lastWorkspaceSession).toEqual([]);
    expect(first.lastActiveWorkspace).toMatchObject({ workspacePath: "/chat" });
    await service.removeHost("remote:ssh:example.test:22:user");
    expect(
      projectWorkspaceSettings([], await service.readDirectory(), settings).lastActiveWorkspace,
    ).toBeNull();
    expect(
      projectWorkspaceSettings([], await service.readDirectory(), {
        ...settings,
        lastActiveWorkspace: null,
        lastWorkspaceSession: [{ kind: "local", workspacePath: "/old" }],
      }).lastActiveWorkspace,
    ).toBeNull();
  });

  it("Source Server 路由写稳定身份；legacy 直连 WSL 主机仍写 transport 身份", async () => {
    const { db, service, project } = await fixture();
    await service.removeHost("source");
    const wsl = { kind: "wsl" as const, distro: "Ubuntu", user: "rayn" };
    // Source Server 场景：route 身份（remote:server:<sourceServerId>）才是权威稳定身份，
    // relay transport（wsl）只是连接手段。
    await service.saveHost({ id: "remote:server:0dd064e1", target: wsl });
    await service.addEntry({ hostId: "remote:server:0dd064e1", project });
    // legacy 直连 WSL 主机没有 sourceServerId，transport 身份是它唯一可解析的形式，不许改写。
    await service.saveHost({ id: "remote:wsl:Ubuntu:rayn", target: wsl });
    await service.addEntry({
      hostId: "remote:wsl:Ubuntu:rayn",
      project: {
        ...project,
        projectId: "legacy",
        roots: [{ rootPath: "/home/rayn/repo", position: 0, isPrimary: true }],
      },
    });
    const repository = projectStorage.repository(db);
    const result = projectWorkspaceSettings(
      repository.readTree({ includeTasks: false }).projects,
      await service.readDirectory(),
      appSettingsSchema.parse({}),
    );
    const identities = new Map(
      (result.lastWorkspaceSession ?? []).flatMap((entry) =>
        entry.kind === "remote" ? [[entry.workspacePath, entry.workspaceIdentity] as const] : [],
      ),
    );
    expect(identities.get("/repo")).toBe("remote:server:0dd064e1:/repo");
    expect(identities.get("/home/rayn/repo")).toBe("remote:wsl:Ubuntu:rayn:/home/rayn/repo");
  });

  it("读取兼容：存量 transport 身份与稳定身份都解析到同一 host 与稳定身份", async () => {
    const { service, target, project } = await fixture();
    await service.removeHost("source");
    await service.saveHost({ id: "remote:server:retained", target });
    await service.addEntry({ hostId: "remote:server:retained", project });
    const directory = await service.readDirectory();
    // 现场两种格式并存：旧写入留下的 transport 身份，与修复后写入的稳定身份。
    const active = (workspaceIdentity: string) =>
      projectWorkspaceSettings(
        [],
        directory,
        appSettingsSchema.parse({
          lastActiveWorkspace: {
            kind: "remote",
            workspacePath: "/repo",
            target,
            workspaceIdentity,
            lastOpenedAt: 1,
            lastConnectionStatus: "connected",
          },
        }),
      ).lastActiveWorkspace;
    expect(active("remote:ssh:example.test:22:user:/repo")).toMatchObject({
      workspaceIdentity: "remote:server:retained:/repo",
      target,
    });
    expect(active("remote:server:retained:/repo")).toMatchObject({
      workspaceIdentity: "remote:server:retained:/repo",
      target,
    });
    // lastActiveWorkspace 缺席时按旧快照条目取选择：条目是 transport 身份也照样收敛。
    expect(
      projectWorkspaceSettings(
        [],
        directory,
        appSettingsSchema.parse({
          lastWorkspaceSession: [
            {
              kind: "remote",
              workspacePath: "/repo",
              target,
              workspaceIdentity: "remote:ssh:example.test:22:user:/repo",
              lastOpenedAt: 1,
              lastConnectionStatus: "connected",
            },
          ],
          lastActiveTabIndex: 0,
        }),
      ).lastActiveWorkspace,
    ).toMatchObject({ workspaceIdentity: "remote:server:retained:/repo" });
  });
});
