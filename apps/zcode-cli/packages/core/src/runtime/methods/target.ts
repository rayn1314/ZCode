import {
  CoreErrorType,
  GOAL_DEADLINE_APPROACHING_REMINDER_TEXT,
  GOAL_DEADLINE_REACHED_REMINDER_TEXT,
  SessionEventType,
  createChildTraceContext,
  createCoreError,
  decideGoalDeadline,
  formatGoalContinuationPrompt,
  shouldSendGoalDeadlineWarning,
  traceContextToLogContext,
} from "../deps.js";
import type {
  ModelUsageSummary,
  SessionGoal,
  TargetChangedPayload,
  TraceContext,
} from "../deps.js";
import type { TurnResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { createRuntimeCommandId } from "../command-queue.js";
import type {
  TargetContinuationRuntimeCommand,
  TargetContinuationRuntimeCommandOptions,
} from "../command-queue.js";
import { hasRunningBackgroundRuntimeTask } from "../../runtime-task/registry.js";
import { wrapSystemReminderForSource } from "../../system-reminder/source.js";
import { verifyActiveTargetCompletionForContinuation } from "./target-completion-verification.js";
import { enqueueCancellableRuntimeCommand } from "./runtime-command-submit.js";

export async function recordTargetChanged(
  this: AgentRuntimeInternal,
  input: TargetChangedPayload & { traceContext: TraceContext },
): Promise<void> {
  const { traceContext, ...payload } = input;
  const event = this.createEvent(SessionEventType.TargetChanged, payload, traceContext);
  await this.appendEvent(event, traceContext);
}

export async function continueActiveTargetIfIdle(
  this: AgentRuntimeInternal,
  options?: {
    traceContext?: TraceContext;
    abortSignal?: AbortSignal;
    inputId?: string;
    intent?: TargetContinuationRuntimeCommandOptions["intent"];
    verifyBeforeContinue?: boolean;
  },
): Promise<TurnResult | null> {
  const traceContext = options?.traceContext ?? this.rootTraceContext;

  return await enqueueCancellableRuntimeCommand<
    TurnResult | null,
    TargetContinuationRuntimeCommand
  >(this, {
    abortSignal: options?.abortSignal,
    createCommand: ({ reject, resolve }) => {
      const commandOptions: TargetContinuationRuntimeCommandOptions = {
        ...(options?.abortSignal ? { abortSignal: options.abortSignal } : {}),
        ...(options?.inputId !== undefined ? { inputId: options.inputId } : {}),
        ...(options?.intent ? { intent: options.intent } : {}),
        traceContext,
        ...(options?.verifyBeforeContinue !== undefined
          ? { verifyBeforeContinue: options.verifyBeforeContinue }
          : {}),
      };
      return {
        createdAt: new Date(),
        id: createRuntimeCommandId(),
        mode: "target-continuation",
        options: commandOptions,
        priority: "next",
        reject,
        resolve,
        traceContext,
      };
    },
  });
}

export async function executeTargetContinuationCommand(
  this: AgentRuntimeInternal,
  options: TargetContinuationRuntimeCommandOptions,
): Promise<TurnResult | null> {
  const traceContext = options.traceContext;
  // 到点裁决与续跑提示必须用同一个时刻：否则截止时间恰好落在校验器调用期间时，
  // 会出现「没收尾标志却写了收尾文案」的双重收尾窗口。
  const nowMs = Date.now();
  const target = await targetContinuationCandidateForCommand.call(this, traceContext);
  if (!target) return null;

  if (
    options.verifyBeforeContinue === true &&
    (await hasRunningBackgroundTaskForGoalContinuation.call(this))
  ) {
    this.logger?.info("Goal continuation deferred while background tasks are running", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.deferred_background_running",
      module: "core.runtime",
      status: "waiting",
      targetId: target.targetID,
    });
    return null;
  }

  // 到点后的这一轮是「收尾轮」：先把「已给过收尾轮」落库，再走校验与续跑。
  // 放在背景任务延后之后：被延后的续跑不该白白吃掉唯一一次收尾机会。
  // 放在校验器之前：校验器若判定已达成，目标直接置 complete（不消耗收尾语义）；
  // 若校验器自身失败（保守停止），收尾标志也已落地，下一轮检查会正常结算 deadline_reached，不会永久停在 active。
  await releaseDeadlineWrapUpTurnIfNeeded.call(this, target, traceContext, nowMs);

  const verificationResult = options.verifyBeforeContinue
    ? await verifyActiveTargetCompletionForContinuation.call(this, {
        abortSignal: options.abortSignal,
        target,
        traceContext,
      })
    : null;
  if (verificationResult?.verification.passed) {
    this.logger?.info("Goal continuation skipped after completion verifier passed", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.skipped_complete",
      module: "core.runtime",
      status: "completed",
      targetId: verificationResult.target.targetID,
    });
    return null;
  }
  // 没有 nextAction 的失败结果来自 verifier 自身失败或无效输出，
  // 不是模型确认的下一步工作；继续自动续跑会把内部错误变成无限目标迭代。
  if (verificationResult && !verificationResult.verification.nextAction?.trim()) {
    this.logger?.warn("Goal continuation skipped after verifier failed without next action", {
      ...traceContextToLogContext(traceContext),
      event: "target.continuation.skipped_no_next_action",
      module: "core.runtime",
      reason: verificationResult.verification.reason,
      targetId: verificationResult.target.targetID,
    });
    return null;
  }
  const latestTarget = await this.readSessionTargetForContext(traceContext);
  // 目标校验请求可能在用户点击 Stop 后才返回；队列会保持 stopRequested，
  // 但 verifier 拿到的是校验开始前的 active target。这里必须重读目标状态，避免用旧对象继续续跑。
  if (
    !latestTarget ||
    latestTarget.status !== "active" ||
    latestTarget.targetID !== target.targetID
  ) {
    this.logger?.info("Goal continuation skipped after target changed during verification", {
      ...traceContextToLogContext(traceContext),
      currentStatus: latestTarget?.status ?? "missing",
      currentTargetId: latestTarget?.targetID,
      event: "target.continuation.skipped_inactive_after_verification",
      module: "core.runtime",
      targetId: target.targetID,
    });
    return null;
  }
  const continuationTarget = latestTarget;
  const prompt = wrapSystemReminderForSource(
    "target_continuation",
    formatGoalContinuationPrompt(continuationTarget, verificationResult?.verification, nowMs),
  );
  const continuationTrace = createChildTraceContext(traceContext, {
    sessionId: this.sessionId,
    attributes: {
      targetId: continuationTarget.targetID,
      targetContinuation: true,
    },
  });

  this.logger?.info("Goal continuation started", {
    ...traceContextToLogContext(continuationTrace),
    event: "target.continuation.started",
    module: "core.runtime",
    status: "started",
    targetId: continuationTarget.targetID,
  });

  return await this.executeTurnCommand(prompt, undefined, {
    abortSignal: options.abortSignal,
    // session/send 期间触发的目标自动续跑仍属于同一次用户提交。
    // 若这里丢掉 inputId，最终 turn.completed 会回落到 runtime trace，
    // 桌面端 activeInputId 对不上后会一直停在 streaming/loading。
    inputId: options.inputId,
    intent: options.intent,
    inputSource: "goal-continuation",
    inputVisibility: "model-only",
    targetId: continuationTarget.targetID,
    traceContext: continuationTrace,
  });
}

