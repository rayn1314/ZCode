import { restorePermissionGrantMarker } from "../helpers/permission-grant-resume.js";
import { executionStateSchema, resolveExecutionState } from "@zcode/shared";
import { SESSION_ENTRY_EXECUTION_STATE } from "@zcode/contracts";
import {
  CoreErrorType,
  HookEventName,
  SessionEventType,
  createCoreError,
  traceContextToLogContext,
  formatGoalStateForModel,
  activeSessionMessages,
  hydrateReadFileStateFromSession,
  hydrateMessageHistoryFromSession,
  MessageHistoryImpl,
} from "../deps.js";
import type {
  EnvInfo,
  MessageWithParts,
  SessionEvent,
  SessionGoal,
  SessionInfo,
  SessionTitleSource,
  TodoItem,
  TraceContext,
  TurnId,
  TurnState,
  ToolSchedule,
} from "../deps.js";
import { getLatestActiveSessionMessageId } from "../helpers/index.js";
import type { ResumeSessionOptions, ResumeSessionResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  announceSessionShellEnvironmentNoticeAfterResume,
  getSessionShellSelection,
  restoreSessionShellEnvironmentSelectionForResume,
} from "./session-shell-environment.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import { restoreDynamicWorkflowActivationOnResume } from "./dynamic-workflow-activation.js";
import { reconcileOrphanedSubagentLifecycles } from "./subagent-lifecycle-reconciliation.js";
import { readLifecycleData } from "./subagent-lifecycle-persistence.js";
import { SESSION_ENTRY_SUBAGENT_LIFECYCLE } from "../deps.js";
import { repairPersistedRemoteSessionPaths } from "../helpers/persisted-remote-session-path-repair.js";
import {
  restoreWorkspaceCheckpointEntries,
  restoreWorkspaceFileRewindEntries,
} from "./workspace-checkpoint-persistence.js";
import { mainTurnCacheHitAggregateFromMessages } from "./turn-model-step-usage.js";

export function toScheduleState(
  this: AgentRuntimeInternal,
  schedule: ToolSchedule,
): TurnState["scheduledTools"] {
  return {
    items: schedule.items.map((item) => ({
      toolCallId: item.toolCallId,
      dependencies: item.dependencies,
      canRunParallel: item.canRunParallel,
    })),
    parallelGroups: schedule.parallelGroups,
    executionOrder: schedule.executionOrder,
  };
}

