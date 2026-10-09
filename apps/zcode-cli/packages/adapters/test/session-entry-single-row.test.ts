import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  type ProjectId,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/session-store.js";

/**
 * 单行读仓储契约：`sessionEntry(sessionID, id, type)` 走 `session_entry.id` 主键，
 * 是子代理生命周期等「每事件读一条 → 改一条」路径的读侧原语——用 `sessionEntries`
 * 全量读再 find 会把代价放大成 O(事件数 × 条目数)。这里在真实 SQLite 上钉死
 * 三件事：命中/未命中、越界护栏（session/type 不匹配不返回）、upsert 不加行。
 */

const SESSION = "sess_parent" as SessionId;
const OTHER_SESSION = "sess_other" as SessionId;
const ENTRY_ID = "subagent-lifecycle:agent_1";

async function withStore<T>(run: (store: SessionStorePort) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-session-entry-"));
  const store = createSqliteSessionStore({ dbPath: join(rootDir, "sessions.db") });
  try {
    await store.createSession({
      id: SESSION,
      projectID: "proj_test" as ProjectId,
      slug: "entry-test",
      directory: rootDir,
      path: rootDir,
      title: "entry test",
      version: "1",
    });
    return await run(store);
  } finally {
    store.close();
    await rm(rootDir, { recursive: true, force: true });
  }
}

function lifecycleEntry(overrides: Partial<SessionEntryInfo> = {}): SessionEntryInfo {
  return {
    id: ENTRY_ID,
    sessionID: SESSION,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: 1_000, updated: 1_000 },
    data: {
      agentId: "agent_1",
      childSessionId: "sess_subagent_agent_1",
      agentType: "coder",
      description: "write the tests",
      background: false,
      status: "running",
      startedAt: 1_000,
    },
    ...overrides,
  };
}

test("单行读：命中返回整行，未命中的 id / 会话 / 类型一律 null", async () => {
  await withStore(async (store) => {
    assert.equal(await store.sessionEntry!({ sessionID: SESSION, id: ENTRY_ID }), null);

    await store.saveSessionEntry!(lifecycleEntry());

    const hit = await store.sessionEntry!({
      sessionID: SESSION,
      id: ENTRY_ID,
      type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    });
    assert.ok(hit);
    assert.equal(hit.id, ENTRY_ID);
    assert.equal(hit.sessionID, SESSION);
    assert.equal(hit.type, SESSION_ENTRY_SUBAGENT_LIFECYCLE);
    assert.deepEqual(hit.time, { created: 1_000, updated: 1_000 });
    assert.deepEqual(hit.data, lifecycleEntry().data);

    // 护栏：主键命中但 session/type 不属于请求方时不当作命中。
    assert.equal(await store.sessionEntry!({ sessionID: OTHER_SESSION, id: ENTRY_ID }), null);
    assert.equal(
      await store.sessionEntry!({ sessionID: SESSION, id: ENTRY_ID, type: "other/type" }),
      null,
    );
    assert.equal(
      await store.sessionEntry!({ sessionID: SESSION, id: "subagent-lifecycle:nope" }),
      null,
    );
  });
});

test("spawn→stop upsert 同一行：行数恒 1，time_created 不被 stop 改写", async () => {
  await withStore(async (store) => {
    await store.saveSessionEntry!(lifecycleEntry());
    await store.saveSessionEntry!(
      lifecycleEntry({
        time: { created: 1_000, updated: 2_000 },
        data: {
          agentId: "agent_1",
          childSessionId: "sess_subagent_agent_1",
          agentType: "coder",
          description: "write the tests",
          background: false,
          status: "completed",
          startedAt: 1_000,
          endedAt: 2_000,
        },
      }),
    );

    const rows = await store.sessionEntries!({
      sessionID: SESSION,
      type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    });
    assert.equal(rows.length, 1);

    const row = await store.sessionEntry!({
      sessionID: SESSION,
      id: ENTRY_ID,
      type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    });
    assert.ok(row);
    // 覆写只推进 updated：created/startedAt 仍是首次 spawn 的时刻。
    assert.deepEqual(row.time, { created: 1_000, updated: 2_000 });
    assert.equal((row.data as { status?: string }).status, "completed");
    assert.equal((row.data as { startedAt?: number }).startedAt, 1_000);
    assert.equal((row.data as { endedAt?: number }).endedAt, 2_000);
  });
});