export async function targetContinuationCandidate(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (this.hasActiveOrQueuedTurnWork()) return null;
  return await targetContinuationCandidateForCommand.call(this, traceContext);
}

async function targetContinuationCandidateForCommand(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore) return null;
  if (this.getPlanEnabled()) return null;
  if (this.activeTurn || this.activeTurnStartReservation) return null;
  if (!this.sessionPersisted) return null;

  const target = await this.readSessionTargetForContext(traceContext);
  if (!target || target.status !== "active") return null;

  // 到点裁决点之一。这里只做「不进候选」的判定与收尾后的结算；收尾轮的放行
  // 放在 executeTargetContinuationCommand（背景任务延后之后），以免被延后的一轮白白吃掉收尾机会。
  if (
    decideGoalDeadline({
      endAtMs: target.endAtMs,
      deadlineGraceUsed: target.deadlineGraceUsed,
      nowMs: Date.now(),
    }) === "settle"
  ) {
    await settleTargetDeadlineReached.call(this, target, traceContext);
    return null;
  }
  return target;
}

/**
 * 到点第一段：在真正放行这一轮之前，把「已给过收尾轮」持久化。
 * 落库失败只记日志：标记本身是幂等的一次写入，下一轮检查看到未标记会再试一次，
 * 最坏情况是多给一轮收尾，好过因为写库失败直接跳过硬停。
 */
