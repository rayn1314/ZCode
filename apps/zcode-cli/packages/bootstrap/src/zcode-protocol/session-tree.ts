// 子代理会话树的遍历与关停（spec `subagent-session-as-first-class.md` D5 / S3）。
//
// 树边只有一条判据：`parentSessionId === X && taskType === "subagent_child"`。
// 只按 `parentSessionId` 匹配会误伤 fork 与选段侧聊——它们同样带 `parentID`
// （`core/src/runtime/methods/session-fork.ts`），但不是子代理，级联会连坐。
//
// 深度被结构性限成 1 层：子会话没有 `Agent` 工具，派不出孙会话。遍历仍写成递归，不依赖
// 该假设——一旦限制放开，递归语义自动正确，不必同时改遍历与顺序。
//
// 遍历源是常驻注册表 `context.sessions`：非驻留子会话没有 runtime，既无需也无可关停；
// 它的持久化行按现有 delete 语义保留（delete 只做 close，不是删行——message 库无删除 API）。

import type { SessionId } from "@zcode/contracts";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/** 子代理边的一半：只有任务类型同为 `subagent_child` 才是子会话，不是 fork / 选段侧聊。 */
const SUBAGENT_CHILD_TASK_TYPE = "subagent_child";

/** 直接子会话（驻留记录中按 (parentSessionId, taskType) 命中）。 */
export function listSubagentChildSessionIds(
  context: ZCodeProtocolAgentServerContext,
  parentSessionId: string,
): string[] {
  const childIds: string[] = [];
  for (const [sessionId, record] of context.sessions) {
    if (
      record.parentSessionId === parentSessionId &&
      record.taskType === SUBAGENT_CHILD_TASK_TYPE
    ) {
      childIds.push(sessionId);
    }
  }
  return childIds;
}

/**
 * 全部后代，先子后孙（预序），已去重。
 *
 * `visited` 兼作环/自指防御：畸形 parent 链（record 指向自己，或两 record 互指）不能让遍历
 * 无限展开。预序保证「子先于孙」，关停顺序另由后序递归决定。
 */
export function listSubagentDescendantSessionIds(
  context: ZCodeProtocolAgentServerContext,
  rootSessionId: string,
): string[] {
  const descendantIds: string[] = [];
  const visited = new Set<string>([rootSessionId]);
  const walk = (parentSessionId: string): void => {
    for (const childId of listSubagentChildSessionIds(context, parentSessionId)) {
      if (visited.has(childId)) continue;
      visited.add(childId);
      descendantIds.push(childId);
      walk(childId);
    }
  };
  walk(rootSessionId);
  return descendantIds;
}

/**
 * 单会话关停（delete/close 语义）：退订 → app.close → gateway.disposeSession →
 * 注册表删除 → 内存 event store 释放。
 *
 * **顺序不可换**：`disposeSession` 必须早于注册表删除——gateway 靠 `getSessionWorkspaceId`
 * （读 `context.sessions`）定位 workspace 才能把 `session.removed` 推给 sessions-index 订阅者，
 * 反过来 workspaceId 恒为 null，删除会话后侧栏列表项永不消失。
 *
 * 每一步的失败都只记日志、不阻断后续步骤：这是删除路径的收尾动作，一个资源释放异常
 * 不能让会话永久留在注册表与内存 event store 里（下一次删除会因此永远命不中）。
 * 反过来，把异常抛给调用方等于让 v4 `deleteSession` 对已摘除注册表的会话报失败。
 */
export async function closeSessionRecord(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
): Promise<void> {
  const record = context.sessions.get(sessionId);
  // 幂等：record 已不在注册表（重复删除 / 并发竞态）时静默返回。
  if (!record) return;

  await runCloseStep(context, sessionId, "unsubscribe", () => record.unsubscribe?.());
  await runCloseStep(context, sessionId, "app_close", () => record.app.close?.());
  await runCloseStep(context, sessionId, "gateway_dispose", () =>
    context.v4Gateway?.disposeSession(sessionId),
  );
  // 注册表摘除本身不可能抛错，放在 step 之外以保证它一定执行。
  context.sessions.delete(sessionId);
  await runCloseStep(context, sessionId, "event_store_release", () =>
    record.eventStore.deleteSession(sessionId as SessionId),
  );
}

