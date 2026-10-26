import { expect, it, vi } from "vitest";
import { attachRemoteProjectWorkspace } from "@/project-sidebar/remote-navigation.js";

const AUTHORITY_IDENTITY = "remote:server:s:/same";
/** Host 在 Source Server 身份已知前登记的是 transport/route 命名空间身份。 */
const LEGACY_IDENTITY = "remote:wsl:Ubuntu:user:/same";

function fixture(authorityIdentity = AUTHORITY_IDENTITY) {
  const sessions = new Map<string, { sessionId: string }>();
  const identity = AUTHORITY_IDENTITY;
  const input = {
    hostId: "remote:server:s",
    workspacePath: "/same",
    workspaceIdentity: identity,
    remoteService: {
      connectHost: vi.fn(async () => ({
        id: "remote:server:s",
        target: { kind: "docker", container: "s" },
      })),
    } as never,
    findSession: (key: string) => sessions.get(key),
    connect: vi.fn(async () => "new-session"),
    // bind 是身份换代点：登记/回查只用 Host 返回的权威 identity，不回读调用方传入值。
    bind: vi.fn(async (sessionId: string) => {
      sessions.set(authorityIdentity, { sessionId });
      return { workspacePath: "/same", workspaceIdentity: authorityIdentity };
    }),
    cancel: vi.fn(async () => {}),
  };
  return { sessions, identity, input };
}
it("uses the exact identity and existing physical connection, not another Source's same cwd", async () => {
  const { sessions, input } = fixture();
  sessions.set("remote:server:other:/same", { sessionId: "other" });
  expect(await attachRemoteProjectWorkspace(input)).toBe("new-session");
  expect(input.connect).toHaveBeenCalledOnce();
  expect(input.bind).toHaveBeenCalledWith("new-session", "/same");
  expect(input.cancel).not.toHaveBeenCalled();
});
it("converges a legacy route identity to the authoritative scope returned by bind", async () => {
  // 侧栏行可能带 `remote:wsl:*`（transport/route 命名空间）打开项目：Host bind 会把它换代成
  // `remote:server:*`，断言必须消费 bind 返回的权威 scope，否则成功的绑定被误判成 mismatch。
  const { sessions, input } = fixture();
  expect(await attachRemoteProjectWorkspace({ ...input, workspaceIdentity: LEGACY_IDENTITY })).toBe(
    "new-session",
  );
  expect(input.connect).toHaveBeenCalledOnce();
  expect(sessions.get(AUTHORITY_IDENTITY)).toEqual({ sessionId: "new-session" });
  expect(sessions.has(LEGACY_IDENTITY)).toBe(false);
});
it("does not reject an authoritative identity that is unchanged by bind", async () => {
  const { sessions, identity, input } = fixture();
  sessions.set(identity, { sessionId: "existing" });
  expect(await attachRemoteProjectWorkspace(input)).toBe("existing");
  expect(input.connect).not.toHaveBeenCalled();
  expect(sessions.get(identity)).toEqual({ sessionId: "existing" });
});
it("rejects when the bound attachment is not reachable through the authoritative scope", async () => {
  // 断言仍然守着「bind 后的权威身份必须指向本次 attachment」：换代会话 id 或丢登记都要失败。
  const { input } = fixture();
  input.bind.mockImplementationOnce(async () => ({
    workspacePath: "/same",
    workspaceIdentity: "remote:server:s:/other",
  }));
  await expect(attachRemoteProjectWorkspace(input)).rejects.toThrow(
    "project.workspace-identity-mismatch",
  );
  expect(input.cancel).toHaveBeenCalledWith("new-session");
});
it("reuses the attached workspace and does not cancel it on failure", async () => {
  const { sessions, identity, input } = fixture();
  sessions.set(identity, { sessionId: "existing" });
  input.bind.mockRejectedValueOnce(new Error("bind failed"));
  await expect(attachRemoteProjectWorkspace(input)).rejects.toThrow("bind failed");
  expect(input.connect).not.toHaveBeenCalled();
  expect(input.cancel).not.toHaveBeenCalled();
});
it("releases only the new logical attachment when binding fails", async () => {
  const { input } = fixture();
  input.bind.mockRejectedValueOnce(new Error("bind failed"));
  await expect(attachRemoteProjectWorkspace(input)).rejects.toThrow("bind failed");
  expect(input.cancel).toHaveBeenCalledWith("new-session");
});

it("does not bind a late connection after navigation is superseded and releases its attachment", async () => {
  const { input } = fixture();
  let current = true;
  input.connect.mockImplementation(async () => {
    current = false;
    return "late";
  });
  await expect(
    attachRemoteProjectWorkspace({ ...input, isCurrent: () => current }),
  ).rejects.toThrow("project.navigation-cancelled");
  expect(input.bind).not.toHaveBeenCalled();
  expect(input.cancel).toHaveBeenCalledWith("late");
});
it("does not create an attachment when the Host response belongs to an old navigation", async () => {
  const { input } = fixture();
  await expect(attachRemoteProjectWorkspace({ ...input, isCurrent: () => false })).rejects.toThrow(
    "project.navigation-cancelled",
  );
  expect(input.connect).not.toHaveBeenCalled();
});

it("does not bind a replaced Host membership after attachment preparation", async () => {
  const { input } = fixture();
  const host = {
    id: input.hostId,
    membershipId: "original",
    target: { kind: "docker" as const, container: "s" },
  };
  const remoteService = {
    connectHost: vi.fn(async () => host),
    readDirectory: vi.fn(async () => ({
      hosts: [{ ...host, membershipId: "replacement" }],
      entries: [],
    })),
  };
  await expect(
    attachRemoteProjectWorkspace({
      ...input,
      remoteService: remoteService as never,
      expectedMembershipId: "original",
    }),
  ).rejects.toThrow("remote-project.host-removed");
  expect(input.bind).not.toHaveBeenCalled();
  expect(input.cancel).toHaveBeenCalledWith("new-session");
});

it("rejects a removed project at the navigation barrier and preserves a shared attachment", async () => {
  const { input, sessions, identity } = fixture();
  sessions.set(identity, { sessionId: "shared" });
  const projectService = { readProjects: vi.fn(async () => []) };
  await expect(
    attachRemoteProjectWorkspace({ ...input, projectId: "removed", projectService }),
  ).rejects.toThrow("project.not-found");
  expect(input.bind).not.toHaveBeenCalled();
  expect(input.cancel).not.toHaveBeenCalled();
});
