import type { RemoteWorkspaceBoundScope } from "@/app-shell/types.js";
import type { RemoteWorkspaceProjection } from "./remoteWorkspaceProjection.js";

export type RemoteWorkspaceReconnectOptions = {
  activateWorkspaceAfterReconnect?: boolean;
  showErrorToast?: boolean;
  throwOnFailure?: boolean;
};

/** 打开远端项目：唯一带返回值的意图，调用方必须消费 Host bind 后的权威 scope。 */
export type OpenRemoteProjectIntent = {
  draftProjectId?: string | null;
  preparedWorkspaceIdentity?: string;
  isCurrent?: () => boolean | Promise<boolean>;
  sourceServerId: string;
  path: string;
  profileId?: string;
  localWorkspacePath?: string;
  remoteSessionId?: string;
};

export type RemoteWorkspaceIntent =
  | { type: "connect-device"; profileId: string; effect: "select-project" | "device-management" }
  | { type: "disconnect-device"; sourceServerId: string }
  | {
      type: "open-conversation";
      sourceServerId: string;
      remoteSessionId?: string;
      profileId?: string;
    }
  | {
      type: "reconnect-workspace";
      workspaceKey: string;
      options?: RemoteWorkspaceReconnectOptions;
    }
  | { type: "close-workspace"; workspaceKey: string; origin: "user-close" };

export interface RemoteWorkspaceControllerHandlers {
  connectDevice: (
    profileId: string,
    effect: "select-project" | "device-management",
  ) => Promise<void>;
  disconnectDevice: (sourceServerId: string) => Promise<void>;
  openConversation: (input: {
    sourceServerId: string;
    remoteSessionId?: string;
    profileId?: string;
  }) => Promise<void>;
  openProject: (input: OpenRemoteProjectIntent) => Promise<RemoteWorkspaceBoundScope>;
  reconnectWorkspace: (
    workspaceKey: string,
    options?: RemoteWorkspaceReconnectOptions,
  ) => Promise<void>;
  closeWorkspace: (workspaceKey: string) => Promise<void>;
}

export interface RemoteWorkspaceController {
  readonly projection?: RemoteWorkspaceProjection;
  dispatch(intent: RemoteWorkspaceIntent): Promise<void>;
  /**
   * 打开远端项目并返回 Host bind 之后的权威 workspace scope。
   *
   * 单独成方法而不是 `dispatch` 的一个意图：bind 会把身份换代成稳定命名空间
   * （`remote:server:<sourceServerId>:<path>`），UI 只能消费这里返回的值做后续判断，
   * 不能再用调用方传入的 transport/route 身份（`remote:wsl:*`）做等价比较。
   * 契约见 packages/ui/spec/remote-workspace-identity-authority.md。
   */
  openProject(intent: OpenRemoteProjectIntent): Promise<RemoteWorkspaceBoundScope>;
}

export function createRemoteWorkspaceController(
  handlers: RemoteWorkspaceControllerHandlers,
  projection?: RemoteWorkspaceProjection,
): RemoteWorkspaceController {
  return {
    projection,
    async dispatch(intent) {
      switch (intent.type) {
        case "connect-device":
          await handlers.connectDevice(intent.profileId, intent.effect);
          return;
        case "disconnect-device":
          await handlers.disconnectDevice(intent.sourceServerId);
          return;
        case "open-conversation":
          // 旧回调也不能绕过项目创建，拒绝前不产生连接或目录副作用。
          throw new Error("project.remote-project-required");
        case "reconnect-workspace":
          if (intent.options) {
            await handlers.reconnectWorkspace(intent.workspaceKey, intent.options);
          } else {
            await handlers.reconnectWorkspace(intent.workspaceKey);
          }
          return;
        case "close-workspace":
          if (intent.origin !== "user-close")
            throw new Error("workspace close requires user-close origin");
          await handlers.closeWorkspace(intent.workspaceKey);
          return;
      }
    },
    openProject: (intent) => handlers.openProject(intent),
  };
}
