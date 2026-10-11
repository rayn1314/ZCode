import type {
  ZCodeProvider,
  AgentSummary,
  AgentsListResult,
  AgentCreateParams,
  AgentUpdateParams,
  AgentDeleteParams,
  BuiltInSubagentModelOverrideParams,
  PluginSubagentModelOverrideParams,
  SubagentStateSnapshot,
  SubagentsListMode,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISubagentsService {
  list(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    provider?: ZCodeProvider;
    mode?: SubagentsListMode;
  }): Promise<AgentsListResult>;

  /**
   * 写启用状态并返回写盘后的**全量**快照：与下面两个覆盖写入同一份 `agents-state.json`，
   * 同样需要推给运行中会话（spec `subagent-settings-sync.md` D2/D4）。
   */
  setEnabled(params: { agentId: string; enabled: boolean }): Promise<SubagentStateSnapshot>;

  /**
   * 读本机权威的全量子代理配置快照：远端连接就绪时经它取值复制给远端环境
   * （spec `subagent-settings-sync.md` D1 时点 2）。
   */
  getSubagentState(): Promise<SubagentStateSnapshot>;

  /**
   * 整份替换本数据根的子代理配置快照（只用于**远端副本**写入）：一次调用即可同时表达
   * 「改回继承 / 重新启用」等删除语义，不必逐键遍历（spec D2）。
   */
  replaceSubagentState(state: SubagentStateSnapshot): Promise<SubagentStateSnapshot>;

  /**
   * 写盘并返回写盘后的**全量**快照：调用方据此原样推给本数据根的运行中会话做热重载
   * （spec `subagent-settings-sync.md` D2/D4）。
   */
  setBuiltInModelOverride(
    params: BuiltInSubagentModelOverrideParams,
  ): Promise<SubagentStateSnapshot>;

  /** 只写用户 state 的完整覆盖，不改插件 Markdown；同样返回写盘后的全量快照。 */
  setPluginAgentModelOverride(
    params: PluginSubagentModelOverrideParams,
  ): Promise<SubagentStateSnapshot>;

  /** 当前筛选来源对应的用户级 agent 根目录（与内置扫描顺序一致，取 buildUserRoots 的首项）。 */
  getPrimaryUserAgentsDirectory(params: { provider: ZCodeProvider }): Promise<{ path: string }>;

  /** 创建新的 agent 文件 */
  createAgent(params: AgentCreateParams): Promise<{ agent: AgentSummary }>;

  /** 更新现有 agent 文件 */
  updateAgent(params: AgentUpdateParams): Promise<{ agent: AgentSummary }>;

  /** 删除 agent 文件 */
  deleteAgent(params: AgentDeleteParams): Promise<void>;
}

export const ISubagentsService = createServiceDescriptor<ISubagentsService>(
  ServiceChannels.Subagents,
);
