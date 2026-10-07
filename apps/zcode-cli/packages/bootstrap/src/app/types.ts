import type { ZCodeToolExecResource, BackgroundBashOutputResult } from "@zcode/shared";
import type { AiSdkModelAdapter } from "@zcode/adapters/model";
import type {
  AgentRuntime,
  AgentRuntimeCompactionPolicyPatch,
  AgentRuntimeConfig,
  ExecuteTurnOptions,
  ExpertWorkflowCommandResult,
  ProviderRuntimeHeadersPort,
  PresentationSurface,
  ResumeSessionResult,
  StartSavedWorkflowRunResult,
  AmendWorkflowRunSettingsInput,
  AmendWorkflowRunSettingsResult,
  TurnAttachment,
  ModelExecutionContext,
  TurnResult,
  WorkflowAgentRunner,
  WorkspaceCheckpointSummary,
  WorkspaceForkResult,
  WorkspaceGenerateTextInput,
  WorkspaceHookReviewTarget,
  WorkspaceHookPolicyProvider,
  SubagentChildSessionHost,
} from "@zcode/core";
import type { GuidePendingInputResult } from "@zcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookTrustRevokeTarget,
} from "@zcode/shared/zcode-protocol-v4";
import type { ZCodeModelOption } from "@zcode/shared";
import type { EffectiveModelSelectionResult } from "@zcode/shared/model-selection";
export type { ZCodeModelOption } from "@zcode/shared";
import type { ModelProviderSourceTitle } from "../model-config.js";
import type { ZCodeAppStartupInputs } from "./startup-inputs.js";
import type { SubagentChildAppScope, SubagentChildBorrowedPorts } from "./subagent-child-scope.js";
import type { ZCodeInstalledPluginData } from "../plugins.js";
import type {
  AutomationPort,
  OffPeakPort,
  BackgroundTaskCancelResult,
  CollaborationMode,
  ContextSourcePort,
  DynamicWorkflowRunArtifact,
  DynamicWorkflowRunArtifactBytes,
  DynamicWorkflowRunArtifactItem,
  DynamicWorkflowRunWorkspaceNode,
  DynamicWorkflowRunWorkspaceNodeResult,
  DynamicWorkflowRunEvent,
  DynamicWorkflowRunResumeResult,
  DynamicWorkflowRunProgressPayload,
  DynamicWorkflowRunSessionSummary,
  ExecutionPort,
  BrowserControlPort,
  FileSystemPort,
  GoalStatus,
  HttpClientPort,
  ImageProcessorPort,
  PdfDocumentPort,
  InputDelivery,
  InputHistoryEntry,
  InputHistoryKind,
  InputHistoryStorePort,
  LoggerFactory,
  McpPort,
  McpServerStatus,
  ModelSelection,
  PermissionBrokerPort,
  PluginLoadOutcome,
  PluginMetadata,
  PluginReferenceCatalog,
  SessionEvent,
  SessionEventSink,
  SessionEventStorePort,
  SessionGoal,
  SessionId,
  SessionMailboxPort,
  SessionMessagePort,
  SessionStorePort,
  SkillLoadOutcome,
  SkillPort,
  SubagentRosterPort,
  ToolArtifactReadResult,
  ToolArtifactStorePort,
  TodoItem,
  QueryId,
  TraceContext,
  TurnId,
  TurnSteerResult,
  TurnInputIntentMetadata,
  MessageWithParts,
  ModelUsage,
  ModelToolCall,
  SupportedLocale,
  UiLocale,
  UiThemePreference,
  WorkflowEvent,
  WorkflowRunListItem,
  ExecutionShellSelection,
} from "@zcode/contracts";
import type { NodeReplBrowserBroker } from "./node-repl-browser-broker.js";
import type { SessionTranscriptMessage } from "../session-transcript.js";
import type { WorkspaceHookReviewCommandResult } from "./workspace-hook-review-controller.js";
import type { AgentTelemetryRuntimeOwner, WorkspaceHookPolicy } from "@zcode/contracts";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";

export interface WorkspaceHookReviewHostContext {
  taskId: string;
  runId: string;
  workspaceLabel: string;
  remoteSessionId?: string;
}

export type RespondWorkspaceHookReviewInput = WorkspaceHookReviewTarget & {
  decision: WorkspaceHookReviewDecision;
};