export async function resumeFromStore(
  this: AgentRuntimeInternal,
  options?: ResumeSessionOptions,
): Promise<ResumeSessionResult> {
  if (!this.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "Cannot resume session without a session store",
      { recoverable: false },
    );
  }

  const traceContext = options?.traceContext ?? this.rootTraceContext;
  const persistedSession = await this.sessionStore.getSession(this.sessionId);
  // 删除 = CLI 软删除（time_deleted）。归档已归 Host 组织态，CLI 不再有归档列；
  // 旧的 time.archived 判断永远为 false，这里改为拒绝恢复已软删除的会话。
  if (!persistedSession || persistedSession.time.deleted !== undefined) {
    throw createCoreError(CoreErrorType.SessionNotFound, `Session not found: ${this.sessionId}`, {
      context: { sessionId: this.sessionId },
      recoverable: true,
    });
  }
  const session = await repairPersistedRemoteSessionPaths(this.sessionStore, persistedSession, {
    onPersistenceFailure: (error) => {
      this.logger?.warn("Session path repair persistence failed; using in-memory repair", {
        ...traceContextToLogContext(traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session.path_repair.persist_failed",
        module: "core.runtime",
        sessionId: this.sessionId,
      });
    },
  });

  const messages =
    options?.persistedMessages ??
    (await this.sessionStore.messages({
      sessionID: this.sessionId,
    }));
  const rewindTargetMessageId = session.revert?.targetMessageID;
  const rewindCreatedMessageId = session.revert?.createdMessageID;
  const rewindKeptMessageIds = session.revert?.keptMessageIDs;
  const branchCutAfterMessageId = session.revert?.branchCutAfterMessageID;
  this.branchGeneration = session.revert?.branchGeneration ?? 0;
  this.runtimeTaskRegistry.setActiveBranchGeneration?.(this.branchGeneration);
  if (messages.length === 0) {
    this.logger?.warn("Session resume loaded zero persisted messages", {
      ...traceContextToLogContext(traceContext),
      directory: session.directory,
      event: "session.resume.persisted_messages_zero",
      module: "core.runtime",
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }
  const persistedEnvInfo = extractPersistedEnvInfo(messages);
  if (persistedEnvInfo) {
    this.config.envInfo = persistedEnvInfo;
  }
  const shellRestore = await restoreSessionShellEnvironmentSelectionForResume(this, {
    currentSelection: getSessionShellSelection(this),
    traceContext,
  });

  this.workingDirectory = session.directory;
  this.config.taskType = session.taskType;
  if (this.config.memory) {
    // Memory root 必须使用会话落盘时的 workspace identity，不能沿用进程启动 workspace。
    this.config.memory.workspaceIdentity = session.workspaceID
      ? String(session.workspaceID)
      : undefined;
  }
  resetProjectMemoryRecall(this);
  this.messageHistory = new MessageHistoryImpl();
  this.contextBuilder = null;
  this.contextInitialized = false;
  this.lastEmittedLocalDate = undefined;
  // cold resume 的历史 hydration 会先清空 runtime-local read-state；必须在
  // Context 初始化前完成，确保随后单次加载的 MEMORY.md 状态与 provider 所见内容一致。
  const readFileStateHydration = await hydrateReadFileStateFromSession({
    branchCutAfterMessageId,
    messages,
    readFileState: this.readFileState,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
    workingDirectory: this.workingDirectory,
    workspaceRoot: this.workspaceRoot,
  });
  await this.ensureContextInitialized(traceContext);
  const recoveredCompactTimelineCount = await this.recoverInterruptedCompactTimelines(
    messages,
    traceContext,
  );
  // 冷接管时认领上一个进程丢下的子代理孤儿（spec subagent-lifecycle-orphan-reconciliation.md）：
  // 进程异常退出不会给正在跑的子代理任何结算机会，那类行会永久停在「只有 spawn」并被 roster
  // 报成 lost。这里把它落定成 interrupted，条数随 SessionResumed 事件一并留痕。
  const reconciledOrphanCount = await reconcileOrphanedSubagentLifecycles.call(this, traceContext);
  const hydration = await hydrateMessageHistoryFromSession({
    logger: this.logger,
    artifactStore: this.artifactStore,
    branchCutAfterMessageId,
    history: this.messageHistory,
    messages,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
    // 中断的 Agent 派发要把句柄写回模型面，否则父代理读历史时只剩「重开」一个选项，
    // 已花的 token 与已产出的工作全部作废（spec `subagent-continuation-copy.md` D4c）。
    subagentHandles: await buildSubagentHandleTable.call(this),
  });
  announceSessionShellEnvironmentNoticeAfterResume(this, {
    persistedEnvInfo,
    restore: shellRestore,
  });
  const activeMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  // compact preserved segment 会把 compact 前消息插回 provider 上下文，
  // 但它不是 compact 后时间线的 latest anchor，不能用于后续 compact parentID。
  const timelineActiveMessages = activeSessionMessages(messages, {
    branchCutAfterMessageId,
    includeCompactPreservedSegment: false,
    rewindCreatedMessageId,
    rewindKeptMessageIds,
    rewindTargetMessageId,
  });
  const latestAssistant = [...timelineActiveMessages]
    .reverse()
    .find((message) => message.info.role === "assistant");
  this.latestConversationMessageId = getLatestActiveSessionMessageId(timelineActiveMessages);
  this.latestAssistantMessageId = latestAssistant?.info.id;
  this.latestAssistantTurnId = latestAssistant?.info.anchor?.turnId as TurnId | undefined;
  this.lastAssistantCompletedAtMs =
    latestAssistant && "completed" in latestAssistant.info.time
      ? latestAssistant.info.time.completed
      : undefined;

  await restoreWorkspaceCheckpointEntries(this, traceContext);
  await restoreWorkspaceFileRewindEntries(this, traceContext);
  const restoredEvents = await this.eventStore.getEvents(this.sessionId);
  const restoredModeEvents = restoredEvents.filter(
    (event) =>
      event.type === SessionEventType.SessionCreated ||
      event.type === SessionEventType.SessionModeChanged,
  );
  const restoredMode =
    restoredModeEvents.length > 0 ? this.eventReducer.reduce(restoredModeEvents).mode : undefined;
  const resolvedMode = options?.modeOverride ?? restoredMode ?? session.permission?.mode;
  if (resolvedMode !== undefined) {
    // cold resume 会先把 checkpoint/rewind 等局部事件恢复到新的内存 eventStore。
    // 这些事件不携带 mode，若仅按“存在任意事件”reduce，会用默认 build 覆盖 headless yolo。
    // 只有权威 mode 事件能恢复历史值；本次 invocation 的显式/default mode 仍保持最高优先级。
    Object.assign(this.config, resolveExecutionState({ mode: resolvedMode }));
  }
  // 会话自己的新记录优先于项目偏好；旧记录仅兼容读取，不批量回填。
  const executionEntries = await this.sessionStore.sessionEntries?.({
    sessionID: this.sessionId,
    type: SESSION_ENTRY_EXECUTION_STATE,
  });
  const savedExecution = executionStateSchema.safeParse(executionEntries?.at(-1)?.data);
  if (savedExecution.success && options?.modeOverride === undefined) {
    Object.assign(this.config, savedExecution.data);
  }
  // onDemand 会话的工具面随记录恢复（launch.md「On demand: activation」）：entry 在场，或历史里
  // 有过 `/workflow` / 十个工具的调用。要在首轮之前完成，所以放在 resume 里而不是等下一次 turn。
  await restoreDynamicWorkflowActivationOnResume.call(this, messages);

  await restorePermissionGrantMarker(this, traceContext);

  this.mainTurnCacheHitAggregate = mainTurnCacheHitAggregateFromMessages({
    activeMessages,
    persistedMessages: messages,
  });
  this.turnNumber = activeMessages.filter(
    (message) => message.info.role === "user" && !message.info.summary,
  ).length;
  this.sessionPersisted = true;
  await syncPersistedSessionTitleForResume.call(this, {
    restoredEvents,
    session,
    traceContext,
  });
  await this.discardPersistedPendingSteerInputs(traceContext);
  const recoveredSteerInputCount = 0;
  const resumedTodos = await this.readSessionTodosForContext(traceContext);
  const resumedTarget = await this.readSessionTargetForContext(traceContext);
  this.injectTargetStateIntoMessageHistory(resumedTarget);

  const resumedEvent = this.createEvent(
    SessionEventType.SessionResumed,
    {
      directory: session.directory,
      interruptedToolCount: hydration.interruptedToolCount,
      messageCount: hydration.messageCount,
      partCount: hydration.partCount,
      recoveredCompactTimelineCount,
      reconciledOrphanCount,
      recoveredSteerInputCount,
      resumedTodoCount: resumedTodos.length,
      resumedTarget: resumedTarget?.status,
    },
    traceContext,
  );
  await this.appendEvent(resumedEvent, traceContext);
  const sessionStartHookResult = await this.runSessionStartHooks(
    "resume",
    traceContext,
    options?.abortSignal,
  );
  this.injectHookAdditionalContextIntoMessageHistory(
    HookEventName.SessionStart,
    sessionStartHookResult.additionalContexts,
  );

  if (messages.length > 0 && activeMessages.length === 0) {
    this.logger?.warn("Session resume produced zero active messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      appliedMessageCount: hydration.appliedMessageCount,
      directory: session.directory,
      event: "session.resume.active_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      sessionId: this.sessionId,
      rewindTargetMessageId,
    });
  }
  if (activeMessages.length > 0 && hydration.appliedMessageCount === 0) {
    this.logger?.warn("Session resume applied zero history messages", {
      ...traceContextToLogContext(traceContext),
      activeMessageCount: activeMessages.length,
      directory: session.directory,
      event: "session.resume.applied_messages_zero",
      hydrationMessageCount: hydration.messageCount,
      module: "core.runtime",
      persistedMessageCount: messages.length,
      recoveredCompactTimelineCount,
      rewindCreatedMessageId,
      rewindKeptMessageCount: rewindKeptMessageIds?.length ?? 0,
      rewindTargetMessageId,
      sessionId: this.sessionId,
    });
  }

  this.logger?.info("Session resumed", {
    ...traceContextToLogContext(traceContext),
    appliedMessageCount: hydration.appliedMessageCount,
    directory: session.directory,
    event: "session.resumed",
    interruptedToolCount: hydration.interruptedToolCount,
    messageCount: hydration.messageCount,
    module: "core.runtime",
    partCount: hydration.partCount,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedRangeReadCount: readFileStateHydration.skippedRangeReadCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    recoveredCompactTimelineCount,
    resumedTodoCount: resumedTodos.length,
    resumedTargetStatus: resumedTarget?.status,
    sessionId: this.sessionId,
    status: "completed",
  });

  return {
    ...hydration,
    directory: session.directory,
    // 中断 compact 恢复会写回 timeline part；bootstrap 不能继续把恢复前
    // messages 交给 V4，否则首帧会短暂复活 started/retrying 状态。
    persistedMessagesReloadRequired: recoveredCompactTimelineCount > 0,
    readFileStateRestoredCount: readFileStateHydration.restoredCount,
    readFileStateSkippedRangeReadCount: readFileStateHydration.skippedRangeReadCount,
    readFileStateSkippedUnreadableEditCount: readFileStateHydration.skippedUnreadableEditCount,
    traceId: traceContext.traceId,
  };
}

async function syncPersistedSessionTitleForResume(
  this: AgentRuntimeInternal,
  input: {
    restoredEvents: SessionEvent[];
    session: SessionInfo;
    traceContext: TraceContext;
  },
): Promise<void> {
  const title = input.session.title.trim();
  if (!title) return;
  const source = input.session.titleSource ?? "generated";
  if (hasRestoredTitleEvent(input.restoredEvents, title, source)) return;

  // fork child 创建时 title 已写进 sessionStore，但复制历史不会复制父会话的
  // SessionTitleUpdated 事件。v4 live 投影只消费事件流，缺这条事件就会把列表标题降级成"新任务"。
  await this.appendEvent(
    this.createEvent(
      SessionEventType.SessionTitleUpdated,
      {
        previousTitle: "",
        source,
        title,
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

function hasRestoredTitleEvent(
  events: readonly SessionEvent[],
  title: string,
  source: SessionTitleSource,
): boolean {
  return events.some((event) => {
    if (event.type !== SessionEventType.SessionTitleUpdated) return false;
    const payload = event.payload as { source?: unknown; title?: unknown };
    return payload.title === title && payload.source === source;
  });
}

function extractPersistedEnvInfo(messages: MessageWithParts[]): EnvInfo | undefined {
  for (const message of messages) {
    if (message.info.role !== "user") {
      continue;
    }

    const envInfo = message.info.contextSnapshot?.envInfo;
    if (envInfo) {
      return envInfo;
    }
  }

  return undefined;
}

export async function readSessionTodosForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<TodoItem[]> {
  if (!this.sessionStore) {
    return [];
  }

  try {
    return await this.sessionStore.readTodos({ sessionID: this.sessionId });
  } catch (error) {
    // Todo state is continuity context. If the store cannot read it, resume/compact can still
    // proceed from transcript history while surfacing the degradation in structured logs.
    this.logger?.warn("Failed to read session todos for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "todo.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return [];
  }
}

export async function readSessionTargetForContext(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore) {
    return null;
  }

  try {
    return await this.sessionStore.readTarget({ sessionID: this.sessionId });
  } catch (error) {
    // Goal state is continuity context. Resume should still work from transcript history
    // if goal storage is temporarily unavailable.
    this.logger?.warn("Failed to read session goal for context", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.context.read.failed",
      module: "core.runtime",
      status: "failed",
    });
    return null;
  }
}

export function injectTargetStateIntoMessageHistory(
  this: AgentRuntimeInternal,
  target: SessionGoal | null,
): void {
  const targetState = formatGoalStateForModel(target);
  if (!targetState) {
    return;
  }

  this.messageHistory.addAttachment(
    "resume_goal_state",
    [
      "The current session goal state was restored from session storage.",
      targetState,
      "Use it as the authoritative long-running objective unless a later GoalRead result or runtime goal event updates it.",
      "Do not mark the goal complete unless real evidence shows the objective has been achieved.",
      "A completed plan, todo list, checklist, or planning phase is not completion evidence unless the objective was only to produce that artifact.",
    ].join("\n"),
  );
}

/**
 * 父侧工具调用 id → agentId 的句柄表，供 hydration 把「中断的 Agent 派发」对回具体子代理
 * （spec `subagent-continuation-copy.md` D4c）。
 *
 * 读侧只有一处：`runtime/subagent_lifecycle` entry 经 `readLifecycleData` 解析（孤儿对账与
 * roster 投影共用同一函数，不为这里再写一份字段判读）。缺 `parentToolCallId` 的行跳过——
 * 那是 spawn 早于本字段存在的旧数据，硬猜一个键只会让 hydration 查不到、白绕一圈。
 *
 * 失败只降级返回空表：句柄是「把已知事实递给模型」的优化，不是恢复的前提；读存储失败时
 *  hydration 退回泛化中断文案（既有行为），会话本身必须能恢复。
 */
async function buildSubagentHandleTable(
  this: AgentRuntimeInternal,
): Promise<Map<string, string> | undefined> {
  const store = this.sessionStore;
  const sessionEntries = store?.sessionEntries;
  if (!store || !sessionEntries) return undefined;

  let entries;
  try {
    // 保留接收者再调用：`SqliteSessionStore.sessionEntries` 是原型方法，解构后裸调用会丢 `this`。
    entries = await sessionEntries.call(store, {
      sessionID: this.sessionId,
      type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    });
  } catch (error) {
    this.logger?.warn("Failed to read subagent lifecycle entries for resume handles", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.handle_table.read_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "failed",
    });
    return undefined;
  }

  const handles = new Map<string, string>();
  for (const entry of entries) {
    const facts = readLifecycleData(entry);
    if (!facts?.parentToolCallId) continue;
    handles.set(facts.parentToolCallId, facts.agentId);
  }
  return handles.size > 0 ? handles : undefined;
}
