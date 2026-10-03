import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  SessionEventType,
  createSessionEvent,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import {
  buildSubagentLifecycleEntry,
  persistSubagentLifecycleEntry,
  subagentLifecycleEntryId,
} from "../src/runtime/methods/subagent-lifecycle-persistence.js";

/**
 * 事件 → session entry 的纯映射契约（spec D8 数据源）。覆盖两条最易被改错的约束：
 * - 稳定 id `subagent-lifecycle:<agentId>`：spawn/stop 覆写同一行；
 * - stop 必须保留首次 spawn 的 created/startedAt（stop 事件不带创建时间）。
 */

const PARENT = "sess_parent" as SessionId;
const SPAWN_AT = Date.parse("2026-10-03T08:00:00.000Z");
const STOP_AT = Date.parse("2026-10-03T08:05:00.000Z");

function event(type: SessionEventType, at: number, payload: Record<string, unknown>): SessionEvent {
  const created = createSessionEvent(type, PARENT, payload, { sequenceNumber: 1 });
  created.timestamp = new Date(at);
  return created;
}

function spawnPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agentId: "agent_1",
    agentType: "coder",
    childSessionId: "sess_subagent_agent_1",
    description: "write the tests",
    prompt: "write the tests",
    status: "running",
    ...overrides,
  };
}

test("spawn → 建行：稳定 id、created=spawn 时刻、无 endedAt、原词 status", () => {
  const entry = buildSubagentLifecycleEntry({
    event: event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload({ background: true })),
  });

  assert.ok(entry);
  assert.equal(entry.id, subagentLifecycleEntryId("agent_1"));
  assert.equal(entry.id, "subagent-lifecycle:agent_1");
  assert.equal(entry.sessionID, PARENT);
  assert.equal(entry.type, SESSION_ENTRY_SUBAGENT_LIFECYCLE);
  assert.deepEqual(entry.time, { created: SPAWN_AT, updated: SPAWN_AT });
  assert.deepEqual(entry.data, {
    agentId: "agent_1",
    childSessionId: "sess_subagent_agent_1",
    agentType: "coder",
    description: "write the tests",
    background: true,
    status: "running",
    startedAt: SPAWN_AT,
  });
});

test("stop → 覆写同一行：保留 created/startedAt，写入 endedAt 与原词", () => {
  const existing: SessionEntryInfo = {
    id: subagentLifecycleEntryId("agent_1"),
    sessionID: PARENT,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: SPAWN_AT, updated: SPAWN_AT },
    data: {
      agentId: "agent_1",
      childSessionId: "sess_subagent_agent_1",
      agentType: "coder",
      description: "write the tests",
      background: true,
      status: "running",
      startedAt: SPAWN_AT,
    },
  };

  const entry = buildSubagentLifecycleEntry({
    event: event(SessionEventType.SubagentStopped, STOP_AT, {
      agentId: "agent_1",
      agentType: "coder",
      childSessionId: "sess_subagent_agent_1",
      status: "completed",
    }),
    existing,
  });

  assert.ok(entry);
  assert.equal(entry.id, subagentLifecycleEntryId("agent_1"));
  // 关键：created 与 startedAt 仍是首次 spawn 的时刻，不被 stop 改写成结束时刻。
  assert.deepEqual(entry.time, { created: SPAWN_AT, updated: STOP_AT });
  assert.deepEqual(entry.data, {
    agentId: "agent_1",
    childSessionId: "sess_subagent_agent_1",
    agentType: "coder",
    description: "write the tests",
    background: true,
    status: "completed",
    startedAt: SPAWN_AT,
    endedAt: STOP_AT,
  });
});

test("stop 无对应 spawn 行 → 不落 entry（不凭空造无源的行）", () => {
  const entry = buildSubagentLifecycleEntry({
    event: event(SessionEventType.SubagentStopped, STOP_AT, {
      agentId: "agent_orphan",
      status: "failed",
    }),
  });
  assert.equal(entry, undefined);
});