export type ToggleWorkspaceHookReviewItemInput = WorkspaceHookReviewTarget & {
  reviewItemId: string;
  enabled: boolean;
};

export type RevokeWorkspaceHookTrustInput =
  | (WorkspaceHookReviewTarget & { reviewItemIds: string[] })
  | WorkspaceHookTrustRevokeTarget;

/** 新 Session 可使用 Environment 默认选择；恢复 Session 允许保持未绑定，不补默认模型。 */
export type ZCodeAppRuntimeConfigInput = AgentRuntimeConfig;

export interface ZCodeAppOptions {
  sessionId?: SessionId;
  resume?: boolean;
  version?: string;
  traceContext?: TraceContext;
  runtimeConfig?: ZCodeAppRuntimeConfigInput;
  /**
   * 父已解析的启动输入（配置 / 插件 / agent profile / 内置技能包）。
   *
   * 只有**子代理子会话**会传它：那次 App 创建复用父会话同一份磁盘解析结果，不重复做四项
   * 解析（含同步插件发现）。正常会话不传，`createZCodeApp` 自己按当前磁盘现状解析一次。
   * 语义与边界见 `startup-inputs.ts` 文件头。
   */
  startupInputs?: ZCodeAppStartupInputs;
  /**
   * 子代理子会话的构造移交端口（spec `subagent-session-as-first-class.md` D1 / S1b）。
   *
   * 父会话装配时注入它，core 的 Agent 工具据此**经构造入口**创建子会话；子会话自己的 App
   * 不注入（D8 禁止套娃，配置侧也已写死 `subagents.enabled: false`）。
   */
  subagentChildHost?: SubagentChildSessionHost;
  /**
   * 子会话 App 的构造入参：core 的覆盖包 ＋ 父借出的装配事实。
   *
   * **在场即进入子会话受限模式**：不建第二份模型适配器 / MCP / skill / context source /
   * 动态工作流引擎与浏览器 broker，改从覆盖包取父作用域端口、从借出事实取父的适配器实例。
   * 逐项差异见 spec 的 S1b 差异清单；正常会话不传。
   */
  subagentChildScope?: SubagentChildAppScope;
  /**
   * stdio 协议模式的 agent 进程由 Electron host 拉起，模型服务需要看到 electron 来源。
   * 普通 CLI 不传，继续使用 cli 默认值。
   */
  sourceTitle?: ModelProviderSourceTitle;
  eventStore?: SessionEventStorePort;
  sessionStore?: SessionStorePort;
  sessionMailboxPort?: SessionMailboxPort;
  /**
   * 跨会话投递端口（bootstrap 实现）。协议服务器按 workspace 注入进程级同一实例；
   * core 只依赖端口做 `sess_*` 寻址的 SendMessage，缺席即能力缺席。
   */
  sessionMessagePort?: SessionMessagePort;
  /**
   * 历史子代理只读端口（spec D8）。协议服务器按进程级同一实例注入；
   * ListAgents 用它补齐重启后为空的注册表，缺席只报注册表、不报能力缺失。
   */
  subagentRosterPort?: SubagentRosterPort;
  inputHistoryStore?: InputHistoryStorePort;
  modelAdapter?: AiSdkModelAdapter;
  /** Worker 进程拥有的 Registry；App 只借用，不负责释放。 */
  providerRegistry: ProviderRegistryModelSource;
  resolveEffectiveModelSelection?: (selection: ModelSelection) => EffectiveModelSelectionResult;
  /** 新 Session 使用的 Environment 默认选择；仅在没有显式 runtime modelSelection 时参与初始化。 */
  configuredDefaultModelSelection?: ModelSelection;
  modelIoFullRetentionEnabled?: boolean;
  /** 同进程嵌入宿主可注入完整的 borrowed 进程级 Owner；Endpoint 配置不得覆盖它。 */
  telemetryOwner?: AgentTelemetryRuntimeOwner;
  /**
   * provider runtime headers 端口：主 runtime 每次调用报自己的会话；child runtime 一律向父
   * runtime 取派生实例。
   */
  providerRuntimeHeadersPort?: ProviderRuntimeHeadersPort;
  loggerFactory?: LoggerFactory;
  officialPluginRoots?: string[];
  pluginStorageRoot?: string;
  executionPort?: ExecutionPort;
  /** 资源遥测旁路；由协议宿主注入，主任务和 workflow 的执行适配器共用。 */
  onToolExecResource?: (sample: ZCodeToolExecResource) => void;
  /** browser-use 控制端口；注入后 node_repl 的 agent.browsers.* 可用。缺省则不可用。 */
  browserControlPort?: BrowserControlPort;
  /** 可由协议宿主注入的进程级 node_repl Browser broker；缺省时 app 自建并拥有。 */
  nodeReplBrowserBroker?: NodeReplBrowserBroker;
  fileSystemPort?: FileSystemPort;
  httpClientPort?: HttpClientPort;
  imageProcessorPort?: ImageProcessorPort;
  pdfDocumentPort?: PdfDocumentPort;
  artifactStore?: ToolArtifactStorePort;
  contextSourcePort?: ContextSourcePort;
  skillPort?: SkillPort;
  mcpPort?: McpPort;
  /** 由宿主提供 per-app lease；产出的端口归 app 所有。 */
  mcpPortFactory?: (input: { workingDirectory?: string }) => McpPort;
  permissionBroker?: PermissionBrokerPort;
  eventSink?: SessionEventSink;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform | string;
  projectConfigPath?: string;
  skipUserConfig?: boolean;
  userConfigPath?: string;
  uiDetectedLocale?: string | null;
  uiLocale?: UiLocale;
  onWorkflowEvent?: (event: WorkflowEvent) => void | Promise<void>;
  automationPort?: AutomationPort;
  offPeakPort?: OffPeakPort;
  /** 首次真实用户执行或 cold-resume fallback 时解析一次，之后由 app 生命周期缓存。 */
  resolveInitialBashShellSelection?: () => Promise<ExecutionShellSelection | undefined>;
  /** Trusted embedder policy; workspace/project files cannot populate this field. */
  workspaceHookPolicy?: WorkspaceHookPolicy;
  /** Protocol Host-owned provider shared by session Runtime and no-session Settings pretrust. */
  workspaceHookPolicyProvider?: WorkspaceHookPolicyProvider;
  /** Rollout gate; false keeps project Hooks hard-blocked and does not read Trust records. */
  workspaceHookTrustEnabled?: boolean;
  /** Presence means this owner Host supports the dedicated Workspace Hook review route. */
  workspaceHookReviewHost?: WorkspaceHookReviewHostContext;
}