/**
 * 整棵子树关停：先递归关停子/孙，再关自己。
 *
 * 后序而不是预序是借用不变式的要求：子 runtime 借父 App 的进程内适配器
 * （`modelFactory` / `mcpPort` / `executionPort` …），父 `close()` 会释放它们，
 * 因此父必须比它的子 record 活得久。预序会在深度 > 1 时先关中间层、再关还需它的孙层。
 *
 * 幂等：根 record 缺席时静默返回；重复调用不抛错（`closeSessionRecord` 逐节点幂等）。
 */
export async function closeSessionTree(
  context: ZCodeProtocolAgentServerContext,
  rootSessionId: string,
): Promise<void> {
  if (!context.sessions.has(rootSessionId)) return;
  await closeSessionSubtree(context, rootSessionId, new Set<string>([rootSessionId]));
}

/**
 * 沿树中止后代会话进行中的轮，不投通知。
 *
 * 根**不在这里停**：根由调用方自己停，因为它要走 `expectedForegroundExecutionId` 精确匹配
 * 与 goal-pause barrier（见 v4 `stop` handler）。子会话结构上不能有 goal（S2 拒绝目标命令），
 * 所以后代不需要那道 barrier。
 *
 * 两件事都要做：`stopActiveForegroundExecution` 覆盖 Core 持有的派发轮与 v4 输入轮，
 * `activeAbortController` 覆盖 bootstrap 层自己在开轮窗口里置位的取消句柄。
 * 全程 best-effort——这是用户可见 stop 的收尾，任何一个后代失败都不能让级联中断或抛错。
 */
export function stopSubagentDescendantTurns(
  context: ZCodeProtocolAgentServerContext,
  rootSessionId: string,
  reason: string,
): void {
  for (const sessionId of listSubagentDescendantSessionIds(context, rootSessionId)) {
    const record = context.sessions.get(sessionId);
    if (!record) continue;
    try {
      record.app.runtime?.stopActiveForegroundExecution?.({ reason });
    } catch (error) {
      logTreeFailure(
        context,
        "zcode_protocol.session.stop_descendant_failed",
        sessionId,
        "runtime_stop",
        error,
      );
    }
    try {
      record.activeAbortController?.abort(new Error(reason));
    } catch (error) {
      logTreeFailure(
        context,
        "zcode_protocol.session.stop_descendant_failed",
        sessionId,
        "abort",
        error,
      );
    }
  }
}

/** 后序关停：子/孙全部关完才关自己；`visited` 防环（同 `listSubagentDescendantSessionIds`）。 */
async function closeSessionSubtree(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  visited: Set<string>,
): Promise<void> {
  for (const childId of listSubagentChildSessionIds(context, sessionId)) {
    if (visited.has(childId)) continue;
    visited.add(childId);
    await closeSessionSubtree(context, childId, visited);
  }
  await closeSessionRecord(context, sessionId);
}

/** 单个关停步骤的失败隔离 + 诊断（事件名遵循本目录既有 `zcode_protocol.session.*` 约定）。 */
async function runCloseStep(
  context: ZCodeProtocolAgentServerContext,
  sessionId: string,
  step: string,
  run: () => void | Promise<void>,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    logTreeFailure(context, "zcode_protocol.session.close_failed", sessionId, step, error);
  }
}

function logTreeFailure(
  context: ZCodeProtocolAgentServerContext,
  event: string,
  sessionId: string,
  step: string,
  error: unknown,
): void {
  context.logger?.warn("ZCode Protocol session tree operation failed", {
    error: error instanceof Error ? error.message : String(error),
    event,
    sessionId,
    step,
  });
}
