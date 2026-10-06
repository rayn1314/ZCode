import { zcodeWorkspaceUpdateCompactionPreferencesParamsSchema } from "@zcode/shared";
import { compactionPreferencesToPolicy } from "../compaction-policy.js";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 压缩偏好是 workspace 级偏好，但每个 resident session 各自持有 runtime.config.compact。
 * 因此协议层同时缓存偏好供之后创建/恢复的会话继承，并立即热更新已有 session——
 * 压缩策略在每次 turn-loop 迭代重新读取，所以无需重启会话即可生效（spec D3）。
 */
export async function updateCompactionPreferences(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceUpdateCompactionPreferencesParamsSchema, rawParams);
  const preferences = params.preferences;
  context.appRuntimePreferences.compaction = preferences;

  const policy = compactionPreferencesToPolicy(preferences);
  let updatedSessionCount = 0;
  for (const record of context.sessions.values()) {
    // 快照必须跟着热更新走：inherit 子会话读 parent.compaction 作为起始偏好，
    // 不刷新快照会让此后派生的子会话继续沿用旧值，父子语义分叉。
    record.compaction = preferences;
    // 找不到/不支持该能力的 session 跳过，其余照常（spec §5）。
    if (!record.app.setCompactionPolicy) continue;
    record.app.setCompactionPolicy(policy);
    updatedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    preferences,
    updatedSessionCount,
  };
}
