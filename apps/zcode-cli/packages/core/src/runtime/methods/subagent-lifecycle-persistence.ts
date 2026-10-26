// ============================================================
// 子代理生命周期 → 持久化 session entry（spec D8）
// ============================================================
//
// 子代理事件（`SubagentSpawned` / `SubagentStopped`）发到**父会话**的事件流，但内存
// eventStore 随会话去激活被清空（`session-residency.ts`），冷恢复也不回灌这两类事件。
// `ListAgents` 的 roster 端口要跨重启回答「本会话派过哪些子代理」，因此在这里把生命周期落成
// 稳定 id 的 session entry —— 与 `user-input-auto-resolution` 同款「需要跨重启的派生事实」
// 做法（业务侧只读 entry 的最终状态，不重放事件）。

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  SessionEventType,
  traceContextToLogContext,
} from "../deps.js";
import { mapSubagentLifecycleStatus } from "@zcode/contracts";
import type { AgentRuntimeInternal } from "../internal.js";
import type {
  Logger,
  SessionEntryInfo,
  SessionEvent,
  SessionId,
  SessionStorePort,
  TraceContext,
} from "../deps.js";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";

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
  /**
   * 派发这次子代理的父侧工具调用 id（spawn 事件 payload 的 `parentToolCallId`）。
   *
   * 它同时就是父侧那个 Agent tool part 的 `callID`，因此冷恢复时能凭它把「中断的派发」
   * 与「这个 agentId」对上——没有它，hydration 只能把中断的 Agent 调用浇成泛化文案，
   * 父代理手里就不剩 `agentId` 了（spec `subagent-continuation-copy.md` D4c）。
   */
  parentToolCallId?: string;
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
  // stop 事件不带 parentToolCallId，必须沿用 spawn 行上的值，否则覆写会把关联键丢掉
  // （与 created/startedAt 同一条约束 b 的理由：stop 只更新终态相关字段）。
  const parentToolCallId = nonEmptyString(payload.parentToolCallId) ?? previous?.parentToolCallId;

  const data: SubagentLifecycleEntryData = {
    agentId,
    childSessionId,
    agentType: nonEmptyString(payload.agentType) ?? previous?.agentType ?? "subagent",
    description: nonEmptyString(payload.description) ?? previous?.description ?? "",
    background: payload.background === true || previous?.background === true,
    ...(parentToolCallId ? { parentToolCallId } : {}),
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

/**
 * 从旧 entry 解出最小事实集；结构损坏时当作没有旧行（stop 会因此跳过，不写半条）。
 * 孤儿对账也读它来判行事实（agentId / 状态词），所以两者对「什么是一行有效记录」的判断同源。
 */
export function readLifecycleData(
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
    ...(nonEmptyString(data.parentToolCallId)
      ? { parentToolCallId: nonEmptyString(data.parentToolCallId)! }
      : {}),
    ...(status ? { status } : {}),
    startedAt: typeof data.startedAt === "number" ? data.startedAt : entry.time.created,
    ...(typeof data.endedAt === "number" ? { endedAt: data.endedAt } : {}),
  };
}

/**
 * 重建持久化子代理任务时可用的额外事实。日志与输出根都不属于「生命周期」本身，
 * 所以不落 entry，由调用方按当前进程的装配传进来。
 */
export interface PersistedSubagentTaskLookup {
  logger?: Logger;
  /**
   * 派发时冻结的输出根（`config.subagents.outputRootDir`）。给出时按 runner 建目录的同一公式
   * 推出 `outputFile`——entry 本身不存这个路径，但公式是确定的：`<root>/<父会话>/<agentId>/output.txt`。
   * 缺省时与 runner 一致回落到 `<tmp>/zcode-agents`，让 `TaskOutput` 仍能读到上一命的产物。
   */
  outputRootDir?: string;
}

/**
 * 按 agentId 从持久化数据重建一个**终态** task 快照（spec `subagent-session-messaging.md` D9）。
 *
 * 调用方：`SendMessage` 的 `agent_*` 寻址、输入复活（D10）、`TaskOutput`。三处都是「注册表
 * 未命中不等于 agent 不存在」——子会话、生命周期 entry 与产物都还在，只是不在内存。
 *
 * 重建出的快照只能用于续跑或只读投影，绝不能当成活体状态：状态经
 * `mapSubagentLifecycleStatus` 归一，`running` 一律落成 `lost`（`running` 只能由本进程
 * 注册表断言）。`notified: true`：这条任务在上一条命里已经宣告过终态，重建不得再触发一遍
 * 通知——续跑产生的终态由新注册的快照负责宣告。
 */
export async function readPersistedSubagentTask(
  store: SessionStorePort | undefined,
  sessionId: SessionId,
  agentId: string,
  lookup: PersistedSubagentTaskLookup = {},
): Promise<RuntimeTaskSnapshot | undefined> {
  const { logger, outputRootDir } = lookup;
  if (!store) return undefined;
  const entryId = subagentLifecycleEntryId(agentId);
  let entry: SessionEntryInfo | null | undefined;
  try {
    entry = store.sessionEntry
      ? await store.sessionEntry({ sessionID: sessionId, id: entryId })
      : undefined;
    if (!entry && store.sessionEntries) {
      // 旧宿主未实现单行读：按类型列出再按稳定 id 过滤（一个 agentId 一行，不会长）。
      const entries = await store.sessionEntries({
        sessionID: sessionId,
        type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
      });
      entry = entries.find((candidate) => candidate.id === entryId) ?? null;
    }
  } catch (error) {
    // 存储异常不等于「agent 不存在」：只降级，让调用方回落到原有的失败文案。
    logger?.warn("Failed to read subagent lifecycle entry for persisted addressing", {
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent.persisted_task.read_failed",
      module: "core.runtime",
      sessionId: sessionId as string,
      agentId,
      status: "failed",
    });
    return undefined;
  }

  const facts = readLifecycleData(entry ?? undefined);
  if (!facts?.childSessionId) return undefined;
  // runner 建目录的同一公式（`createSubagentLifecycle`）：entry 不存路径，但路径是确定的。
  // 有了它 `TaskOutput` 才能读到上一命的产物，而不是只报一个状态、正文空白。
  const agentOutputDir = join(
    outputRootDir ?? join(tmpdir(), "zcode-agents"),
    sessionId,
    facts.agentId,
  );
  return {
    taskId: facts.agentId,
    agentId: facts.agentId,
    agentType: facts.agentType,
    description: facts.description,
    status: mapSubagentLifecycleStatus(facts.status),
    startedAt: new Date(facts.startedAt),
    ...(facts.endedAt !== undefined ? { completedAt: new Date(facts.endedAt) } : {}),
    // 持久化 JSON 丢品牌，但该值由 createSessionId 产出，跨这个边界收回 SessionId 是安全的。
    childSessionId: facts.childSessionId as SessionId,
    ...(facts.parentToolCallId ? { parentToolCallId: facts.parentToolCallId } : {}),
    outputFile: join(agentOutputDir, "output.txt"),
    isBackgrounded: facts.background,
    notified: true,
    type: "local_agent",
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
