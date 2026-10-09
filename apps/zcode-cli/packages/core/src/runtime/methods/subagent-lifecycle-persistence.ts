// ============================================================
// 子代理生命周期 → 持久化 session entry（spec D8）
// ============================================================
//
// 子代理事件（`SubagentSpawned` / `SubagentStopped`）发到**父会话**的事件流，但内存
// eventStore 随会话去激活被清空（`session-residency.ts`），冷恢复也不回灌这两类事件。
// `ListAgents` 的 roster 端口要跨重启回答「本会话派过哪些子代理」，因此在这里把生命周期落成
// 稳定 id 的 session entry —— 与 `user-input-auto-resolution` 同款「需要跨重启的派生事实」
// 做法（业务侧只读 entry 的最终状态，不重放事件）。

import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  SessionEventType,
  traceContextToLogContext,
} from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { SessionEntryInfo, SessionEvent, SessionId, TraceContext } from "../deps.js";

/** 稳定 entry id：一个 agentId 一行。spawn/stop 覆写同一行，行数不随事件数增长。 */
export function subagentLifecycleEntryId(agentId: string): string {
  return `subagent-lifecycle:${agentId}`;
}

export interface SubagentLifecycleEntryData {
  agentId: string;
  childSessionId: string;
  agentType: string;
  description: string;
  background: boolean;
  /** 事件里的原词（spawn="running"、stop="completed"/"failed"/"stopped"…）；归一交给读取侧。 */
  status?: string;
  startedAt: number;
  endedAt?: number;
}

/**
 * 事件 → 一行生命周期 entry。返回 `undefined` 表示这条事件不构成可寻址的行，调用方跳过。
 *
 * 两条容易被改错的约束：
 * (a) id 是 `subagent-lifecycle:<agentId>` 而非按事件追加——spawn/stop 覆写同一行，读侧
 *     只需读最终状态，不必重放事件、也不会随事件数膨胀。
 * (b) `created`/`startedAt` 是「首次 spawn 的时刻」：stop 事件不带创建时间，必须沿用旧行，
 *     否则覆写会把 created 改写成「结束时刻」，历史行的起点被污染。
 */
export function buildSubagentLifecycleEntry(input: {
  event: SessionEvent;
  existing?: SessionEntryInfo;
}): SessionEntryInfo | undefined {
  const { event, existing } = input;
  const isSpawn = event.type === SessionEventType.SubagentSpawned;
  const isStop = event.type === SessionEventType.SubagentStopped;
  if (!isSpawn && !isStop) return undefined;

  const payload = asRecord(event.payload);
  const agentId = nonEmptyString(payload.agentId);
  // agentId 既是行主键也是覆写键，缺了无法定位同一行。
  if (!agentId) return undefined;

  const previous = readLifecycleData(existing);
  // 没有对应 spawn 行的 stop 不落 entry：凭空造行会给出无源的 startedAt，
  // 也与 roster「只有 spawn 才构成条目」的契约一致。
  if (isStop && !previous) return undefined;

  const childSessionId = nonEmptyString(payload.childSessionId) ?? previous?.childSessionId;
  // childSessionId 是 SendMessage 的地址；缺它的行既不可读也不可寻址，不做半条记录。
  if (!childSessionId) return undefined;

  const timestamp = event.timestamp.getTime();
  const created = existing?.time.created ?? timestamp;
  const startedAt = previous?.startedAt ?? created;
  const status = nonEmptyString(payload.status);

  const data: SubagentLifecycleEntryData = {
    agentId,
    childSessionId,
    agentType: nonEmptyString(payload.agentType) ?? previous?.agentType ?? "subagent",
    description: nonEmptyString(payload.description) ?? previous?.description ?? "",
    background: payload.background === true || previous?.background === true,
    ...(status ? { status } : {}),
    startedAt,
    // spawn（含 resume 复活）清掉旧终态，回到「无终态」；stop 写入结束时刻。
    ...(isSpawn ? {} : { endedAt: timestamp }),
  };

  return {
    id: subagentLifecycleEntryId(agentId),
    sessionID: event.sessionId,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created, updated: timestamp },
    data,
  };
}

