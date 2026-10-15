import { createMessageId, HookEventName, traceContextToLogContext } from "../deps.js";
import type { MessageId, TraceContext } from "../deps.js";
import type { BackgroundResultOriginMeta } from "@zcode/contracts";
import {
  createRuntimeCommandId,
  type RuntimeCommand,
  type TaskNotificationRuntimeCommand,
} from "../command-queue.js";
import { runtimeInputMetadata } from "../../agent/runtime-input-presentation.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SealBackgroundTaskNotificationsInput } from "../types.js";
import { shouldSuppressSealedSubagentBashNotification } from "../../runtime-task/notification-policy.js";
import { isTerminalRuntimeTask, isTerminalRuntimeTaskStatus } from "../../runtime-task/registry.js";

export function enqueueBackgroundTaskNotification(
  this: AgentRuntimeInternal,
  notification: {
    originMeta?: BackgroundResultOriginMeta;
    taskId?: string;
    /** 宣告时任务的 registry 状态；仅终态通知的生产者设置（spec background-notification-supersession.md D1）。 */
    announcedTaskStatus?: string;
    text: string;
    toolName?: string;
    traceContext: TraceContext;
  },
): void {
  if (this.shuttingDown) {
    // 防御直接调用路径：session teardown 期间只允许任务状态收口，不能再启动模型轮次。
    this.logger?.info?.("Dropped background task notification during runtime shutdown", {
      ...traceContextToLogContext(notification.traceContext),
      event: "runtime.background_task_notification.shutdown_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
      toolName: notification.toolName,
    });
    return;
  }
  const task = notification.taskId ? this.runtimeTaskRegistry.get(notification.taskId) : undefined;
  const branchGeneration = task?.branchGeneration ?? this.branchGeneration;
  if (branchGeneration !== this.branchGeneration) {
    this.logger?.debug("Dropped stale-branch background task notification", {
      ...traceContextToLogContext(notification.traceContext),
      branchGeneration,
      currentBranchGeneration: this.branchGeneration,
      event: "runtime.background_task_notification.stale_branch_dropped",
      module: "core.runtime",
      taskId: notification.taskId,
    });
    return;
  }
  const commandId = createRuntimeCommandId();
  this.enqueueRuntimeCommand({
    branchGeneration,
    createdAt: new Date(),
    id: commandId,
    mode: "task-notification",
    priority: "next",
    source: "background_task",
    originMeta: notification.originMeta,
    taskId: notification.taskId,
    ...(notification.announcedTaskStatus === undefined
      ? {}
      : { announcedTaskStatus: notification.announcedTaskStatus }),
    text: notification.text,
    toolName: notification.toolName,
    traceContext: notification.traceContext,
  });
  // Notification hook（P3）：后台任务通知入队成功后触发，供外部系统联动。
  // 通知文本与入队载荷同源；hook 的 additionalContext 只注入消息历史，不改变入队结果。
  void this.runNotificationHooks(
    {
      notification: notification.text,
      notificationType: "background_task",
    },
    notification.traceContext,
  )
    .then((result) => {
      this.injectHookAdditionalContextIntoMessageHistory(
        HookEventName.Notification,
        result.additionalContexts,
      );
    })
    .catch((error) => {
      this.logger?.warn("Notification hook failed", {
        ...traceContextToLogContext(notification.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "hook.notification.failed",
        module: "core.runtime",
        notificationType: "background_task",
      });
    });
  // wake 入账本（admitted）。runtime 命令队列是纯内存的，账本是唯一
  // durable 痕迹——崩溃重启后后台子进程已死、通知不可恢复，resume 会把残留
  // admitted 收口为 discarded(session_resumed)（留痕不静默，同一语义）。
  const admission = this.sessionStore?.saveSessionInput?.({
    id: String(commandId),
    sessionID: this.sessionId,
    kind: "backgroundNotification",
    delivery: "queue",
    payload: {
      text: notification.text,
      ...(notification.taskId ? { taskId: notification.taskId } : {}),
      ...(notification.originMeta ? { originMeta: notification.originMeta } : {}),
    },
  });
  if (admission) {
    void this.trackResidencyBlockingWork(admission).catch((error) => {
      this.logger?.warn("Failed to admit background notification to ledger", {
        ...traceContextToLogContext(notification.traceContext),
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "session_input.admit_failed",
        module: "core.runtime",
        status: "failed",
      });
    });
  }
}

export function sealBackgroundTaskNotifications(
  this: AgentRuntimeInternal,
  input: SealBackgroundTaskNotificationsInput,
): void {
  if (this.config.taskType !== "subagent_child") return;
  this.backgroundTaskNotificationsSealed = true;
  this.backgroundTaskNotificationSealReason = input.reason;
  this.logger?.info?.("Subagent runtime background task notifications sealed", {
    ...traceContextToLogContext(input.traceContext ?? this.rootTraceContext),
    event: "runtime.background_task_notifications.sealed",
    module: "core.runtime",
    reason: input.reason,
  });
}

export async function persistBackgroundTaskNotificationCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): Promise<MessageId> {
  const persisted = await persistBackgroundTaskNotificationBatch.call(this, [command], true);
  return persisted.messageId;
}

