// ============================================================
// Subagent Roster 端口实现（spec D8 / 阶段 6）
// ============================================================
//
// 从**父会话自己的持久化 session entry** 读历史子代理：`runtime/subagent_lifecycle` 每个
// agentId 一行，`SubagentSpawned` 建行、`SubagentStopped` 覆写为终态（见 core
// `subagent-lifecycle-persistence.ts`）。刻意不读消息历史、不 hydrate transcript——
// 列个子代理不该触发整段历史；也不读内存事件投影，事件在会话去激活时会被清空。
//
// 只读不变式：这里不写任何状态，也不是子代理生命周期的第二个真相源。因此状态语义必须保守：
// 只有 spawn、没有终态的 entry 报 `lost`（本进程注册表缺席时那个 runtime 已经不存在了），
// `running` 永远只由本进程的 runtimeTaskRegistry 断言。

import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  type Logger,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
  type SubagentRosterEntry,
  type SubagentRosterPort,
  type SubagentTaskStatus,
} from "@zcode/contracts";

export interface SubagentRosterDeps {
  /**
   * 按会话解析可读的 session store。端口是进程级一份，构造早于任何 session record 入表，
   * 因此必须惰性解析；解析不到（宿主没有持久化）时返回 undefined。
   */
  resolveSessionStore(sessionId: SessionId): SessionStorePort | undefined;
  logger?: Logger;
}

export function createSubagentRosterPort(deps: SubagentRosterDeps): SubagentRosterPort {
  return {
    async listByParentSession(
      parentSessionId: SessionId,
      options?: { signal?: AbortSignal },
    ): Promise<SubagentRosterEntry[]> {
      // 提前响应取消：读存储是有 I/O 的一步，abort 后不该继续投影。
      options?.signal?.throwIfAborted();

      // 保留接收者再调用：真实 `SqliteSessionStore.sessionEntries` 是原型方法，
      // 解构后裸调用会丢 `this`，实现体 `this.db` 直接 TypeError。
      const store = deps.resolveSessionStore(parentSessionId);
      if (!store?.sessionEntries) {
        // 父会话不在本进程 / 宿主无持久化 = 没有可读的历史来源。这既不是故障也不是
        // 「没有历史子代理」，只是本端口看不到；调用方不该据此把历史说成空的。留一行 debug
        // 便于分辨「没有历史」与「解析不到存储」这两种都会返回空的路径。
        deps.logger?.debug("Subagent roster found no session store for parent session", {
          event: "subagent_roster.session_store_missing",
          module: "bootstrap.subagent_roster",
          sessionId: parentSessionId,
        });
        return [];
      }

      const entries = await store.sessionEntries({
        sessionID: parentSessionId,
        type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
      });
      return projectRosterEntries(entries);
    },
  };
}

/**
 * `subagent_lifecycle` entry → roster 行。
 *
 * 规则：
 * - 缺 agentId/childSessionId 的行既不可读也不可寻址（childSessionId 是 SendMessage 的地址），
 *   跳过而不是让整次列表因一条畸形行失败。
 * - 状态只在 entry 里找终态；没有终态的 entry（只有 spawn）报 `lost`。
 */
function projectRosterEntries(entries: readonly SessionEntryInfo[]): SubagentRosterEntry[] {
  const projected: SubagentRosterEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== SESSION_ENTRY_SUBAGENT_LIFECYCLE) continue;
    const data = asRecord(entry.data);
    const agentId = nonEmptyString(data.agentId);
    const childSessionId = nonEmptyString(data.childSessionId);
    if (!agentId || !childSessionId) continue;
    const endedAt = typeof data.endedAt === "number" ? data.endedAt : undefined;
    projected.push({
      agentId,
      childSessionId,
      agentType: nonEmptyString(data.agentType) ?? "subagent",
      description: nonEmptyString(data.description) ?? "",
      // 只有 spawn 无终态 → lost，不是 running：本进程注册表缺席时那个 runtime 已经不存在了。
      // 猜 running 会让模型去发一条永远送不到的消息。
      status: mapLifecycleStatus(nonEmptyString(data.status)),
      // 后台 spawn 带 `background: true`；resume spawn 也带。前台 spawn 没有该字段。
      isBackgrounded: data.background === true,
      // startedAt 是这条 agent 被创建的时刻（首次 spawn），stop 不重置。
      startedAt: typeof data.startedAt === "number" ? data.startedAt : entry.time.created,
      ...(endedAt === undefined ? {} : { endedAt }),
    });
  }
  return projected;
}

/**
 * entry 状态词 → `AGENT_TASK_STATUSES`。entry 里存的是事件原词（core `runner.ts` 发
 * "completed"/"failed"/"stopped"），`success`/`error` 是 UI 面已在用的同义词。
 *
 * `stopped` → `killed` 是刻意的对齐：后台被 TaskStop 时活体注册表报 `killed`
 * （core `runner.ts` 的 `BACKGROUND_AGENT_STOPPED_STATE.registryStatus`），而事件只带
 * `subagentEventStatus="stopped"`。同一个事实在两种来源下必须同一个词，以活体注册表为准。
 *
 * `running` 无法由历史断言（本进程注册表缺席），归一到 `lost`；认不出的词同样 `lost`——
 * 把未知状态硬塞成 running/completed 等于替一个我们不认识的周期编造结论，而 `lost` 是唯一
 * 不需要额外假设的保守事实。
 */
function mapLifecycleStatus(status: string | undefined): SubagentTaskStatus {
  switch (status) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stopped":
    case "killed":
      return "killed";
    default:
      return "lost";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