export interface SubmitPromptOptionsBase {
  traceContext?: TraceContext;
  abortSignal?: AbortSignal;
  inputId?: string;
  queryId?: QueryId;
  intent?: TurnInputIntentMetadata;
  sharedContextRefs?: TurnInputIntentMetadata["sharedContextRefs"];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** 内部 admission 观察点：只表示 runtime sink 看见 TurnStarted，不代表 projection 已 apply。 */
  onTurnStartedObserved?: (event: SessionEvent) => void;
  /** 仅当前 turn 从 provider 工具列表移除；不会永久改变 session runtime。 */
  toolDisallowlist?: readonly string[];
  /** App 只读提供的 provider-only IAB 环境状态，不进入 UI transcript。 */
  browserAmbientContext?: ExecuteTurnOptions["browserAmbientContext"];
  /** 标准 Selection 的单次执行约束；不进入 Session Selection 或持久化。 */
  modelExecution?: ModelExecutionContext;
}

export type SubmitPromptOptions = SubmitPromptOptionsBase &
  import("@zcode/contracts").TurnBackgroundAttribution;

export type PrepareUserExecutionBoundary = (
  options?: Pick<SubmitPromptOptions, "abortSignal" | "traceContext">,
) => Promise<void>;

export interface SteerTurnOptions {
  inputId?: string;
  queryId?: QueryId;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
  /** 投递语义：queue=消费时切新轮；guide=内联当前轮。缺省 queue。 */
  delivery?: "guide" | "queue";
  intent?: TurnInputIntentMetadata;
  attachments?: TurnAttachment[];
  /** 当前 queued/guide 输入消费时不向 provider 暴露的工具名。 */
  toolDisallowlist?: readonly string[];
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  traceContext?: TraceContext;
}

export type SendInputOptions = SubmitPromptOptions & {
  inputId?: string;
  /** 可信消费入口确定的呈现标记；不改变原始用户内容或调度语义。 */
  inputPresentation?: ExecuteTurnOptions["inputPresentation"];
  delivery?: InputDelivery;
  /** sendText 的产品 guide/queue 意图；是否 busy 仍由 Core admission 判断。 */
  queueDelivery?: "guide" | "queue";
  requireIdle?: boolean;
  expectedTurnId?: TurnId;
  commandKind?: "sendText" | "sendGoalCommand" | "compact";
};