test("resume spawn（复活）保留 created/startedAt，清掉旧 endedAt", () => {
  const existing: SessionEntryInfo = {
    id: subagentLifecycleEntryId("agent_1"),
    sessionID: PARENT,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: SPAWN_AT, updated: STOP_AT },
    data: {
      agentId: "agent_1",
      childSessionId: "sess_subagent_agent_1",
      agentType: "coder",
      description: "write the tests",
      background: true,
      status: "failed",
      startedAt: SPAWN_AT,
      endedAt: STOP_AT,
    },
  };

  const entry = buildSubagentLifecycleEntry({
    event: event(
      SessionEventType.SubagentSpawned,
      STOP_AT + 1000,
      spawnPayload({ resumed: true, background: true }),
    ),
    existing,
  });

  assert.ok(entry);
  assert.equal(entry.time.created, SPAWN_AT);
  assert.equal((entry.data as { startedAt: number }).startedAt, SPAWN_AT);
  assert.equal((entry.data as { endedAt?: number }).endedAt, undefined);
  assert.equal((entry.data as { status?: string }).status, "running");
});

test("缺 agentId 或 childSessionId 时不落 entry（不做半条记录）", () => {
  assert.equal(
    buildSubagentLifecycleEntry({
      event: event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload({ agentId: "" })),
    }),
    undefined,
  );
  assert.equal(
    buildSubagentLifecycleEntry({
      event: event(
        SessionEventType.SubagentSpawned,
        SPAWN_AT,
        spawnPayload({ childSessionId: undefined }),
      ),
    }),
    undefined,
  );
});

test("非生命周期事件不落 entry", () => {
  assert.equal(
    buildSubagentLifecycleEntry({
      event: event(SessionEventType.TurnComplete, SPAWN_AT, spawnPayload()),
    }),
    undefined,
  );
});

// ── 事件汇包装：读旧行 →（spawn 建/stop 覆写）→ 落盘；失败只 warn ──

interface MemoryStore {
  store: SessionStorePort;
  rows: Map<string, SessionEntryInfo>;
}

function memoryStore(seed: readonly SessionEntryInfo[] = []): MemoryStore {
  const rows = new Map(seed.map((entry) => [entry.id, entry]));
  return {
    rows,
    store: {
      async sessionEntries() {
        return [...rows.values()];
      },
      async saveSessionEntry(entry: SessionEntryInfo) {
        rows.set(entry.id, entry);
      },
    } as unknown as SessionStorePort,
  };
}

function runtimeWith(store: SessionStorePort, warns: Record<string, unknown>[] = []) {
  return {
    sessionStore: store,
    logger: {
      warn: (_message: string, context: Record<string, unknown>) => {
        warns.push(context);
      },
    },
  } as never;
}

test("事件汇端到端：spawn 建行后 stop 覆写，created/startedAt 保持 spawn 时刻", async () => {
  const { store, rows } = memoryStore();
  const trace = { traceId: "trace_1" } as never;

  await persistSubagentLifecycleEntry(
    runtimeWith(store),
    event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload()),
    trace,
  );
  await persistSubagentLifecycleEntry(
    runtimeWith(store),
    event(SessionEventType.SubagentStopped, STOP_AT, {
      agentId: "agent_1",
      agentType: "coder",
      childSessionId: "sess_subagent_agent_1",
      status: "completed",
    }),
    trace,
  );

  assert.equal(rows.size, 1);
  const row = rows.get(subagentLifecycleEntryId("agent_1"));
  assert.ok(row);
  assert.deepEqual(row.time, { created: SPAWN_AT, updated: STOP_AT });
  assert.equal((row.data as { startedAt: number }).startedAt, SPAWN_AT);
  assert.equal((row.data as { endedAt?: number }).endedAt, STOP_AT);
  assert.equal((row.data as { status?: string }).status, "completed");
});

test("事件汇：stop 无旧行不写；读取失败只 warn 不上抛（列表是辅助能力）", async () => {
  const { store, rows } = memoryStore();
  const warns: Record<string, unknown>[] = [];
  const trace = { traceId: "trace_1" } as never;

  await persistSubagentLifecycleEntry(
    runtimeWith(store, warns),
    event(SessionEventType.SubagentStopped, STOP_AT, { agentId: "agent_orphan", status: "failed" }),
    trace,
  );
  assert.equal(rows.size, 0);

  const failing = {
    async sessionEntries(): Promise<SessionEntryInfo[]> {
      throw new Error("read failed");
    },
    async saveSessionEntry() {},
  } as unknown as SessionStorePort;
  await persistSubagentLifecycleEntry(
    runtimeWith(failing, warns),
    event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload()),
    trace,
  );
  assert.equal(warns.length, 1);
  assert.equal(warns[0]?.event, "subagent_lifecycle.persist_failed");
});