async function releaseDeadlineWrapUpTurnIfNeeded(
  this: AgentRuntimeInternal,
  target: SessionGoal,
  traceContext: TraceContext,
  nowMs: number,
): Promise<void> {
  if (
    decideGoalDeadline({
      endAtMs: target.endAtMs,
      deadlineGraceUsed: target.deadlineGraceUsed,
      nowMs,
    }) !== "wrap-up"
  ) {
    return;
  }
  if (!this.sessionStore?.markTargetDeadlineGraceUsed) return;
  try {
    await this.sessionStore.markTargetDeadlineGraceUsed({
      sessionID: this.sessionId,
      targetID: target.targetID,
    });
    this.logger?.info("Goal deadline reached; releasing the final wrap-up turn", {
      ...traceContextToLogContext(traceContext),
      event: "target.deadline.wrap_up_released",
      module: "core.runtime",
      status: "started",
      targetId: target.targetID,
    });
  } catch (error) {
    this.logger?.warn("Failed to persist goal deadline wrap-up flag", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.deadline.wrap_up_mark_failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
}

/**
 * 结算到点硬停。记账 SQL 也会在同一条 update 里翻这个状态（兜底），
 * 两处都以「active → deadline_reached 的一次跃迁」为准，因此提醒只会发出一次。
 */
async function settleTargetDeadlineReached(
  this: AgentRuntimeInternal,
  target: SessionGoal,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;
  try {
    const settled = await this.sessionStore.updateTargetStatus({
      sessionID: this.sessionId,
      status: "deadline_reached",
    });
    if (!settled || settled.status !== "deadline_reached") return;
    await this.recordTargetChanged({
      action: "status_updated",
      previousTarget: target,
      source: "runtime",
      target: settled,
      traceContext,
    });
    await this.recordGoalStateChangeReminder({
      text: GOAL_DEADLINE_REACHED_REMINDER_TEXT,
      traceContext,
    });
    this.logger?.info("Goal stopped at its configured deadline", {
      ...traceContextToLogContext(traceContext),
      event: "target.deadline.reached",
      module: "core.runtime",
      status: "completed",
      targetId: settled.targetID,
    });
  } catch (error) {
    // 权威状态写库失败不能阻塞 turn 收尾；下一次运行时活动会重试结算。
    this.logger?.warn("Failed to settle goal deadline", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.deadline.settle_failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
}

/**
 * 记账 SQL 兜底翻到 deadline_reached 时补发一次性提醒。
 * 只有从 active 跃迁的那一次调用会命中，因此与候选检查路径不会重复发。
 */
async function emitDeadlineReachedReminderIfFlipped(
  this: AgentRuntimeInternal,
  previousTarget: SessionGoal | null,
  accountedTarget: SessionGoal | null,
  traceContext: TraceContext,
): Promise<void> {
  if (previousTarget?.status !== "active" || accountedTarget?.status !== "deadline_reached") {
    return;
  }
  await this.recordGoalStateChangeReminder({
    text: GOAL_DEADLINE_REACHED_REMINDER_TEXT,
    traceContext,
  });
  this.logger?.info("Goal stopped at its configured deadline during turn accounting", {
    ...traceContextToLogContext(traceContext),
    event: "target.deadline.reached",
    module: "core.runtime",
    status: "completed",
    targetId: accountedTarget.targetID,
  });
}

export async function hasRunningBackgroundTaskForGoalContinuation(
  this: AgentRuntimeInternal,
): Promise<boolean> {
  return hasRunningBackgroundRuntimeTask(this.runtimeTaskRegistry);
}

/**
 * 跨进预警窗口时补发一次性提醒。
 * 「只发一次」由落库的 deadlineWarningSent 保证——落库是条件写入
 * （where deadline_warning_sent = 0），并发下只有真正翻转到 1 的那次会拿到标记，
 * 因此两条记账路径不会各发一条。续跑提示里的 approaching 文案是每轮都带的常规通道，
 * 这条提醒专门覆盖「用户手动插话」这类不经过续跑提示词的情况。
 */
async function emitDeadlineApproachingReminderIfNeeded(
  this: AgentRuntimeInternal,
  accountedTarget: SessionGoal | null,
  nowMs: number,
  traceContext: TraceContext,
): Promise<void> {
  if (!accountedTarget || accountedTarget.status !== "active") return;
  if (accountedTarget.deadlineWarningSent) return;
  if (!this.sessionStore?.markTargetDeadlineWarningSent) return;
  if (
    !shouldSendGoalDeadlineWarning({
      endAtMs: accountedTarget.endAtMs,
      warningSent: false,
      nowMs,
    })
  ) {
    return;
  }
  try {
    const marked = await this.sessionStore.markTargetDeadlineWarningSent({
      sessionID: this.sessionId,
      targetID: accountedTarget.targetID,
    });
    if (!marked?.deadlineWarningSent) return;
    await this.recordGoalStateChangeReminder({
      text: GOAL_DEADLINE_APPROACHING_REMINDER_TEXT,
      traceContext,
    });
    this.logger?.info("Goal is approaching its configured deadline", {
      ...traceContextToLogContext(traceContext),
      endAtMs: accountedTarget.endAtMs,
      event: "target.deadline.approaching",
      module: "core.runtime",
      status: "waiting",
      targetId: accountedTarget.targetID,
    });
  } catch (error) {
    // 预警是提示性能力，落库失败不能影响 turn 记账；下一轮会重新判定。
    this.logger?.warn("Failed to mark goal deadline warning", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.deadline.warning_mark_failed",
      module: "core.runtime",
      status: "failed",
      targetId: accountedTarget.targetID,
    });
  }
}

export async function accountTargetTurnCompletion(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
    usage?: ModelUsageSummary;
  },
): Promise<void> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore) return;
  if (target.status !== "active") return;

  const tokensUsedDelta = input.usage?.totalTokens ?? 0;
  const endedAtMs = Date.now();

  try {
    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const accountedTarget = this.sessionStore.finishTargetRun
      ? await this.sessionStore.finishTargetRun({
          endedAtMs,
          inputID: input.inputID,
          sessionID: this.sessionId,
          targetID: target.targetID,
          tokensUsedDelta,
        })
      : await this.sessionStore.accountTargetUsage({
          sessionID: this.sessionId,
          targetID: target.targetID,
          tokensUsedDelta,
          timeUsedSecondsDelta: Math.max(0, Math.ceil((endedAtMs - input.startedAtMs) / 1000)),
        });
    if (accountedTarget?.targetID === target.targetID) {
      await this.recordTargetChanged({
        action: this.sessionStore.finishTargetRun ? "run_finished" : "usage_accounted",
        previousTarget,
        source: "runtime",
        target: accountedTarget,
        traceContext: input.traceContext,
      });
      await emitDeadlineReachedReminderIfFlipped.call(
        this,
        previousTarget,
        accountedTarget,
        input.traceContext,
      );
      await emitDeadlineApproachingReminderIfNeeded.call(
        this,
        accountedTarget,
        endedAtMs,
        input.traceContext,
      );
    }
  } catch (error) {
    this.logger?.warn("Failed to account goal turn completion", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.account.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
}

export async function startTargetTurnAccounting(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    startedAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  },
): Promise<SessionGoal | null> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore?.startTargetRun) return target;
  if (target.status !== "active") return target;

  try {
    const startedTarget = await this.sessionStore.startTargetRun({
      inputID: input.inputID,
      sessionID: this.sessionId,
      startedAtMs: input.startedAtMs,
      targetID: target.targetID,
    });
    if (startedTarget?.targetID === target.targetID) {
      await this.recordTargetChanged({
        action: "run_started",
        previousTarget: target,
        source: "runtime",
        target: startedTarget,
        traceContext: input.traceContext,
      });
      return startedTarget;
    }
    return target;
  } catch (error) {
    this.logger?.warn("Failed to start goal active run accounting", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.run_start.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
    return target;
  }
}

