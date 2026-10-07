import type { SessionId } from "@zcode/contracts";

import type { AgentRuntime } from "../runtime/agent-runtime.js";
import type { AgentRuntimeConfig, AgentRuntimeDeps } from "../runtime/types.js";

/**
 * 子代理子会话的构造移交契约（spec `subagent-session-as-first-class.md` D1 / S1b）。
 *
 * 一条子会话需要两半事实，分别只有一边拿得到：
 *
 * - **只有 core 拿得到**：派发那一刻的父语境快照（模式、模型选型、工具面、persona、动态工作流
 *   灰度门），以及一批**父 runtime 的活对象**（父已授予的权限服务、profile 过滤后的 skill 端口、
 *   借用父启动快照的 MCP 端口、镜像回父时间线的 eventSink、绑定本次调用的 modelFactory 等）。
 *   这些 reinstate 不出来，只能由 core 交出来。
 * - **只有 bootstrap 拿得到**：把「它是一条正式会话」这句话落实——record 进 `context.sessions`、
 *   常驻/回收、协议与 UI 可见、输入准入、起始偏好继承。
 *
 * 所以不是「core 交出构造权」，而是 core 产出本文件定义的**进程内入参**（`bundle`），
 * bootstrap 的会话构造入口以受限模式消费它，返回一个已登记的 runtime（`host`）。
 *
 * 与 `launch-spec.ts` 的分工：那份是**持久**的（跨进程冷恢复用，只存推导不出来的身份事实）；
 * 这份是**瞬态**的（同进程派发用，携带活端口对象），不落库、不序列化、不跨进程。
 */

/** 子会话 runtime 配置里由 core 覆盖的键：父语境的实时快照。 */
export type SubagentChildRuntimeConfigOverrides = Pick<
  AgentRuntimeConfig,
  | "agentName"
  | "bashShellSelection"
  | "bashTimeoutPolicy"
  | "currentDate"
  | "dynamicWorkflowEnabled"
  | "embeddedSearchBackend"
  | "envInfo"
  | "maxTurns"
  | "mcp"
  | "midConversationSystem"
  | "mode"
  | "modelContextBudgetStrategy"
  | "modelSelection"
  | "modelStreaming"
  | "nativeSearchEnhancementsEnabled"
  | "parentSessionId"
  | "planEnabled"
  | "subagentContext"
  | "subagents"
  | "taskType"
  | "toolAllowlist"
  | "toolDisallowlist"
  | "toolset"
  | "workingDirectory"
>;

/**
 * 由 core 提供的父作用域端口。键名与 `AgentRuntimeDeps` 同名（所以 bootstrap 直接展开即可），
 * 但**逐个列出**而不是 `Pick` 一部分：这份清单本身就是契约，漏一个就是子会话行为静默变化。
 *
 * 类型写法 `AgentRuntimeDeps["k"]` 保留该键的可选性（值可能为 undefined），但要求字段**存在**：
 * 目的是让 core 必须显式回答「这一项子会话有没有」，而不是靠忘写来缺席。
 */
export interface SubagentChildCoreDeps {
  /** 父会话的遥测端口：子 span 以真实父子 span（前台）或 link（后台）归因到父。 */
  agentTelemetry: AgentRuntimeDeps["agentTelemetry"];
  /** 父的 span 因果关系快照，只在派发时取一次。 */
  agentTelemetryCausation: AgentRuntimeDeps["agentTelemetryCausation"];
  /** 前台子会话用 `child`，后台子会话晚于父轮结束，只能用 `linked_root`。 */
  agentTelemetryCausationMode: AgentRuntimeDeps["agentTelemetryCausationMode"];
  /** 镜像回父时间线的 sink：子事件先按 childSessionId 落库，再通知父的外部 sinks。 */
  eventSink: AgentRuntimeDeps["eventSink"];
  /** explore 用独立只读权限配置；general-purpose 与自定义 agent 继承父实例。 */
  permissionService: AgentRuntimeDeps["permissionService"];
  /** 父改写后的阻塞交互 broker：permission / AskUserQuestion 一律路由回父 session。 */
  permissionBroker: AgentRuntimeDeps["permissionBroker"];
  /** 同上，provider runtime headers 也必须按父 session 取派生实例。 */
  providerRuntimeHeadersPort: AgentRuntimeDeps["providerRuntimeHeadersPort"];
  /** 子会话向父会话回话的端口（`enqueue` 绑父的 enqueueSubagentMessage）。 */
  coordinatorResponsePort: AgentRuntimeDeps["coordinatorResponsePort"];
  /** 父 skillPort 的 profile 过滤包装；重建会绕过白名单与 CUA 策略。 */
  skillPort: AgentRuntimeDeps["skillPort"];
  /** 借用父启动快照的 MCP 访问；重建会开第二份 MCP 连接。 */
  mcpPort: AgentRuntimeDeps["mcpPort"];
  /** 绑定本次调用选型的继承工厂；缓存可变 Registry 视图，不能跨调用复用。 */
  modelFactory: AgentRuntimeDeps["modelFactory"];
  /** 父的防环链快照：spawn 时取一次，否则「父收信 → 派子代理回信」会从头重新开链。 */
  initialSessionMessageChain: AgentRuntimeDeps["initialSessionMessageChain"];
  /** 父继承的模型请求准入端口：子请求同样要喂治理器信号。 */
  modelRequestAdmission: AgentRuntimeDeps["modelRequestAdmission"];
  /** 父 profile / workspace 解析出的持久记忆根。 */
  memoryRoot: AgentRuntimeDeps["memoryRoot"];
  /** 父已解析的选型解析器；子会话不得各自冻结一份。 */
  resolveEffectiveModelSelection: AgentRuntimeDeps["resolveEffectiveModelSelection"];
  /** 父的工具调度器；缺席即用 core 默认。 */
  toolScheduler: AgentRuntimeDeps["toolScheduler"];
  /** 派发轮的 trace 上下文。 */
  traceContext: AgentRuntimeDeps["traceContext"];
}

/** core 派发子会话时交给构造入口的全部事实。 */
export interface SubagentChildLaunchBundle {
  /** 父会话 id（子会话 `parentSessionId` 的来源，也是 broker 回路由的依据）。 */
  parentSessionId: SessionId;
  /** runner 在派发前铸好的子会话 id。 */
  childSessionId: SessionId;
  /** 交给 Agent 工具的类型名（`explore` / `general-purpose` / 自定义 profile 名）。 */
  agentType: string;
  /** Agent 工具调用里的任务描述（子会话初始标题与父时间线摘要用）。 */
  description: string;
  /** 是否后台派发（决定遥测归因模式与生命周期 hook 载荷）。 */
  background: boolean;
  /** 复用已存在的子会话（不重写 launch spec、不重复写模型选择）。 */
  resume: boolean;
  /** 子会话 runtime 配置覆盖，与持久 launch spec 的字段语义保持一致。 */
  runtimeConfig: SubagentChildRuntimeConfigOverrides;
  /** 父作用域端口。 */
  deps: SubagentChildCoreDeps;
}

/**
 * bootstrap 会话构造入口的受限模式实现：创建子会话 record、登记进 `context.sessions`，
 * 返回可直接跑首轮的 runtime。
 *
 * 由谁在何时调用：core 的 Agent 工具派发路径（`runtime/methods/subagent.ts`）。父 record 缺席、
 * 或父 App 未借出装配事实时**抛错**——派发不允许退化成「跑一个没有 record 的子会话」。
 */
export interface SubagentChildSessionHost {
  createChildSession(bundle: SubagentChildLaunchBundle): Promise<AgentRuntime>;
}