export interface PersistedBackgroundTaskNotificationBatch {
  /** 仅整批来源一致时存在；混合/缺失来源不能从代表任务推断。 */
  backgroundSource?: BackgroundResultOriginMeta["backgroundSource"];
  messageId: MessageId;
  originMeta?: BackgroundResultOriginMeta;
  text: string;
}

const MAX_BACKGROUND_RESULT_TITLES = 3;

function resolveBackgroundTaskNotificationSource(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta["backgroundSource"] | undefined {
  const source = commands[0].originMeta?.backgroundSource;
  if (!source || commands.some((command) => command.originMeta?.backgroundSource !== source)) {
    // 展示 metadata 只保留代表任务，不能把首项来源当作整批因果来源；
    // 混合或缺失来源留空，避免 notification 到达顺序改变 message_source。
    return undefined;
  }
  return source;
}

export function resolveBackgroundTaskNotificationOriginMeta(
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
): BackgroundResultOriginMeta | undefined {
  // 单条：originMeta 整体透传，workflowNotification 载荷免费搭车（manifest 渲染的唯一数据源）。
  if (commands.length === 1) return commands[0].originMeta;

  const originMetas: BackgroundResultOriginMeta[] = [];
  for (const command of commands) {
    const originMeta = command.originMeta;
    if (!originMeta?.workId.trim() || !originMeta.title.trim()) return undefined;
    originMetas.push(originMeta);
  }

  const representative = originMetas[0];
  if (!representative) return undefined;
  const visibleTitles = originMetas
    .slice(0, MAX_BACKGROUND_RESULT_TITLES)
    .map((originMeta) => originMeta.title.trim());
  const remainingCount = originMetas.length - visibleTitles.length;
  const title = [...visibleTitles, ...(remainingCount > 0 ? [`+${remainingCount}`] : [])].join(
    " · ",
  );

  // 多 notification 共用一个 turn 后若直接丢弃 originMeta，后台结果会退化为
  // 普通 assistant 渲染。这里复用首个任务的展示锚点并只合成 title，不引入 batch schema。
  //
  // workflowNotification 载荷**刻意不合成**：manifest 是「一轮 ↔ 一张」的对应，批量下这条关系不成立——谎报第一条的
  // 载荷比整轮退化成裸标题行更坏。只保留 {backgroundSource, title, workId} 三个基字段，
  // 整轮据此退回现状标题行。
  return {
    backgroundSource: representative.backgroundSource,
    title,
    workId: representative.workId,
  };
}

export async function persistBackgroundTaskNotificationBatch(
  this: AgentRuntimeInternal,
  commands: readonly [TaskNotificationRuntimeCommand, ...TaskNotificationRuntimeCommand[]],
  midTurn = false,
): Promise<PersistedBackgroundTaskNotificationBatch> {
  const firstCommand = commands[0];
  const backgroundSource = resolveBackgroundTaskNotificationSource(commands);
  const originMeta = resolveBackgroundTaskNotificationOriginMeta(commands);
  const text = commands.map((command) => command.text).join("\n\n");
  await this.ensureContextInitialized(firstCommand.traceContext);
  const messageID = createMessageId();
  const inputPresentation = midTurn ? "task_notification_steer" : "task_notification";
  this.messageHistory.addUser(text, runtimeInputMetadata(inputPresentation));
  await this.persistSyntheticUserNoticeForSession({
    messageID,
    metadata: {
      inputPresentation,
      ...(originMeta ? { originMeta } : {}),
      visibility: "model-only",
    },
    sessionId: this.sessionId,
    source: "background_task",
    text,
    traceContext: firstCommand.traceContext,
    visibility: "model-only",
  });
  // outer drain 过去逐条持久化并逐条启动模型轮，pending 数量会线性放大
  // request 数。整批只写一条 synthetic message，同时仍逐项结算 ledger 身份。
  for (const command of commands) {
    await this.sessionStore
      ?.markSessionInputPromoted?.({
        id: String(command.id),
        sessionID: this.sessionId,
        promotedMessageID: messageID,
      })
      .catch((error) => {
        this.logger?.warn("Failed to mark background notification promoted", {
          ...traceContextToLogContext(command.traceContext),
          commandId: command.id,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "session_input.promote_mark_failed",
          module: "core.runtime",
          status: "failed",
        });
      });
  }
  return {
    ...(backgroundSource ? { backgroundSource } : {}),
    messageId: messageID,
    ...(originMeta ? { originMeta } : {}),
    text,
  };
}

export function shouldSuppressTaskNotificationRuntimeCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): boolean {
  const registryTask = command.taskId ? this.runtimeTaskRegistry.get(command.taskId) : undefined;
  if (
    !shouldSuppressSealedSubagentBashNotification({
      isSubagentChildRuntime: this.config.taskType === "subagent_child",
      notificationSealed: this.backgroundTaskNotificationsSealed,
      registryTask,
      toolName: command.toolName,
    })
  ) {
    return false;
  }

  this.logger?.info?.("Suppressed sealed subagent background Bash notification", {
    ...traceContextToLogContext(command.traceContext),
    commandId: command.id,
    event: "runtime.background_task_notification.suppressed",
    module: "core.runtime",
    reason: this.backgroundTaskNotificationSealReason,
    taskId: command.taskId,
    toolName: command.toolName,
  });
  return true;
}

