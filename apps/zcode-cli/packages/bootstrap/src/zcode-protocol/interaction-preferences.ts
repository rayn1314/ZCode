import { zcodeWorkspaceUpdateInteractionPreferencesParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 应用 workspace 交互偏好。CLI 进程按 workspace 隔离，因此 registry 是该 workspace
 * 内主任务、后台任务与子 Agent 共用的权威 gate。
 */
export async function updateInteractionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateInteractionPreferencesParamsSchema, rawParams);
  const enabled = params.preferences.askUserQuestionAutoResolutionEnabled;
  context.appRuntimePreferences.askUserQuestionAutoResolutionEnabled = enabled;
  const snoozedInteractionCount =
    await context.v4Interactions.setAskUserQuestionAutoResolutionEnabled(enabled);
  // 授权超时开关：只写进程级 holder，协议 broker 每次询问时实时读它。字段缺失（旧 Host
  // 的命令）时保持当前值——默认开启，与 handshake 的 .default(true) 同源。
  const permissionAutoDenyEnabled = params.preferences.permissionRequestAutoDenyEnabled;
  if (permissionAutoDenyEnabled !== undefined) {
    context.appRuntimePreferences.permissionRequestAutoDenyEnabled = permissionAutoDenyEnabled;
  }

  return {
    workspace: params.workspace,
    askUserQuestionAutoResolutionEnabled: enabled,
    // 回显**实际生效**的值，而不是入参：这样 Host 侧能看出"没传 = 沿用原值"。
    permissionRequestAutoDenyEnabled:
      context.appRuntimePreferences.permissionRequestAutoDenyEnabled,
    snoozedInteractionCount,
  };
}
