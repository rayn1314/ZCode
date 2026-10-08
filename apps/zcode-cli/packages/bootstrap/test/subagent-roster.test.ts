import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
} from "@zcode/contracts";
import { createSubagentRosterPort } from "../src/zcode-protocol/subagent-roster.js";

/**
 * SubagentRosterPort 的契约（spec D8）：从父会话持久化的 `subagent_lifecycle` session entry
 * 读出历史子代理。关键不变式是「状态必须诚实」——只有 spawn、没有终态的 entry 报 lost
 * （本进程注册表缺席时那个 runtime 已经不存在），绝不报 running；认不出的终态词同样回落到 lost。
 */

const PARENT = "sess_parent" as SessionId;
const SPAWN_AT = Date.parse("2026-10-03T08:00:00.000Z");
const STOP_AT = Date.parse("2026-10-03T08:05:00.000Z");

/** 只实现 roster 需要的 `sessionEntries`；其余方法在端口契约里不涉及。 */
function storeWith(entries: readonly SessionEntryInfo[]): SessionStorePort {
  return {
    async sessionEntries() {
      return [...entries];
    },
  } as unknown as SessionStorePort;
}

function lifecycleEntry(
  data: Record<string, unknown>,
  overrides: { id?: string; created?: number; updated?: number; sessionID?: SessionId } = {},
): SessionEntryInfo {
  return {
    id: overrides.id ?? `subagent-lifecycle:${String(data.agentId)}`,
    sessionID: overrides.sessionID ?? PARENT,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: overrides.created ?? SPAWN_AT, updated: overrides.updated ?? SPAWN_AT },
    // 行级默认值；调用方用 data 覆盖单个事实，测试只关心被覆盖的那一项。
    data: {
      childSessionId: "sess_subagent_agent_1",
      agentType: "coder",
      description: "write the tests",
      background: false,
      startedAt: SPAWN_AT,
      ...data,
    },
  };
}

function rosterFor(store: SessionStorePort | undefined) {
  return createSubagentRosterPort({ resolveSessionStore: () => store });
}

test("spawn + stop 收口的 entry → completed，endedAt 有值，字段取自 entry", async () => {
  const entries = await rosterFor(
    storeWith([
      lifecycleEntry({
        agentId: "agent_1",
        status: "completed",
        startedAt: SPAWN_AT,
        endedAt: STOP_AT,
      }),
    ]),
  ).listByParentSession(PARENT);

  assert.deepEqual(entries, [
    {
      agentId: "agent_1",
      childSessionId: "sess_subagent_agent_1",
      agentType: "coder",
      description: "write the tests",
      status: "completed",
      isBackgrounded: false,
      startedAt: SPAWN_AT,
      endedAt: STOP_AT,
    },
  ]);
});

test("只有 spawn 的 entry → lost，绝不是 running", async () => {
  const entries = await rosterFor(
    storeWith([lifecycleEntry({ agentId: "agent_1", status: "running" })]),
  ).listByParentSession(PARENT);

  assert.equal(entries[0]?.status, "lost");
  assert.notEqual(entries[0]?.status, "running");
  assert.equal(entries[0]?.endedAt, undefined);
});

test("无 status 的 entry → lost", async () => {
  const entries = await rosterFor(
    storeWith([lifecycleEntry({ agentId: "agent_1" })]),
  ).listByParentSession(PARENT);

  assert.equal(entries[0]?.status, "lost");
});

test("background: true → isBackgrounded: true；缺省 → false", async () => {
  const entries = await rosterFor(
    storeWith([
      lifecycleEntry({ agentId: "agent_bg", background: true, status: "running" }),
      lifecycleEntry({ agentId: "agent_fg", status: "running" }),
    ]),
  ).listByParentSession(PARENT);

  const byId = new Map(entries.map((entry) => [entry.agentId, entry]));
  assert.equal(byId.get("agent_bg")?.isBackgrounded, true);
  assert.equal(byId.get("agent_fg")?.isBackgrounded, false);
});

test("未知 status → lost（不猜）", async () => {
  const entries = await rosterFor(
    storeWith([lifecycleEntry({ agentId: "agent_1", status: "something_new", endedAt: STOP_AT })]),
  ).listByParentSession(PARENT);

  assert.equal(entries[0]?.status, "lost");
});

