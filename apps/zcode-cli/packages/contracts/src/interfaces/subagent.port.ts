// ============================================================
// Subagent Port - child agent execution boundary
// ============================================================

import type { AgentBackgroundedOutput, AgentOutput } from "../tools/agent.js";
import type { Model, ModelSelection } from "../model/index.js";
import type { ModelRequestDependencies } from "../model/invocation-context.js";
import type { SessionId, ToolCallId, TurnId } from "./shared.js";
import type { TraceContext } from "../tracing/tracer.js";

export interface SubagentRunRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  agentType: string;
  description: string;
  prompt: string;
  callerCanReadOutputFile?: boolean;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export interface SubagentRunOptions {
  signal?: AbortSignal;
  /** 未显式选模的 child 从父 Agent Loop 继承的不可变 Model。 */
  model?: Model;
  /** Core Server 对前台 child 的最高优先级 Selection；每个 child 仍自行创建 Model。 */
  modelOverride?: {
    selection: ModelSelection;
    requestDependencies?: ModelRequestDependencies;
    background: "deny";
  };
  /**
   * 调用级（一次 Agent 调用）的子代理选型：`Agent` 的 `model` 经 `resolveInput` 归一后的规范形。
   *
   * **只活一次**：由 handler 放进本次 launch options，绝不回写 Settings / profile / turn 状态。
   * 解析顺序见 `core/src/runtime/helpers/subagent-selection.ts`：
   * `modelOverride(turn) > 调用级 > profile > 父模型`。
   *
   * 只有前台 `run` 通道携带它：后台 `start` 与 SendMessage 复活都没有选型通道（见 runner.launch
   * 的注释），这是记录在案的不对称，不要让描述假装一致。**显式继承不属于这个不对称**——见
   * {@link callModelInherit}。
   */
  callModelSelection?: ModelSelection;
  /**
   * 调用级「显式继承」：本次 spawn **忽略该类型 profile 的模型**，跑父会话当前模型
   * （`Agent.model = null`，设置页那个「继承」选项的等价物）。
   *
   * 与 {@link callModelSelection} 互斥（handler 二选一），但**优先级不同于它**：这是一个
   * 「不要用 profile 的选择」的开关，不是一个模型引用，所以
   * 1. 不需要模型目录（宿主没有 catalog 时同样成立）；
   * 2. 后台 `start` 通道也携带它——继承不是选型，无需 Model 实例或 request dependencies。
   *    「让这一发跟着会话走」在默认（后台）派发下必须真的生效，否则模型只能靠 `wait: true`
   *    兜住，那就是一条没人看得见的静默失败。
   */
  callModelInherit?: true;
}

export interface SubagentLaunchRequest extends SubagentRunRequest {
  /**
   * 只有显式 true 才前台同步等待子代理完成；缺省走后台启动（派发即句柄，立即返回句柄）。
   * profile 显式声明 background 时仍会后台——分叉判据只在 runner 的 launch 里维护。
   */
  wait?: boolean;
}

export type SubagentLaunchOptions = SubagentRunOptions;

export type SubagentStartRequest = SubagentRunRequest;

export interface SubagentStartOptions {
  signal?: AbortSignal;
  /** 后台 child 启动时继承的普通 Model；临时 turn 模型仍禁止进入后台。 */
  model?: Model;
  /**
   * 调用级「显式继承」（{@link SubagentRunOptions.callModelInherit}）的后台通道。
   *
   * 后台不接 `callModelSelection`（选型需要 Model 实例与 request dependencies），但继承只需要
   * 一句「别用 profile 的模型」，所以它在这里也有通道——否则模型照用户的话要求继承，默认的
   * 后台派发却跑回设置页那个模型。
   */
  callModelInherit?: true;
}

export interface SubagentWaitOptions {
  signal?: AbortSignal;
}

export interface SubagentStopOptions {
  signal?: AbortSignal;
}

export interface SubagentSendMessageRequest {
  sessionId: SessionId;
  turnId?: TurnId;
  parentToolCallId: ToolCallId | string;
  to: string;
  summary: string;
  message: string;
  workingDirectory: string;
  workspaceRoot: string;
  trace: TraceContext;
}

export interface SubagentSendMessageOptions {
  signal?: AbortSignal;
}

export type SubagentSendMessageDelivery = "queued" | "steered" | "resumed_background";

export interface SubagentSendMessageResult {
  status: "success" | "failed";
  messageId: string;
  delivery?: SubagentSendMessageDelivery;
  message?: string;
  error?: string;
  agentId?: string;
  taskId?: string;
  outputFile?: string;
}

export type SubagentTaskStatus =
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "killed"
  | "stopped"
  | "lost"
  // 宿主进程在它运行期间死亡（崩溃/重启），由下次接管会话时的孤儿对账落定：这一轮没有任何
  // 结果，且不会再变。它与 `lost` 是同一情形的两个阶段——`lost` 是尚未被认领的形态。
  | "interrupted";

export interface SubagentTaskSnapshot {
  taskId: string;
  agentId: string;
  agentType: string;
  description: string;
  status: SubagentTaskStatus;
  startedAt: Date;
  completedAt?: Date;
  childSessionId?: SessionId;
  parentToolCallId?: ToolCallId | string;
  pid?: number;
  error?: string;
  output?: AgentOutput;
  outputFile?: string;
  notified?: boolean;
}

export interface SubagentPort {
  launch(request: SubagentLaunchRequest, options?: SubagentLaunchOptions): Promise<AgentOutput>;
  run(request: SubagentRunRequest, options?: SubagentRunOptions): Promise<AgentOutput>;
  start?(
    request: SubagentStartRequest,
    options?: SubagentStartOptions,
  ): Promise<AgentBackgroundedOutput>;
  backgroundTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  getTask?(taskId: string): Promise<SubagentTaskSnapshot | undefined>;
  waitForTask?(
    taskId: string,
    options?: SubagentWaitOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  stopTask?(
    taskId: string,
    options?: SubagentStopOptions,
  ): Promise<SubagentTaskSnapshot | undefined>;
  sendMessage?(
    request: SubagentSendMessageRequest,
    options?: SubagentSendMessageOptions,
  ): Promise<SubagentSendMessageResult>;
}
