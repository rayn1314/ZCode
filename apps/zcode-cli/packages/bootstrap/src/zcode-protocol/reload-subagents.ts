import { zcodeWorkspaceReloadSubagentsParamsSchema } from "@zcode/shared";
import { parseParams, type ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 子代理配置热重载（spec `subagent-settings-sync.md` D2/D3）。
 *
 * 载荷只有 workspace ref：handler 让每个运行中会话按**当前磁盘**重新解析 profile 清单。
 * 调用方必须先落盘再调用（本机写入 / 远端复制都在推送之前 await），因此不传值也不会
 * 读到旧状态；反过来，协议层也没有「载荷落后于磁盘」的窗口。
 *
 * 不缓存到 `appRuntimePreferences`：磁盘是唯一事实源，未来会话每次构造重读，缓存就是第二份。
 */
export async function reloadSubagents(
  context: ZCodeProtocolAgentServerContext,
  rawParams: unknown,
) {
  const params = parseParams(zcodeWorkspaceReloadSubagentsParamsSchema, rawParams);
  let reloadedSessionCount = 0;
  for (const record of context.sessions.values()) {
    // 找不到/不支持该能力的 session（旧 app、mock）跳过，其余照常（compaction 同款失败语义）。
    if (!record.app.reloadSubagents) continue;
    await record.app.reloadSubagents();
    reloadedSessionCount += 1;
  }

  return {
    workspace: params.workspace,
    reloadedSessionCount,
  };
}