export interface UserPromptInput {
  text: string;
  attachments?: TurnAttachment[];
}

export type PromptInput = string | UserPromptInput;

export type SendInputResult =
  | {
      /** Core 已完成 admission；completion 只供生命周期清理，不是 ACK 等待边界。 */
      completion: Promise<TurnResult>;
      kind: "started_turn";
      turnId: TurnId;
    }
  | TurnSteerResult;

export interface ResumeOptions {
  abortSignal?: AbortSignal;
  traceContext?: TraceContext;
  onEvent?: (event: SessionEvent) => void | Promise<void>;
  /** 同一次冷恢复的调用级已物化结果；不进入 app 生命周期缓存。compact 修补后须按返回值刷新。 */
  persistedMessages?: MessageWithParts[];
}

export interface ZCodePluginSetResult {
  enabled: boolean;
  path: string;
  plugin: PluginMetadata;
}

export interface ZCodePluginUninstallResult {
  // null 表示该 plugin id 当前未安装（幂等 no-op），调用方据此提示"未安装"。
  removed: ZCodeInstalledPluginData | null;
}

export interface SetLocaleResult {
  configPath: string;
  locale: SupportedLocale;
  previousLocale: SupportedLocale;
  requestedLocale: UiLocale;
  traceId: TraceContext["traceId"];
}

