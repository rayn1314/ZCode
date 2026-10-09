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

// ── 事件汇包装：单行读旧行 →（spawn 建/stop 覆写）→ 落盘；失败只 warn ──

interface MemoryStore {
  store: SessionStorePort;
  rows: Map<string, SessionEntryInfo>;
  /** 读放大回归探针：热路径只许走单行读，`sessionEntries` 全量读的次数必须恒为 0。 */
  reads: { single: number; bulk: number };
}

function memoryStore(seed: readonly SessionEntryInfo[] = []): MemoryStore {
  const rows = new Map(seed.map((entry) => [entry.id, entry]));
  const reads = { single: 0, bulk: 0 };
  return {
    rows,
    reads,
    store: {
      // 与真实仓储同语义：按 (sessionID, id, type) 定位单行，越界的行返回 null。
      async sessionEntry(input: { sessionID: SessionId; id: string; type?: string }) {
        reads.single += 1;
        const row = rows.get(input.id);
        if (!row || row.sessionID !== input.sessionID) return null;
        if (input.type && row.type !== input.type) return null;
        return row;
      },
      async sessionEntries(input: { sessionID: SessionId; type?: string }) {
        reads.bulk += 1;
        return [...rows.values()].filter(
          (row) => row.sessionID === input.sessionID && (!input.type || row.type === input.type),
        );
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

/**
 * O(n²) 读放大回归：此前每条 Spawned/Stopped 都 `sessionEntries` 全量取回该 session
 * 该类型的全部行再 find 目标行，代价 = O(事件数 × 条目数)。契约钉死为每条事件恰好
 * 一次单行读（主键 O(1)）+ 一次 upsert，全量读计数恒 0。
 */
test("读放大回归：每条事件恰好一次单行读，sessionEntries 全量读恒为 0", async () => {
  const { store, rows, reads } = memoryStore();
  const trace = { traceId: "trace_1" } as never;
  const agents = ["agent_1", "agent_2", "agent_3"];

  for (const agentId of agents) {
    await persistSubagentLifecycleEntry(
      runtimeWith(store),
      event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload({ agentId })),
      trace,
    );
  }
  for (const agentId of agents) {
    await persistSubagentLifecycleEntry(
      runtimeWith(store),
      event(SessionEventType.SubagentStopped, STOP_AT, {
        agentId,
        childSessionId: `sess_subagent_${agentId}`,
        status: "completed",
      }),
      trace,
    );
  }

  // 行数 = 派过的子代理数（不随事件数增长），读次数 = 事件数（不随条目数增长）。
  assert.equal(rows.size, agents.length);
  assert.equal(reads.single, agents.length * 2);
  assert.equal(reads.bulk, 0);
});

test("两子代理 spawn/stop 交错（stop 并发）：各写各的行，created/startedAt/endedAt 不串", async () => {
  const { store, rows } = memoryStore();
  const trace = { traceId: "trace_1" } as never;
  const secondSpawnAt = SPAWN_AT + 1000;
  const secondStopAt = STOP_AT + 1000;

  // 交错而非按子代理分段：A spawn → B spawn →（A、B stop 并发）。
  await persistSubagentLifecycleEntry(
    runtimeWith(store),
    event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload({ agentId: "agent_1" })),
    trace,
  );
  await persistSubagentLifecycleEntry(
    runtimeWith(store),
    event(SessionEventType.SubagentSpawned, secondSpawnAt, spawnPayload({ agentId: "agent_2" })),
    trace,
  );
  await Promise.all([
    persistSubagentLifecycleEntry(
      runtimeWith(store),
      event(SessionEventType.SubagentStopped, STOP_AT, {
        agentId: "agent_1",
        childSessionId: "sess_subagent_agent_1",
        status: "completed",
      }),
      trace,
    ),
    persistSubagentLifecycleEntry(
      runtimeWith(store),
      event(SessionEventType.SubagentStopped, secondStopAt, {
        agentId: "agent_2",
        childSessionId: "sess_subagent_agent_2",
        status: "failed",
      }),
      trace,
    ),
  ]);

  assert.equal(rows.size, 2);
  const first = rows.get(subagentLifecycleEntryId("agent_1"));
  const second = rows.get(subagentLifecycleEntryId("agent_2"));
  assert.ok(first);
  assert.ok(second);
  // 各行的起点、终点、状态严格属于自己的 agentId，没有互相覆写。
  assert.deepEqual(first.time, { created: SPAWN_AT, updated: STOP_AT });
  assert.equal((first.data as { startedAt: number }).startedAt, SPAWN_AT);
  assert.equal((first.data as { endedAt?: number }).endedAt, STOP_AT);
  assert.equal((first.data as { status?: string }).status, "completed");
  assert.deepEqual(second.time, { created: secondSpawnAt, updated: secondStopAt });
  assert.equal((second.data as { startedAt: number }).startedAt, secondSpawnAt);
  assert.equal((second.data as { endedAt?: number }).endedAt, secondStopAt);
  assert.equal((second.data as { status?: string }).status, "failed");
});

test("事件汇：stop 无旧行不写（不凭空造行）", async () => {
  const { store, rows } = memoryStore();
  const warns: Record<string, unknown>[] = [];
  const trace = { traceId: "trace_1" } as never;

  await persistSubagentLifecycleEntry(
    runtimeWith(store, warns),
    event(SessionEventType.SubagentStopped, STOP_AT, { agentId: "agent_orphan", status: "failed" }),
    trace,
  );
  assert.equal(rows.size, 0);
  assert.equal(warns.length, 0);
});

test("事件汇：读失败只 warn 不上抛（列表是辅助能力）", async () => {
  const warns: Record<string, unknown>[] = [];
  const trace = { traceId: "trace_1" } as never;
  const failing = {
    async sessionEntry(): Promise<SessionEntryInfo | null> {
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

test("事件汇：写失败只 warn 不上抛（spawn 与 stop 同语义）", async () => {
  const warns: Record<string, unknown>[] = [];
  const trace = { traceId: "trace_1" } as never;
  // stop 只有在读到旧行时才会走到写（无旧行的 stop 直接不落行，见上一个用例），
  // 所以这里让单行读返回一条已存在的 spawn 行，两个事件都必然尝试写盘。
  const existing: SessionEntryInfo = {
    id: subagentLifecycleEntryId("agent_2"),
    sessionID: PARENT,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: SPAWN_AT, updated: SPAWN_AT },
    data: {
      agentId: "agent_2",
      childSessionId: "sess_subagent_agent_2",
      agentType: "coder",
      description: "write the tests",
      background: false,
      status: "running",
      startedAt: SPAWN_AT,
    },
  };
  const failing = {
    async sessionEntry(input: { id: string }) {
      return input.id === existing.id ? existing : null;
    },
    async saveSessionEntry(): Promise<void> {
      throw new Error("disk full");
    },
  } as unknown as SessionStorePort;

  await persistSubagentLifecycleEntry(
    runtimeWith(failing, warns),
    event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload({ agentId: "agent_2" })),
    trace,
  );
  await persistSubagentLifecycleEntry(
    runtimeWith(failing, warns),
    event(SessionEventType.SubagentStopped, STOP_AT, {
      agentId: "agent_2",
      childSessionId: "sess_subagent_agent_2",
      status: "completed",
    }),
    trace,
  );

  assert.equal(warns.length, 2);
  for (const warn of warns) {
    assert.equal(warn.event, "subagent_lifecycle.persist_failed");
    assert.equal(warn.status, "failed");
    assert.equal(warn.errorMessage, "disk full");
  }
});

test("旧宿主未实现单行读时回退 sessionEntries：结果等价，只多花读", async () => {
  const rows = new Map<string, SessionEntryInfo>();
  const reads = { bulk: 0 };
  const store = {
    async sessionEntries(input: { sessionID: SessionId; type?: string }) {
      reads.bulk += 1;
      return [...rows.values()].filter(
        (row) => row.sessionID === input.sessionID && (!input.type || row.type === input.type),
      );
    },
    async saveSessionEntry(entry: SessionEntryInfo) {
      rows.set(entry.id, entry);
    },
  } as unknown as SessionStorePort;
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
      childSessionId: "sess_subagent_agent_1",
      status: "completed",
    }),
    trace,
  );

  assert.equal(reads.bulk, 2);
  const row = rows.get(subagentLifecycleEntryId("agent_1"));
  assert.ok(row);
  assert.deepEqual(row.time, { created: SPAWN_AT, updated: STOP_AT });
  assert.equal((row.data as { endedAt?: number }).endedAt, STOP_AT);
});

/**
 * 回归：真实 `SqliteSessionStore.sessionEntry` 是**原型方法**（实现体读 `this.db`）。
 * 调用侧解构后裸调用会丢 `this`，stop 就读不到 spawn 行，于是 created/startedAt 丢失、
 * 状态诚实性破掉；上面的闭包式假 store 不读 `this`，看不见这个缺陷。
 * 这里用原型方法 + 实例字段把接收者绑定钉死。
 */
test("原型方法式 store 不得丢接收者：stop 必须读回 spawn 行并保留 created/startedAt", async () => {
  class PrototypeStore {
    readonly #rows = new Map<string, SessionEntryInfo>();

    async sessionEntry(input: {
      sessionID: SessionId;
      id: string;
      type?: string;
    }): Promise<SessionEntryInfo | null> {
      const row = this.#rows.get(input.id);
      if (!row || row.sessionID !== input.sessionID) return null;
      if (input.type && row.type !== input.type) return null;
      return row;
    }

    async saveSessionEntry(entry: SessionEntryInfo): Promise<void> {
      this.#rows.set(entry.id, entry);
    }

    get size(): number {
      return this.#rows.size;
    }

    row(agentId: string): SessionEntryInfo | undefined {
      return this.#rows.get(subagentLifecycleEntryId(agentId));
    }
  }

  const store = new PrototypeStore();
  const asPort = store as unknown as SessionStorePort;
  const trace = { traceId: "trace_1" } as never;
  const warns: Record<string, unknown>[] = [];

  await persistSubagentLifecycleEntry(
    runtimeWith(asPort, warns),
    event(SessionEventType.SubagentSpawned, SPAWN_AT, spawnPayload()),
    trace,
  );
  await persistSubagentLifecycleEntry(
    runtimeWith(asPort, warns),
    event(SessionEventType.SubagentStopped, STOP_AT, {
      agentId: "agent_1",
      agentType: "coder",
      childSessionId: "sess_subagent_agent_1",
      status: "completed",
    }),
    trace,
  );

  assert.equal(warns.length, 0);
  assert.equal(store.size, 1);
  const row = store.row("agent_1");
  assert.ok(row);
  assert.equal((row.data as { startedAt?: number }).startedAt, SPAWN_AT);
  assert.equal((row.data as { endedAt?: number }).endedAt, STOP_AT);
  assert.deepEqual(row.time, { created: SPAWN_AT, updated: STOP_AT });
});