/**
 * 事件汇处理：`SubagentSpawned` / `SubagentStopped` 落一条稳定 id 的 session entry。
 *
 * 写侧是**单语句 upsert**（`session_entry.id` 主键 + `on conflict(id) do update`）：
 * 不存在则 insert、存在则覆写同一行，spawn/stop 永远落在同一条记录上。
 * 读侧只为让 stop 保留 created/startedAt（见 `buildSubagentLifecycleEntry` 约束 b），
 * 因此按 `(sessionID, id, type)` 单行读，不把该 session 该类型的行全取回来再 find——
 * 事件汇每条生命周期事件都走这里，全量读会把代价放大成 O(事件数 × 条目数)。
 * 失败只 warn：列表是辅助能力，落盘失败不能打断子代理生命周期。
 */
export async function persistSubagentLifecycleEntry(
  runtime: AgentRuntimeInternal,
  event: SessionEvent,
  traceContext: TraceContext,
): Promise<void> {
  if (!runtime.sessionStore?.saveSessionEntry) return;

  try {
    const existing = await readExistingLifecycleEntry(runtime, event.sessionId, event.payload);
    const entry = buildSubagentLifecycleEntry({ event, existing });
    if (!entry) return;
    await runtime.sessionStore.saveSessionEntry(entry);
  } catch (error) {
    runtime.logger?.warn("Failed to persist subagent lifecycle entry", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent_lifecycle.persist_failed",
      module: "core.runtime",
      sessionEventType: event.type,
      status: "failed",
    });
  }
}

async function readExistingLifecycleEntry(
  runtime: AgentRuntimeInternal,
  sessionID: SessionId,
  payload: unknown,
): Promise<SessionEntryInfo | undefined> {
  const agentId = nonEmptyString(asRecord(payload).agentId);
  // agentId 缺失时没有可寻址的行，`buildSubagentLifecycleEntry` 同样会跳过。
  if (!agentId) return undefined;
  // 保留接收者再调用：真实 `SqliteSessionStore.sessionEntry/sessionEntries` 是原型方法，
  // 解构后裸调用会丢 `this`，实现体 `this.db` 直接 TypeError。
  const store = runtime.sessionStore;
  if (!store) return undefined;
  const entryId = subagentLifecycleEntryId(agentId);

  if (store.sessionEntry) {
    const entry = await store.sessionEntry({
      sessionID,
      id: entryId,
      type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    });
    return entry ?? undefined;
  }
  // 旧宿主未实现单行读时退回全量读：结果等价（同一 id、同一 session/type 过滤），
  // 只有成本差别；新路径已在 `SqliteSessionStore.sessionEntry` 上覆盖。
  if (!store.sessionEntries) return undefined;
  const entries = await store.sessionEntries({ sessionID, type: SESSION_ENTRY_SUBAGENT_LIFECYCLE });
  return entries.find((entry) => entry.id === entryId);
}

/** 从旧 entry 解出最小事实集；结构损坏时当作没有旧行（stop 会因此跳过，不写半条）。 */
function readLifecycleData(
  entry: SessionEntryInfo | undefined,
): SubagentLifecycleEntryData | undefined {
  if (!entry) return undefined;
  const data = asRecord(entry.data);
  const agentId = nonEmptyString(data.agentId);
  const childSessionId = nonEmptyString(data.childSessionId);
  if (!agentId || !childSessionId) return undefined;
  const status = nonEmptyString(data.status);
  return {
    agentId,
    childSessionId,
    agentType: nonEmptyString(data.agentType) ?? "subagent",
    description: nonEmptyString(data.description) ?? "",
    background: data.background === true,
    ...(status ? { status } : {}),
    startedAt: typeof data.startedAt === "number" ? data.startedAt : entry.time.created,
    ...(typeof data.endedAt === "number" ? { endedAt: data.endedAt } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
