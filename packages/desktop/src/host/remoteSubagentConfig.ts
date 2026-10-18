import type {
  RemoteTarget,
  SubagentStateSnapshot,
  SubagentUserAgentFilesSnapshot,
} from "@zcode/shared";
import type { ISubagentsService, IZCodeAgentService } from "@zcode/services";

/** 副本载荷：三项配置 + 用户级 agent 的 markdown 原文（spec `subagent-settings-sync.md` D1）。 */
export interface SubagentConfigAuthority {
  state: SubagentStateSnapshot;
  files: SubagentUserAgentFilesSnapshot;
}

export interface SubagentConfigPushConnection {
  target: RemoteTarget;
  /** 连接**自身**的服务，不能用作用域集合：那里的子代理服务是本机实现。 */
  subagentsService: Pick<ISubagentsService, "replaceSubagentState" | "replaceUserAgentFiles">;
  zcodeAgentService: Pick<IZCodeAgentService, "reloadSubagents">;
}

/**
 * 把本机权威的子代理配置复制给远程 Host（spec `subagent-settings-sync.md` D1）。
 *
 * desktop-attached remote Host（SSH / WSL / Docker）的会话读自己的数据根，而设置页只写本机：
 * 副本必须由 desktop 推过去，两个时点各推一次（本机权威写入后广播、远端连接就绪时补一次）。
 * standalone server 有自己的设置权威，不推。单个连接失败只上报，不影响其它连接。
 *
 * 顺序：先写 state、再写用户 agent 文件、最后发一次重载——重载按磁盘整份重解析，分两次发
 * 只会让中间态多一次无意义重读。旧对端不认 `replaceUserAgentFiles` 时只降级那一步，
 * state 复制与重载照常（§4 失败语义）。
 */
export async function pushSubagentConfigToRemoteHosts(params: {
  connections: ReadonlyArray<SubagentConfigPushConnection>;
  readAuthority: () => Promise<SubagentConfigAuthority>;
  onError: (error: unknown) => void;
}): Promise<void> {
  const targets = params.connections.filter((connection) => connection.target.kind !== "server");
  if (targets.length === 0) return;
  // 读本机权威失败（磁盘/权限）不能让调用方产生未处理的 rejection：调用点多数是
  // 「保存后顺手广播」的 fire-and-forget，失败只上报。
  let authority: SubagentConfigAuthority;
  try {
    authority = await params.readAuthority();
  } catch (error) {
    params.onError(error);
    return;
  }
  await Promise.all(
    targets.map(async (connection) => {
      try {
        await connection.subagentsService.replaceSubagentState(authority.state);
      } catch (error) {
        // state 都没写进去时继续写文件只会留下半份副本，直接放弃这个连接。
        params.onError(error);
        return;
      }
      try {
        await connection.subagentsService.replaceUserAgentFiles(authority.files);
      } catch (error) {
        params.onError(error);
      }
      try {
        await connection.zcodeAgentService.reloadSubagents();
      } catch (error) {
        params.onError(error);
      }
    }),
  );
}
