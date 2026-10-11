import type { SubagentStateSnapshot } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { logger } from "@/logger.js";

/**
 * 把一个环境的子代理配置推到位：先整份写该环境的 `agents-state.json`，再让它已活动的会话
 * 按新配置重读（spec `subagent-settings-sync.md` D1/D2）。
 *
 * 只用于**远端环境的副本**：本机写入由设置页直接调 `subagentsService` 完成，不走这里。
 * 权威值永远来自调用方传入的快照，本函数不自己读盘。
 */
export async function replicateSubagentState(params: {
  services: IServiceAccessor;
  state: SubagentStateSnapshot;
}): Promise<void> {
  await params.services.subagentsService.replaceSubagentState(params.state);
  await params.services.zcodeAgentService.reloadSubagents();
}

/**
 * 远端连接就绪时（spec D1 时点 2）：从本机权威读全量配置并复制到该远端环境。
 * 覆盖「设置先于连接变更」的缺口——重连后远端文件与本机对齐，其后新建会话即读到最新值。
 *
 * 该路径是尽力而为：失败只记日志，不阻塞连接注册（下次重连再补）。
 */
export async function replicateSubagentStateOnRemoteConnect(params: {
  baseServices: IServiceAccessor;
  remoteServices: IServiceAccessor;
  sessionId: string;
}): Promise<void> {
  try {
    const state = await params.baseServices.subagentsService.getSubagentState();
    await replicateSubagentState({ services: params.remoteServices, state });
  } catch (error) {
    logger.warn("[subagent-state] 远端连接就绪时复制子代理配置失败（下次重连重试）", {
      sessionId: params.sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
