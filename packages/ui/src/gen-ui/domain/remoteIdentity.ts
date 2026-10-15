// 侧聊/子代理等 fork 会话渲染 Gen UI 时，上游消息渲染链可能丢失远端身份透传，
// workspaceIdentity/remoteSessionId 落到空后服务解析会回落到本机 base services，
// 远端工作区曾因此读到桌面 Windows 根而报 "Gen UI file is outside the host output directory"。
// 渲染身份以 workspace tab 为权威：workspacePath 匹配的 tab 带远程元数据即借用，
// 保证 Gen UI 读端与 Agent 写端同源（spec: gen-ui-cross-host-render.md）。
export interface GenUiRemoteIdentity {
  workspaceIdentity?: string;
  remoteSessionId?: string;
  remoteTarget?: unknown;
}

export interface GenUiRemoteIdentityTab {
  workspacePath: string;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  remoteTarget?: unknown;
}

export function resolveGenUiTargetRemoteIdentity(params: {
  workspacePath: string | null | undefined;
  workspaceIdentity?: string | null;
  remoteSessionId?: string | null;
  workspaceTabs: readonly GenUiRemoteIdentityTab[];
}): GenUiRemoteIdentity | null {
  const workspaceIdentity = params.workspaceIdentity?.trim();
  const remoteSessionId = params.remoteSessionId?.trim();
  if (workspaceIdentity || remoteSessionId) {
    return {
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      ...(remoteSessionId ? { remoteSessionId } : {}),
    };
  }

  if (!params.workspacePath) {
    return null;
  }

  // 侧聊与主会话共享同一 workspacePath，这里不要求唯一匹配——唯一匹配判据在
  // resolveWorkspaceServiceIsRemoteTarget 里会因同路径多 tab 落空，正是事故场景。
  const matched = (params.workspaceTabs ?? []).find(
    (tab) =>
      tab.workspacePath === params.workspacePath &&
      Boolean(tab.workspaceIdentity?.trim() || tab.remoteSessionId?.trim() || tab.remoteTarget),
  );
  if (!matched) {
    return null;
  }
  return {
    ...(matched.workspaceIdentity?.trim()
      ? { workspaceIdentity: matched.workspaceIdentity.trim() }
      : {}),
    ...(matched.remoteSessionId?.trim() ? { remoteSessionId: matched.remoteSessionId.trim() } : {}),
    ...(matched.remoteTarget ? { remoteTarget: matched.remoteTarget } : {}),
  };
}
