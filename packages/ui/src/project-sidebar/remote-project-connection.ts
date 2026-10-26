import type {
  IRemoteProjectService,
  ProjectTree,
  RemoteProjectDirectory,
} from "@/project-sidebar/contract.js";
import {
  buildServerRemoteWorkspaceIdentity,
  parseRemoteWorkspaceIdentity,
  remoteHostIdFromWorkspaceIdentity,
} from "@/project-sidebar/contract.js";
import type { SourceServerManagementSnapshot } from "@zcode/shared";
import type { RemoteConnectionOpenPreference } from "@/app-shell/types.js";
import { getWorkspaceSourceServerId } from "@/conversation-workspace-target/sourceIdentity.js";
import {
  buildRemoteTargetFromProfile,
  findPreferredSourceConnectionProfile,
} from "@/lib/remoteConnectionWizard.js";
import { resolveRemoteConnectionPresentation } from "@/lib/remoteConnectionPresentation.js";
import {
  entryClaimsDirectoryPath,
  resolveRemoteProjectEntryForDirectory,
} from "@/project-sidebar/remote-project-entry.js";
import { requestRemoteProjectConnection } from "@/remote-connection-flow/contract.js";

/** 最近目录不是新建请求；连接前固定已有入口，避免连接完成后误入创建器。 */
export function resolveRecentRemoteProjectPreference(
  directory: RemoteProjectDirectory,
  input: { sourceServerId: string; path: string; profileId?: string; tree?: ProjectTree },
): RemoteConnectionOpenPreference | null {
  const identity = buildServerRemoteWorkspaceIdentity({
    serverId: input.sourceServerId,
    workspacePath: input.path,
  });
  const hostId = remoteHostIdFromWorkspaceIdentity(identity);
  if (!hostId || !directory.hosts.some((host) => host.id === hostId)) return null;
  const resolution = resolveRemoteProjectEntryForDirectory({
    directory,
    hostId,
    path: input.path,
    tree: input.tree,
  });
  // 同一目录上已删除项目的残留入口不再让它退化成「没有偏好」；只有确实没有活项目才放弃固定入口。
  if (!resolution) return null;
  if (input.tree && (!resolution.project || resolution.project.deleted)) return null;
  return {
    ...(input.profileId
      ? { preferredProfileId: input.profileId }
      : { preferredSourceServerId: input.sourceServerId }),
    preferredDirectoryPath: resolution.rootPath,
    preferredProjectEntryId: resolution.entry.id,
  };
}

/** F5 下项目成员不等于已打开 tab；连接成员仍交给 Host，需要交互才移交唯一向导。 */
export async function requestRetainedRemoteProjectConnection(input: {
  workspaceKey: string;
  service: IRemoteProjectService;
  getSnapshot?: () => Promise<SourceServerManagementSnapshot>;
  /** 远端项目树读取：同根可能残留已删除项目的入口，靠它才能把偏好固定到活项目。 */
  readTree?: (hostId: string) => Promise<ProjectTree>;
  openWizard: (preference: RemoteConnectionOpenPreference) => void;
}) {
  const parsed = parseRemoteWorkspaceIdentity(input.workspaceKey);
  const hostId = remoteHostIdFromWorkspaceIdentity(input.workspaceKey);
  if (!parsed || !hostId) throw new Error("remote-project.entry-not-found");
  const directory = await input.service.readDirectory();
  const host = directory.hosts.find((candidate) => candidate.id === hostId);
  if (!host) throw new Error("remote-project.entry-not-found");
  const resolution = resolveRemoteProjectEntryForDirectory({
    directory,
    hostId,
    path: parsed.workspacePath,
    tree: await input.readTree?.(hostId),
  });
  if (!resolution) throw new Error("remote-project.entry-not-found");
  const entry = resolution.entry;
  const path = resolution.rootPath;
  // Direct Server 不属于 Source Profile 管理域，保留其原有连接与错误出口。
  if (host.kind === "server") {
    await input.service.connectHost(host.id);
    return;
  }
  const stillRetained = async () => {
    const current = await input.service.readDirectory();
    return (
      current.hosts.some(
        (candidate) => candidate.id === host.id && candidate.membershipId === host.membershipId,
      ) &&
      // 只复验原入口是否仍在同一目录；这里不能走「活项目优先」，否则软删残留入口会顶掉原入口。
      current.entries.some(
        (candidate) =>
          candidate.id === entry.id && entryClaimsDirectoryPath(candidate, parsed.workspacePath),
      )
    );
  };
  const snapshot = await input.getSnapshot?.();
  if (!(await stillRetained())) return;
  const sourceId = getWorkspaceSourceServerId(
    {
      workspacePath: path,
      workspaceIdentity: input.workspaceKey,
      remoteTarget: host.target ?? undefined,
    },
    { workspaceHistory: snapshot?.workspaceHistory },
  );
  // 展示聚合会优先选失败/待处理线路，不能据此替换 Host 的默认操作线路。
  const profile =
    snapshot && sourceId ? findPreferredSourceConnectionProfile(snapshot, sourceId) : undefined;
  const state = snapshot?.states.find((candidate) => candidate.profileId === profile?.profileId);
  const server = snapshot?.servers.find((candidate) => candidate.sourceServerId === sourceId);
  let pendingWizard: RemoteConnectionOpenPreference | undefined;
  await requestRemoteProjectConnection({
    preference: {
      preferredDirectoryPath: path,
      preferredProjectEntryId: entry.id,
      preferredProfileId: profile?.profileId,
      preferredTarget: profile ? buildRemoteTargetFromProfile(profile) : (host.target ?? undefined),
    },
    presentation: resolveRemoteConnectionPresentation({
      ...state,
      installState: server?.installState,
      // Host 错误也是设备聚合；已确定操作线路时只能使用该线路的错误。
      projectError: profile ? undefined : host.lastConnectionError,
    }),
    failure: {
      code: state?.errorCode,
      message: state?.error ?? (profile ? "" : (host.lastConnectionError ?? "")),
    },
    reconnect: async () => {
      await input.service.connectHost(host.id);
    },
    openWizard: (preference) => {
      pendingWizard = preference;
    },
  });
  // 凭据/更新结果可能晚于成员移除；引用和旧快照都不能授权复活已移除的项目。
  if (pendingWizard && (await stillRetained())) input.openWizard(pendingWizard);
}
