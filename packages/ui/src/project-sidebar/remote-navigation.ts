import type { RemoteWorkspaceBoundScope } from "@/app-shell/types.js";
import type {
  IProjectService,
  IRemoteProjectService,
  ProjectSidebarProps,
} from "@/project-sidebar/contract.js";

/** 连接实例归 Host；这里只申请/绑定 logical attachment，不按 path 复用另一台设备的 scope。 */
export async function attachRemoteProjectWorkspace(input: {
  hostId: string;
  workspacePath: string;
  workspaceIdentity: string;
  expectedMembershipId?: string;
  projectId?: string | null;
  projectService?: Pick<IProjectService, "readProjects">;
  remoteService: IRemoteProjectService;
  isCurrent?(): boolean;
  findSession(identity: string): { sessionId: string } | undefined;
  connect: ProjectSidebarProps["onConnectRemote"];
  /** 返回 Host bind 之后的权威 scope；调用方传入的 workspaceIdentity 只是绑定输入，不是校验依据。 */
  bind(
    sessionId: string,
    path: string,
    isCurrent?: () => boolean | Promise<boolean>,
  ): Promise<RemoteWorkspaceBoundScope>;
  cancel: ProjectSidebarProps["onCancelRemoteProject"];
}): Promise<string> {
  const assertCurrent = () => {
    if (input.isCurrent?.() === false) throw new Error("project.navigation-cancelled");
  };
  assertCurrent();
  const host = await input.remoteService.connectHost(input.hostId);
  assertCurrent();
  if (host.id !== input.hostId || !host.target) throw new Error("project.host-identity-changed");
  if (input.expectedMembershipId && host.membershipId !== input.expectedMembershipId)
    throw new Error("remote-project.host-removed");
  const validateMembership = async () => {
    if (input.expectedMembershipId) {
      const directory = await input.remoteService.readDirectory();
      if (
        !directory.hosts.some(
          (item) => item.id === input.hostId && item.membershipId === input.expectedMembershipId,
        )
      )
        throw new Error("remote-project.host-removed");
    }
    if (input.projectService && input.projectId) {
      const projects = await input.projectService.readProjects({ hostId: input.hostId });
      if (
        !projects.some(
          (project) =>
            project.id === input.projectId &&
            project.hostId === input.hostId &&
            !project.deleted &&
            project.roots.length === 1 &&
            project.roots[0]?.rootPath === input.workspacePath,
        )
      )
        throw new Error("project.not-found");
    }
    assertCurrent();
    return true;
  };
  const existing = input.findSession(input.workspaceIdentity);
  const sessionId = existing?.sessionId ?? (await input.connect(host.target));
  const bindWorkspace = async (targetSessionId: string) => {
    if (input.expectedMembershipId || input.projectService) {
      // Host 在连接等待中被移除再添加时，原请求不能借新成员的身份提交导航。
      await validateMembership();
      return input.bind(targetSessionId, input.workspacePath, validateMembership);
    }
    if (input.isCurrent) return input.bind(targetSessionId, input.workspacePath, input.isCurrent);
    return input.bind(targetSessionId, input.workspacePath);
  };
  let ownSessionReclaimed = false;
  try {
    // 连接和绑定都会等待远端；只回收本次创建的 attachment，不能取消其他项目复用的连接。
    assertCurrent();
    const boundScope: RemoteWorkspaceBoundScope = await bindWorkspace(sessionId);
    // 修复原因：bind 是身份换代点——Host 会把 Source Server 侧身份统一登记为
    // `remote:server:<sourceServerId>:<path>`，而调用方传入的 identity 可能是 transport
    // 命名空间（`remote:wsl:<distro>[:<user>]:<path>`，见 Root.tsx 的连接目录选择与
    // packages/desktop/src/host/index.ts 的 connect descriptor）。用调用方原样身份回查，
    // 会把一次成功的绑定误判成 project.workspace-identity-mismatch。
    // 依据：packages/ui/spec/remote-workspace-identity-authority.md。
    const bound = input.findSession(boundScope.workspaceIdentity);
    if (!bound) throw new Error("project.workspace-identity-mismatch");
    if (bound.sessionId === sessionId) return sessionId;
    // 修复原因：并发打开同一工作区时，先到的请求已经把这个权威 scope 绑定好了；scope 的归属是
    // workspace 而不是某一次点击。这里让位给已登记的 live session，只回收本次调用自己新建的重复
    // session，而不是把「另一个实例已经拥有该 workspace」当成自己的失败。
    // 现场依据（2026-10-27 06:58:59）：bind 在 .594 成功，.614 就被另一个入口回收，后到的请求只
    // 能重新连接，形成 connect → bind → cancel 的循环。
    // 依据：packages/ui/spec/remote-workspace-open-handover.md。
    await bindWorkspace(bound.sessionId);
    ownSessionReclaimed = true;
    await input.cancel(sessionId);
    return bound.sessionId;
  } catch (error) {
    // 被更晚的入口取代时只让位，不回收 session：它已登记在权威 scope 上，可能正被取代方采用；
    // 过去在这里回收，等于让每次点击都销毁自己刚建立好的连接，后到的点击永远从头再来。
    // 只有真正的导航失败（设备/成员/项目/bind 失败）才回收本次创建的 attachment。
    const superseded = error instanceof Error && error.message === "project.navigation-cancelled";
    if (!existing && !ownSessionReclaimed && !superseded) await input.cancel(sessionId);
    throw error;
  }
}
