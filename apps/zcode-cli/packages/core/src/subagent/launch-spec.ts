// ============================================================
// 子代理启动规格 → 持久化 session entry（spec D2）
// ============================================================
//
// 子会话的运行时由父会话在 core 进程内构造，bootstrap 的会话构造路径因此不认识它。
// 冷恢复时（`createRecord` 按 `taskType === "subagent_child"` 重建 record）如果拿不到
// spawn 时的事实，子会话就丢身份：工具面退回默认，`subagents.enabled` 缺席还会让
// `Agent` 工具重新出现（套娃后门）。
//
// 这里把**推导不出来**的那部分身份在 spawn 时落一行稳定 id 的 entry：
//   - 工具白名单来自父 runtime 的实时工具注册表（`resolveSubagentToolAllowlist` 读
//     `this.getTools()`），bootstrap 侧无从重推，只能快照；
//   - persona 的 owner 是 profile，因此只存 `profileName` / `profileSource` 寻址键，不存正文；
//   - `permissionMode` / `modelSelection` 各有专用 entry，不在此重复存第二份。
//
// 写入点在 `ensureSessionPersistedForExternalActivity` **之后**：`session_entry.session_id`
// 对 `session(id)` 有外键约束，session 行不存在时写会失败。

import {
  SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
  traceContextToLogContext,
  type Logger,
  type SessionEntryInfo,
  type SessionId,
  type SubagentLaunchSpecEntryData,
  type TraceContext,
} from "@zcode/contracts";

/** 稳定 entry id：一个子会话一行，spawn 时写一次、之后不可变。 */
export function subagentLaunchSpecEntryId(childSessionId: SessionId): string {
  return `subagent-launch-spec:${childSessionId}`;
}

export function buildSubagentLaunchSpecEntry(input: {
  childSessionId: SessionId;
  data: SubagentLaunchSpecEntryData;
  createdAt?: number;
}): SessionEntryInfo {
  const createdAt = input.createdAt ?? Date.now();
  return {
    id: subagentLaunchSpecEntryId(input.childSessionId),
    sessionID: input.childSessionId,
    type: SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
    time: { created: createdAt, updated: createdAt },
    data: input.data,
  };
}

/**
 * 落盘。宿主没有 `sessionStore.saveSessionEntry` 时跳过——那种宿主本来也没有冷恢复，
 * 不构成静默降级。写入失败只 warn：spawn 不该因为规格落盘失败而失败，缺口由读取侧
 * 兜底（缺 spec → 受限模式，见 spec 的失败语义）。
 */
export async function persistSubagentLaunchSpec(input: {
  sessionStore?: { saveSessionEntry?: (entry: SessionEntryInfo) => Promise<void> };
  logger?: Logger;
  entry: SessionEntryInfo;
  traceContext: TraceContext;
}): Promise<void> {
  // 必须经宿主对象调用方法（`this` 绑定），不能先取函数引用再调用。
  const store = input.sessionStore;
  if (!store?.saveSessionEntry) return;
  try {
    await store.saveSessionEntry(input.entry);
  } catch (error) {
    input.logger?.warn("Failed to persist subagent launch spec", {
      ...traceContextToLogContext(input.traceContext),
      childSessionId: input.entry.sessionID,
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent_launch_spec.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}