export interface ZCodeApp {
  readonly sessionId: SessionId;
  readonly traceId: string;
  readonly runtime: AgentRuntime;
  /**
   * 本会话借给子会话的装配事实（spec D1 / S1b）。构造入口据此为子会话进入受限模式。
   *
   * 只有能派发子代理的会话提供；子会话的 App **不提供**（D8 禁止套娃）。缺席即该 App 不支持
   * 派生子会话——子代理派发因此会明确失败，不会退化成「跑一个没有 record 的子会话」。
   */
  readonly subagentChildBorrow?: SubagentChildBorrowedPorts;
  respondWorkspaceHookReview(
    input: RespondWorkspaceHookReviewInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  toggleWorkspaceHookReviewItem(
    input: ToggleWorkspaceHookReviewItemInput,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: unknown }>;
  revokeWorkspaceHookTrust(
    input: RevokeWorkspaceHookTrustInput,
  ): Promise<WorkspaceHookReviewCommandResult>;
  /** 软门禁:按需开审核 flow,无 pending 项时为安全 no-op */
  requestWorkspaceHookReview(input: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult>;
  /**
   * Trust store 落盘后本 session 的 coordinator
   * 内存镜像不会自动更新（per-session，仅创建时 load 一次）。Settings 无 task 的
   * pretrust 授权成功后，server 会按 workspace 逐个调用本方法，把文件重载进
   * coordinator 并重发 admission 状态，否则已信任 Hook 继续被拒、banner 不刷新。
   */
  reloadWorkspaceHookTrust(): Promise<void>;
  close?(): Promise<void>;
  getMode(): CollaborationMode;
  getModel(): string;
  /** current-only 协议快照精确读取当前 Registry 模型，避免枚举整个目录。 */
  getCurrentModelOption?(): ZCodeModelOption | undefined;
  /** 只读 Registry 元数据；不要求选项完整，也不绑定执行模型。 */
  getModelOption?(selection: ModelSelection): ZCodeModelOption | undefined;
  getLocale(): SupportedLocale;
  getTheme(): UiThemePreference;
  getDefaultThoughtLevel(): string | undefined;
  getThoughtLevel(): string | undefined;
  loadSessionTranscript(): Promise<SessionTranscriptMessage[]>;
  readSubagents(input?: {
    endedCursor?: string;
    endedLimit?: number;
  }): Promise<import("@zcode/shared").ZCodeSessionSubagentsResult>;
  readSubagentTranscript(
    childSessionId: string,
  ): Promise<import("./subagent-observation.js").SubagentTranscriptSnapshot>;
  readTodos(): Promise<TodoItem[]>;
  readTarget(): Promise<SessionGoal | null>;
  setCustomSessionTitle(input: { title: string; traceContext?: TraceContext }): Promise<void>;
  readToolResultArtifact(uri: string): Promise<ToolArtifactReadResult>;
  /** chunk transaction commit 后把完整二进制原子寄存到 session artifact store。 */
  writePromptAttachment(input: {
    fileName: string;
    mime: string;
    bytes: Uint8Array;
  }): Promise<{ ref: string }>;
  /** 已发送 image/video 预览：在拥有 session 的 runtime 内读取 artifact 或实际路径。 */
  readPromptAttachment(input: {
    ref: string;
    mime: string;
    maxBytes: number;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ bytes: Uint8Array; mediaType: string }>;
  /** Share 选择阶段只读 userInput 附件元数据；不读取完整内容。 */
  statPromptAttachment?(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ totalBytes: number; mediaType: string; mtimeMs?: number }>;
  /** Desktop local 已发送视频：解析 artifact-first 本地播放源；否则保持分片读取。 */
  resolvePromptAttachmentPreviewSource(input: {
    ref: string;
    mime: string;
    messageId?: string;
    attachmentIndex?: number;
  }): Promise<{ kind: "local_path"; path: string; mediaType: string } | { kind: "chunked" }>;
  setTarget(input: {
    objective: string;
    /** 用户提交的原始 goal 命令；target 仍只存 objective，聊天行按该文本展示。 */
    displayText?: string;
    status?: GoalStatus;
    tokenBudget?: number | null;
    intent?: TurnInputIntentMetadata;
  }): Promise<SessionGoal>;
  updateTargetStatus(status: GoalStatus): Promise<SessionGoal | null>;
  clearTarget(): Promise<boolean>;
  continueActiveTarget(options?: SubmitPromptOptions): Promise<TurnResult | null>;
  recordInputHistory(
    input: PromptInput,
    kind?: InputHistoryKind,
  ): Promise<InputHistoryEntry | null>;
  recallPreviousInputHistory(skip?: number): Promise<InputHistoryEntry | null>;
  listModels(): ZCodeModelOption[];
  listThoughtLevels(): string[];
  listPlugins(): Promise<PluginLoadOutcome>;
  setPluginEnabled(plugin: string, enabled: boolean): Promise<ZCodePluginSetResult>;
  uninstallPlugin(plugin: string): Promise<ZCodePluginUninstallResult>;
  /**
   * Session 冻结的 Plugin 身份 catalog。
   * 在 App 创建时由 resolveStartupPlugins 结果构建一次，之后只读；
   * `plugins/referenceCatalog` 带 sessionId 时以此为 session authority。
   */
  getPluginReferenceCatalog(): PluginReferenceCatalog;
  /** 当前 Session 的 AgentRuntime Skill 发现快照；冷恢复重建 runtime 后重新发现。 */
  getSkillCatalog(): Promise<SkillLoadOutcome>;
  listMcpServers(): Promise<Record<string, McpServerStatus>>;
  connectMcpServer(name: string): Promise<McpServerStatus>;
  readBackgroundBashOutput(workId: string, sessionId?: string): Promise<BackgroundBashOutputResult>;
  cancelBackgroundTask?(
    taskId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<BackgroundTaskCancelResult>;
  /**
   * workflow run 的事件日志分页（详情页审计面）。可选能力：dwf journal 不可用时 run service
   * 整个不构造，此方法随之缺席，网关据此回结构化的能力不支持错误而不是空页——
   * 「没有事件」与「这个会话没有这个能力」是两件事。
   *
   * cursor = journal sequence（`appendEvent` 单调分配），与 workflowRuns[].lastEventSequence
   * 同一把尺；越界 cursor 返回空页而不报错。
   */
  listDynamicWorkflowRunEvents?(input: {
    runId: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<DynamicWorkflowRunEvent[]>;
  /**
   * 恢复一个 dwf run。可选能力，缺席条件同
   * {@link listDynamicWorkflowRunEvents}。成功路径除了 port.resume 之外还负责**追踪重臂**
   * （runtime.trackResumedDynamicWorkflowRun）：漏掉它，恢复的 run 不可取消、完成通知丢失、
   * 会话被回收护栏当成空闲。失败以结构化 reason 返回（不是 throw）——五种原因全是调用方
   * 可预期的业务分支。
   */
  resumeWorkflowRun?(input: {
    workId: string;
    name?: string;
  }): Promise<DynamicWorkflowRunResumeResult>;
  /**
   * 中枢直接启动一个已保存的工作流。GUI 在目标项目里建一个
   * 空会话后向它发 `startSavedWorkflow`：agent 解析 saved 来源 + 校验实参 + 编译，干净则以一条
   * controlOnly「启动轮」把用户的真实动作落进会话并 `port.submit` 启动 run（不经模型回合、不弹
   * `CreateWorkflow` 确认窗——用户在中枢里的点击就是同意）。可选能力，缺席条件同
   * {@link resumeWorkflowRun}（无 dwf 端口即不注册；网关回能力不支持错误）。失败以结构化 `reason`
   * 返回（不是 throw）——六种原因全是调用方可预期的业务分支，`message` 携带人可读诊断供实参窗行内展示；
   * ①② 阶段失败在**任何持久化之前**（无 run、无消息、无事件、无任务），GUI 据此 `deleteSession`
   * 收回空会话，转写里只出现真正启动了的 run。
   */
  startSavedWorkflow?(input: {
    name: string;
    scope?: "project" | "global";
    args?: Record<string, unknown>;
  }): Promise<StartSavedWorkflowRunResult>;
  /**
   * GUI「配置」改一个 run 的子代理模型与并发上界：以同一份脚本修订出新 run，不经模型轮、不开确认窗。可选能力：端口
   * 缺席、或端口不带 `amend` / `getScript` 时不注册（网关回能力不支持错误）。失败以结构化 `reason`
   * 返回——每一种都发生在停下或新建任何东西之前。
   */
  amendWorkflowRunSettings?(
    input: Omit<AmendWorkflowRunSettingsInput, "traceContext">,
  ): Promise<AmendWorkflowRunSettingsResult>;
  /**
   * workflow run 的枚举面（重启后的发现查询）。可选能力，缺席条件同
   * {@link listDynamicWorkflowRunEvents}；journal 无枚举窄查询时回空列表（诚实答案——
   * 内存 journal 的 run 本就不会活过进程）。`resumable` 按 resume 门的同一个谓词算好。
   */
  listDynamicWorkflowRuns?(input: { limit?: number }): Promise<DynamicWorkflowRunSessionSummary[]>;
  /**
   * workflow run 的冷回放：本会话名下、`excludeRunIds`
   * 之外的 run 从 journal 回放成进度事件载荷，冷物化把它们当内存事件喂给同一个 reducer——
   * `workflowRuns` 投影因此在重启前后一致。可选能力，缺席条件同 {@link listDynamicWorkflowRuns}。
   */
  replayDynamicWorkflowRuns?(input: {
    excludeRunIds: ReadonlySet<string>;
  }): Promise<DynamicWorkflowRunProgressPayload[]>;
  /**
   * workflow run 的**用户面产物**读面。三条能力
   * 一起注册、一起缺席：它们是同一个 journal 读面的三个切片，部分在场只会让 UI 拿到一张
   * 有卡片却打不开的侧板。缺席条件同 {@link listDynamicWorkflowRunEvents}，另加端口的三个
   * 可选成员必须都在。
   *
   * ⚠ 术语：这里的 artifact 是脚本经 `artifact.*` 发布给**用户**看的产出，不是引擎内部对
   * 「脚本顶层返回值」的同名叫法。
   *
   * 未知 runId 回 `undefined`（网关归一成 not found）；零件的 run 回空数组。
   */
  listDynamicWorkflowRunArtifacts?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunArtifact[] | undefined>;
  /**
   * 喂给某个预置看板的 `report` 条目分页（cursor = journal sequence，严格大于）。
   * `limit` 由网关钳好再传下来，这里**精确**兑现——调用方传「上限 + 1」探测 hasMore。
   * 缺席条件同 {@link listDynamicWorkflowRunArtifacts}。
   */
  listDynamicWorkflowRunArtifactItems?(input: {
    runId: string;
    artifactId: string;
    afterSequence?: number;
    limit: number;
  }): Promise<readonly DynamicWorkflowRunArtifactItem[]>;
  /**
   * 读一个产物版本的**全部**字节；分块归网关（≤ 512 KiB 一块）。授权链在端口实现侧：
   * 该 run 必须属于本会话 ∧ journal 里有 `(artifactId, version)` 的 completed 行，然后才拿
   * **行上的** uri 去 store 读——调用方传来的任何 id 绝不直接成为路径。
   * 无此版本 / 预置看板（没有字节）/ store 缺席都回 `undefined`。
   * 缺席条件同 {@link listDynamicWorkflowRunArtifacts}。
   */
  readDynamicWorkflowRunArtifact?(input: {
    runId: string;
    artifactId: string;
    version: number;
  }): Promise<DynamicWorkflowRunArtifactBytes | undefined>;
  /**
   * workflow run 的工作区 transcript：`files.*` /
   * `git.*` / `world.run` 的 journal 行，两条一起注册、一起缺席（清单 + 一个节点的有界正文）。
   * 授权在端口实现侧（run 必须属于本会话）；不是你的 run / 未知 run 都回 `undefined`。
   * 缺席条件同 {@link listDynamicWorkflowRunArtifacts}。
   */
  listDynamicWorkflowRunWorkspaceNodes?(input: {
    runId: string;
  }): Promise<readonly DynamicWorkflowRunWorkspaceNode[] | undefined>;
  readDynamicWorkflowRunNodeResult?(input: {
    runId: string;
    siteId: string;
    ordinal: number;
    maxBytes: number;
  }): Promise<DynamicWorkflowRunWorkspaceNodeResult | undefined>;
  disconnectMcpServer(name: string): Promise<McpServerStatus | undefined>;
  listCheckpoints(options?: { limit?: number }): Promise<WorkspaceCheckpointSummary[]>;
  forkFromCheckpoint(options?: {
    targetCheckpointId?: string;
    targetMessageId?: string;
    traceContext?: TraceContext;
  }): Promise<WorkspaceForkResult>;
  generateWorkspaceText(
    input: WorkspaceGenerateTextInput,
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<{
    text: string;
    selection: WorkspaceGenerateTextInput["selection"];
    finishReason: string;
    usage?: ModelUsage;
    toolCalls?: ModelToolCall[];
  }>;
  testModelConnectivity(
    input: { selection: ModelSelection },
    options?: { abortSignal?: AbortSignal; traceContext?: TraceContext },
  ): Promise<void>;
  expertWorkflowStatus(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  workflowStatus?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  validateWorkflowScript?(input: { scriptPath: string }): Promise<ExpertWorkflowCommandResult>;
  runWorkflowScript?(
    input: { args?: unknown; resumeFromRunId?: string; scriptPath: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflowScript?(
    input: { runId: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  scriptWorkflowStatus?(options?: { runId?: string }): Promise<ExpertWorkflowCommandResult>;
  listScriptWorkflows?(options?: { limit?: number }): Promise<ExpertWorkflowCommandResult>;
  retryWorkflow?(options?: {
    abortSignal?: AbortSignal;
    activityId?: string;
    definitionId?: string;
    nodeId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    phase?: string;
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  listExpertWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  listWorkflows?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    limit?: number;
    workflowKind?: string;
  }): Promise<WorkflowRunListItem[]>;
  readExpertWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  readWorkflowEvents?(options: {
    abortSignal?: AbortSignal;
    limit?: number;
    runId: string;
  }): Promise<WorkflowEvent[]>;
  resume(options?: ResumeOptions): Promise<ResumeSessionResult>;
  resumeExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  resumeWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    onEvent?: SubmitPromptOptions["onEvent"];
    runId?: string;
    traceContext?: TraceContext;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  sendInput(input: PromptInput, options?: SendInputOptions): Promise<SendInputResult>;
  setMode(mode: CollaborationMode): Promise<{
    mode: CollaborationMode;
    previousMode: CollaborationMode;
    traceId: TraceContext["traceId"];
  }>;
  setModelIoFullRetentionEnabled?(enabled: boolean): void;
  /**
   * 热更新会话压缩策略（workspace/updateCompactionPreferences 逐个 session 调用）。
   * 只写用户可配置字段；窗口/输出预留由运行时按当前模型推导。
   */
  setCompactionPolicy?(policy: AgentRuntimeCompactionPolicyPatch): void;
  setModel(
    modelId: string | ModelSelection,
    options?: {
      /**
       * per-turn（off-peak idle plan）：true = 仅切运行态——不写磁盘模型选择、
       * 不产出 modelChange 聊天通知。用于 turn 级临时切换（应用/还原成对出现）。
       */
      transient?: boolean;
    },
  ): Promise<{
    model: string;
    previousModel: string;
    thoughtLevel?: string;
    traceId: TraceContext["traceId"];
  }>;
  setThoughtLevel(level: string): Promise<{
    previousThoughtLevel?: string;
    thoughtLevel: string;
    traceId: TraceContext["traceId"];
  }>;
  setLocale(locale: UiLocale): Promise<SetLocaleResult>;
  stopExpertWorkflow(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  stopWorkflow?(options?: {
    abortSignal?: AbortSignal;
    definitionId?: string;
    runId?: string;
    workflowKind?: string;
  }): Promise<ExpertWorkflowCommandResult>;
  runExpertWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflowBackground?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  /**
   * v4 deferred queue：busy 但没有 steerable active turn（compact / goal verifier /
   * goal continuation 边界）时，普通输入必须先落 TurnSteerQueued，不能因
   * runtime.steerTurn(no_active_turn/turn_not_steerable) 从 composer 消失。
   */
  enqueueDeferredInput?(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  steerTurn(input: string, options?: SteerTurnOptions): Promise<TurnSteerResult>;
  /** v4 queue 单项删除：按 pendingInputId 移除一条排队输入。返回是否命中。 */
  removeQueueItem(
    pendingInputId: string,
    options?: {
      reason?: "user_removed" | "promoted";
      reservationId?: string;
      traceContext?: TraceContext;
    },
  ): Promise<boolean>;
  /** sendQueuedNow 原子提升：reserve 后普通 drain/delete 不得消费该项。 */
  reserveQueueItem(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  markQueueItemPromoting(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  releaseQueueItemReservation(
    pendingInputId: string,
    reservationId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue 单项编辑：按 pendingInputId 替换排队输入文本（保位）。返回是否命中。 */
  editQueueItem(
    pendingInputId: string,
    newText: string,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 queue 单项引导：把排队项原地改投 guide 注入当前 turn（不打断）。 */
  guideQueueItem(
    pendingInputId: string,
    options?: { traceContext?: TraceContext },
  ): Promise<GuidePendingInputResult>;
  /** v4 queue 重排：移动 pendingInputId 到 beforePendingInputId 之前（null=队尾）。 */
  reorderQueueItem(
    pendingInputId: string,
    beforePendingInputId: string | null,
    options?: { traceContext?: TraceContext },
  ): Promise<boolean>;
  /** v4 heldQueueDisposition=clearQueueAndSend：清空全部排队输入，返回丢弃条数。 */
  clearQueueItems(options?: { traceContext?: TraceContext }): Promise<number>;
  /** v4 setAutoDrain：翻转 queue autoDrain 授权位（会话级配置）。 */
  setQueueAutoDrain(autoDrain: boolean, options?: { traceContext?: TraceContext }): Promise<void>;
  /** 暂停队列已由 CLI 外层消费到空：恢复 core 对后续 running queue 的行内 drain。 */
  completeExternalQueueDrain(): void;
  /** v4 setFollowupMode：翻转 followup 路由模式（queue/guide，会话级配置）。 */
  setFollowupMode(
    mode: "queue" | "guide",
    options?: { traceContext?: TraceContext },
  ): Promise<void>;
  runExpertWorkflow(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  runWorkflow?(
    input: { definitionId?: string; task: string; workflowKind?: string },
    options?: SubmitPromptOptions,
  ): Promise<ExpertWorkflowCommandResult>;
  submitPrompt(prompt: PromptInput, options?: SubmitPromptOptions): Promise<TurnResult>;
}

export interface ResolveLatestSessionOptions {
  directory: string;
  env?: NodeJS.ProcessEnv;
  sessionStore?: SessionStorePort;
}

export interface RunZCodeProtocolAgentOptions {
  /** 入口拥有退出时限；bootstrap 只编排取消和资源清理，不直接退出进程。 */
  lifecycle?: {
    readonly signal: AbortSignal;
    readonly deadlineAt: number | undefined;
    requestShutdown(error?: Error): void;
  };
  /** Desktop 内部命令：只运行原存储准备并退出。 */
  prepareStorageOnly?: boolean;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  presentationSurface?: PresentationSurface;
  version?: string;
}

export interface ListZCodeSessionsOptions {
  directory?: string;
  env?: NodeJS.ProcessEnv;
  limit?: number;
  sessionStore?: SessionStorePort;
}

export type { WorkflowAgentRunner };