/**
 * 投递时按 registry 消解过期终态通知（spec `background-notification-supersession.md` D2）。
 *
 * 终态通知是 `finalize` 那一刻冻结的快照。同一 taskId 被复活（SendMessage resume /
 * input revival）或重臂后，registry 条目重新变为非终态——旧快照不再代表当前状态，
 * 而新生命会在自己的终态再发一条通知（两条复活路径都会把条目的 `notified` 重置为
 * false）。父代理读到过期失败就会习惯性重开一个重复子代理，这正是要消灭的窗口。
 *
 * 只在「宣告终态 ∧ 当前非终态」时返回 true：
 * - 未宣告状态（workflow stall/escalation/hole 等进度通知）永不消解；
 * - registry 条目缺席（终态驱逐 / 跨进程重启）不猜，保留原文投递——与
 *   `background-stop-registry-authority.md`「投影兜底」同一原则。
 */
export function isSupersededTaskNotificationRuntimeCommand(
  this: AgentRuntimeInternal,
  command: TaskNotificationRuntimeCommand,
): boolean {
  if (!command.taskId || command.announcedTaskStatus === undefined) return false;
  if (!isTerminalRuntimeTaskStatus(command.announcedTaskStatus)) return false;
  const current = this.runtimeTaskRegistry.get(command.taskId);
  if (!current) return false;
  return !isTerminalRuntimeTask(current);
}

/**
 * 宣告终态的快照通知（taskId + 终态 announcedTaskStatus）。只有它们参与
 * 消解与批内归一——workflow 的 stall/escalation/hole 等进度通知没有宣告状态，
 * 同一 run 的多条进度是各自独立的事实，全部投递。
 */
/** taskId 必填的终态快照通知：参与消解与批内归一的最小形状。 */
type TerminalAnnouncedTaskNotification = TaskNotificationRuntimeCommand & {
  readonly taskId: string;
};

function isTerminalAnnouncedTaskNotification(
  command: RuntimeCommand,
): command is TerminalAnnouncedTaskNotification {
  return (
    command.mode === "task-notification" &&
    command.taskId !== undefined &&
    command.announcedTaskStatus !== undefined &&
    isTerminalRuntimeTaskStatus(command.announcedTaskStatus)
  );
}

/**
 * drain 出口共享的过滤器：mid-turn steer 注入与 idle 唤醒批次必须同一套规则，
 * 否则同一队列在两个出口会给出不同的父代理视图。两条规则：
 * 1. 消解过期终态通知（{@link isSupersededTaskNotificationRuntimeCommand}）；
 * 2. 同一 taskId 的终态快照在批内只保留最新一条——「失败 → 复活 → 完成」
 *    两次快照都投递，父代理仍会按先读到的过期失败决策。
 */
export function selectDeliverableTaskNotifications<T extends RuntimeCommand>(
  this: AgentRuntimeInternal,
  commands: readonly T[],
): readonly T[] {
  const latestIndexByTaskId = new Map<string, number>();
  commands.forEach((command, index) => {
    if (!isTerminalAnnouncedTaskNotification(command)) return;
    if (isSupersededTaskNotificationRuntimeCommand.call(this, command)) return;
    latestIndexByTaskId.set(command.taskId, index);
  });
  return commands.filter((command, index) => {
    if (!isTerminalAnnouncedTaskNotification(command)) return true;
    return latestIndexByTaskId.get(command.taskId) === index;
  });
}
