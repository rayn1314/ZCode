export interface ComputerUseRuntimeContext {
  sessionId: string;
  runtimeScope: "main" | "subagent";
  workspaceKey: string;
  workspacePath?: string;
  workspaceIdentity?: string;
  remoteSessionId?: string;
  turnId?: string;
  clientMode?: "web-remote-replayable" | "desktop-continuous";
  deliveryKind?: "web-remote-replayable" | "desktop-continuous";
  trace?: Record<string, unknown>;
}

export interface ComputerUseRuntimeExecuteInput {
  toolName: string;
  arguments?: unknown;
  context: ComputerUseRuntimeContext;
  signal?: AbortSignal;
}

export interface ComputerUseRuntime {
  execute(input: ComputerUseRuntimeExecuteInput): Promise<unknown>;
  closeSession(context: ComputerUseRuntimeContext): Promise<void>;
  dispose(): Promise<void>;
}

export interface ComputerUseRuntimeOptions {
  brokerSocketPath?: string;
  refreshMarkerPath?: string;
  ensureBrokerAvailable?: () => Promise<void>;
  env?: Record<string, string | undefined>;
  /** 桥接模式：把官方工具面转发到开源引擎（open-computer-use）。 */
  bridge?: boolean;
  /** 桥接模式：开源 MCP server 的启动命令（默认 cmd）。 */
  command?: string;
  /** 桥接模式：开源 MCP server 的启动参数（默认 ["/c","open-computer-use","mcp"]）。 */
  args?: string[];
}

export declare function createComputerUseRuntime(
  options?: ComputerUseRuntimeOptions,
): ComputerUseRuntime;