test("TaskStop 词表对齐：事件原词 stopped → killed（与活体注册表同词）", async () => {
  const entries = await rosterFor(
    storeWith([lifecycleEntry({ agentId: "agent_1", status: "stopped", endedAt: STOP_AT })]),
  ).listByParentSession(PARENT);

  assert.equal(entries[0]?.status, "killed");
  assert.equal(entries[0]?.endedAt, STOP_AT);
});

test("known 同义词：success → completed、cancelled → cancelled", async () => {
  const entries = await rosterFor(
    storeWith([
      lifecycleEntry({ agentId: "agent_ok", status: "success", endedAt: STOP_AT }),
      lifecycleEntry({ agentId: "agent_cancel", status: "cancelled", endedAt: STOP_AT }),
    ]),
  ).listByParentSession(PARENT);

  const byId = new Map(entries.map((entry) => [entry.agentId, entry]));
  assert.equal(byId.get("agent_ok")?.status, "completed");
  assert.equal(byId.get("agent_cancel")?.status, "cancelled");
});

test("缺 agentId/childSessionId 的 entry 被跳过，畸形行不让整次列表失败", async () => {
  const entries = await rosterFor(
    storeWith([
      lifecycleEntry({ agentId: "agent_no_child", childSessionId: "", status: "completed" }),
      lifecycleEntry({ childSessionId: "sess_subagent_orphan", status: "completed" }),
      lifecycleEntry({ agentId: "agent_ok", status: "completed", endedAt: STOP_AT }),
    ]),
  ).listByParentSession(PARENT);

  assert.deepEqual(
    entries.map((entry) => entry.agentId),
    ["agent_ok"],
  );
});

test("忽略非 subagent_lifecycle 类型的 entry", async () => {
  const foreign = {
    ...lifecycleEntry({ agentId: "agent_foreign", status: "completed" }),
    type: "runtime/model_selection",
  };
  const entries = await rosterFor(
    storeWith([foreign, lifecycleEntry({ agentId: "agent_1", status: "completed" })]),
  ).listByParentSession(PARENT);

  assert.deepEqual(
    entries.map((entry) => entry.agentId),
    ["agent_1"],
  );
});

test("startedAt 缺失时回落到 entry.time.created；endedAt 只在有终态时出现", async () => {
  const entries = await rosterFor(
    storeWith([
      lifecycleEntry(
        { agentId: "agent_1", status: "completed", startedAt: undefined, endedAt: STOP_AT },
        { created: SPAWN_AT },
      ),
    ]),
  ).listByParentSession(PARENT);

  assert.equal(entries[0]?.startedAt, SPAWN_AT);
});

test("解析不到 session store（宿主无持久化）返回空数组，不抛错", async () => {
  assert.deepEqual(await rosterFor(undefined).listByParentSession(PARENT), []);
});

test("store 读取失败向上抛，不假装没有历史", async () => {
  const broken = {
    async sessionEntries(): Promise<SessionEntryInfo[]> {
      throw new Error("session store read failed");
    },
  } as unknown as SessionStorePort;
  await assert.rejects(
    () => rosterFor(broken).listByParentSession(PARENT),
    /session store read failed/,
  );
});

/**
 * 回归：真实 `SqliteSessionStore.sessionEntries` 是**原型方法**（实现体读 `this.db`）。
 * 调用侧解构后裸调用会丢 `this`，`ListAgents` 读历史子代理就会崩；而上面的闭包式假 store
 * 不读 `this`，看不见这个缺陷。这里用原型方法 + 实例字段把接收者绑定钉死。
 */
test("原型方法式 store 不得丢接收者：ListAgents 读历史子代理必须成功", async () => {
  class PrototypeStore {
    readonly #entries: readonly SessionEntryInfo[];

    constructor(entries: readonly SessionEntryInfo[]) {
      this.#entries = entries;
    }

    async sessionEntries(): Promise<SessionEntryInfo[]> {
      return [...this.#entries];
    }
  }

  const store = new PrototypeStore([
    lifecycleEntry({ agentId: "agent_1", status: "completed", endedAt: STOP_AT }),
  ]) as unknown as SessionStorePort;

  const entries = await rosterFor(store).listByParentSession(PARENT);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.agentId, "agent_1");
});