export async function heartbeatTargetTurnAccounting(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    seenAtMs: number;
    startedTarget: SessionGoal | null;
    traceContext: TraceContext;
  },
): Promise<void> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore?.heartbeatTargetRun) return;
  if (target.status !== "active") return;
  try {
    await this.sessionStore.heartbeatTargetRun({
      inputID: input.inputID,
      seenAtMs: input.seenAtMs,
      sessionID: this.sessionId,
      targetID: target.targetID,
    });
  } catch (error) {
    this.logger?.debug("Failed to heartbeat goal active run accounting", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.run_heartbeat.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
  }
}

export async function finishTargetTurnAccounting(
  this: AgentRuntimeInternal,
  input: {
    inputID: string;
    endedAtMs: number;
    startedTarget: SessionGoal | null;
    status?: "paused";
    traceContext: TraceContext;
  },
): Promise<SessionGoal | null> {
  const target = input.startedTarget;
  if (!target || !this.sessionStore?.finishTargetRun) return target;
  if (target.status !== "active") return target;

  try {
    const previousTarget = await this.readSessionTargetForContext(input.traceContext);
    const finishedTarget = await this.sessionStore.finishTargetRun({
      endedAtMs: input.endedAtMs,
      inputID: input.inputID,
      sessionID: this.sessionId,
      status: input.status,
      targetID: target.targetID,
    });
    if (finishedTarget?.targetID === target.targetID) {
      await this.recordTargetChanged({
        action: "run_finished",
        previousTarget,
        source: "runtime",
        target: finishedTarget,
        traceContext: input.traceContext,
      });
      await emitDeadlineReachedReminderIfFlipped.call(
        this,
        previousTarget,
        finishedTarget,
        input.traceContext,
      );
      await emitDeadlineApproachingReminderIfNeeded.call(
        this,
        finishedTarget,
        input.endedAtMs,
        input.traceContext,
      );
      return finishedTarget;
    }
    return target;
  } catch (error) {
    this.logger?.warn("Failed to finish goal active run accounting", {
      ...traceContextToLogContext(input.traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "target.run_finish.failed",
      module: "core.runtime",
      status: "failed",
      targetId: target.targetID,
    });
    return target;
  }
}

export async function pauseActiveTargetForCancellation(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  const target = await this.readSessionTargetForContext(traceContext);
  if (!target || target.status !== "active") return;

  try {
    const pausedTarget = await this.sessionStore.updateTargetStatus({
      sessionID: this.sessionId,
      status: "paused",
    });
    if (pausedTarget) {
      await this.recordTargetChanged({
        action: "status_updated",
        previousTarget: target,
        source: "runtime",
        target: pausedTarget,
        traceContext,
      });
    }
  } catch (error) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "Failed to pause active goal after turn cancellation",
      {
        cause: error instanceof Error ? error : new Error(String(error)),
        context: { sessionId: this.sessionId, targetId: target.targetID },
        recoverable: true,
      },
    );
  }
}

export async function activatePausedTargetAfterResume(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<SessionGoal | null> {
  if (!this.sessionStore || this.getPlanEnabled()) return null;
  const target = await this.readSessionTargetForContext(traceContext);
  // 用户 Stop 运行中的 goal 时，取消收口会把 target 标记为 paused。
  // 冷恢复不能再把它自动改回 active，否则会在用户明确停止后继续 verifier/continuation，
  // 也会让桌面队列“立即发送”被残留 active goal 状态卡住。显式 /goal resume 才能重新激活。
  return target;
}
