// subagent-runtime 契约测试：座位闸门、生命周期终态行、roster 只读投影、冷恢复对账。
// 只 import 本模块自己的文件；`@zcode/contracts` 只用于内核 helper（事件构造/entry 类型/session id）。
import { describe, expect, it } from "vitest";
import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  SessionEventType,
  createSessionEvent,
  type SessionEntryInfo,
  type SessionId,
} from "@zcode/contracts";
import { createSubagentSeatGate } from "../../src/subagent/seat-gate.js";
import {
  buildSubagentLifecycleEntry,
  readLifecycleData,
  subagentLifecycleEntryId,
} from "../../src/runtime/methods/subagent-lifecycle-persistence.js";
import { reconcileOrphanedSubagentLifecycles } from "../../src/runtime/methods/subagent-lifecycle-reconciliation.js";
import { mapSubagentLifecycleStatus } from "../../../contracts/src/interfaces/subagent-roster.port.js";
import { createSubagentRosterPort } from "../../../bootstrap/src/zcode-protocol/subagent-roster.js";

const PARENT_SESSION_ID = "sess_parent" as SessionId;

type ReconciliationRuntime = ThisParameterType<typeof reconcileOrphanedSubagentLifecycles>;
type LifecycleBuildInput = Parameters<typeof buildSubagentLifecycleEntry>[0];
type RosterStore = Parameters<
  Parameters<typeof createSubagentRosterPort>[0]["resolveSessionStore"]
>[0];

function lifecycleEvent(input: {
  type: typeof SessionEventType.SubagentSpawned | typeof SessionEventType.SubagentStopped;
  payload: Record<string, unknown>;
}): LifecycleBuildInput["event"] {
  return createSessionEvent(input.type, PARENT_SESSION_ID, input.payload);
}

function lifecycleEntryRow(input: {
  agentId: string;
  childSessionId?: string;
  status?: string;
  updatedAt: number;
}): SessionEntryInfo {
  return {
    id: subagentLifecycleEntryId(input.agentId),
    sessionID: PARENT_SESSION_ID,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: input.updatedAt - 1_000, updated: input.updatedAt },
    data: {
      agentId: input.agentId,
      childSessionId: input.childSessionId ?? `sess_subagent_${input.agentId}`,
      agentType: "explore",
      description: "排查",
      background: false,
      startedAt: input.updatedAt - 1_000,
      ...(input.status === undefined ? {} : { status: input.status }),
    },
  };
}

describe("座位闸门", () => {
  it("容量内立即放行；超容按 FIFO 排队，lease 重复 release 只放一个座位", async () => {
    const gate = createSubagentSeatGate(1);
    const first = await gate.acquire({ capacity: 1 });
    expect(gate.stats()).toEqual({ capacity: 1, held: 1, waiting: 0 });

    // 第二、第三个派发都排在同一队里，先来先走。
    const second = gate.acquire({ capacity: 1 });
    const third = gate.acquire({ capacity: 1 });
    expect(gate.stats().waiting).toBe(2);

    first.release();
    // 终局闩锁：重复 release 不得再放出一个座位（否则驻留预算被静默放大）。
    first.release();
    expect(gate.stats()).toEqual({ capacity: 1, held: 1, waiting: 1 });

    (await second).release();
    expect(gate.stats()).toEqual({ capacity: 1, held: 1, waiting: 0 });
    (await third).release();
    expect(gate.stats().held).toBe(0);
  });

  it("容量 clamp 到 ≥ 1；等座期间 abort 的派发立即出队且不占座", async () => {
    const gate = createSubagentSeatGate(0);
    expect(gate.stats().capacity).toBe(1);
    // 迟绑定：每次 acquire 读当前配置值，调小不召回在座者。
    const held = await gate.acquire({ capacity: 2 });
    expect(gate.stats()).toEqual({ capacity: 2, held: 1, waiting: 0 });

    const controller = new AbortController();
    const parked = gate.acquire({ capacity: 1, signal: controller.signal });
    expect(gate.stats().waiting).toBe(1);
    controller.abort(new Error("用户取消"));
    await expect(parked).rejects.toThrow("用户取消");
    // 出队即视为从未占座。
    expect(gate.stats()).toEqual({ capacity: 1, held: 1, waiting: 0 });
    held.release();
    expect(gate.stats().held).toBe(0);
  });
});

describe("生命周期终态行", () => {
  it("spawn 建行、stop 覆写同一行；created/startedAt 取首次 spawn，不被结束时刻污染", () => {
    const spawnEvent = lifecycleEvent({
      type: SessionEventType.SubagentSpawned,
      payload: { agentId: "agent_1", childSessionId: "sess_subagent_1", agentType: "explore" },
    });
    const spawnRow = buildSubagentLifecycleEntry({ event: spawnEvent });
    expect(spawnRow?.id).toBe("subagent-lifecycle:agent_1");
    expect(readLifecycleData(spawnRow)?.status).toBeUndefined();

    // stop 事件不带创建时间：必须沿用旧行。
    const stopEvent = lifecycleEvent({
      type: SessionEventType.SubagentStopped,
      payload: { agentId: "agent_1", status: "completed" },
    });
    const stopRow = buildSubagentLifecycleEntry({ event: stopEvent, existing: spawnRow });
    expect(stopRow?.id).toBe(spawnRow?.id);
    expect(stopRow?.time.created).toBe(spawnRow?.time.created);
    const facts = readLifecycleData(stopRow);
    expect(facts?.startedAt).toBe(readLifecycleData(spawnRow)?.startedAt);
    expect(facts?.endedAt).toBe(stopEvent.timestamp.getTime());
    expect(mapSubagentLifecycleStatus(facts?.status)).toBe("completed");
  });

  it("没有对应 spawn 的 stop 不落行；缺 agentId/childSessionId 也不落半条", () => {
    const orphanStop = buildSubagentLifecycleEntry({
      event: lifecycleEvent({
        type: SessionEventType.SubagentStopped,
        payload: { agentId: "agent_gone", status: "completed" },
      }),
    });
    expect(orphanStop).toBeUndefined();

    const noAgentId = buildSubagentLifecycleEntry({
      event: lifecycleEvent({ type: SessionEventType.SubagentSpawned, payload: {} }),
    });
    expect(noAgentId).toBeUndefined();

    const noChild = buildSubagentLifecycleEntry({
      event: lifecycleEvent({
        type: SessionEventType.SubagentSpawned,
        payload: { agentId: "agent_2" },
      }),
    });
    expect(noChild).toBeUndefined();
  });

  it("状态词归一只有一份：stopped→killed、running/未知→lost", () => {
    expect(mapSubagentLifecycleStatus("stopped")).toBe("killed");
    expect(mapSubagentLifecycleStatus("cancelled")).toBe("cancelled");
    expect(mapSubagentLifecycleStatus("running")).toBe("lost");
    expect(mapSubagentLifecycleStatus(undefined)).toBe("lost");
    expect(mapSubagentLifecycleStatus("something_new")).toBe("lost");
  });
});

describe("roster 只读投影", () => {
  it("只有 spawn 无终态的行报 lost 而不是 running；缺地址的行跳过；无存储返回空", async () => {
    const rows = [
      lifecycleEntryRow({ agentId: "agent_open", updatedAt: 1 }),
      lifecycleEntryRow({ agentId: "agent_done", status: "stopped", updatedAt: 2 }),
      lifecycleEntryRow({ agentId: "agent_broken", childSessionId: " ", updatedAt: 3 }),
    ];
    const store = { sessionEntries: async () => rows };
    const port = createSubagentRosterPort({
      resolveSessionStore: () => store as unknown as RosterStore,
    });

    const entries = await port.listByParentSession(PARENT_SESSION_ID);
    expect(entries.map((entry) => [entry.agentId, entry.status])).toEqual([
      ["agent_open", "lost"],
      ["agent_done", "killed"],
    ]);
    expect(entries[0]?.endedAt).toBeUndefined();

    const blind = createSubagentRosterPort({ resolveSessionStore: () => undefined });
    await expect(blind.listByParentSession(PARENT_SESSION_ID)).resolves.toEqual([]);
  });
});

describe("冷恢复孤儿对账", () => {
  function createRuntime(input: {
    entries: readonly SessionEntryInfo[];
    liveAgentIds?: readonly string[];
  }): { runtime: ReconciliationRuntime; saved: SessionEntryInfo[] } {
    const saved: SessionEntryInfo[] = [];
    const runtime = {
      sessionId: PARENT_SESSION_ID,
      sessionStore: {
        sessionEntries: async () => input.entries,
        saveSessionEntry: async (entry: SessionEntryInfo) => {
          saved.push(entry);
        },
      },
      runtimeTaskRegistry: {
        get: (agentId: string) => (input.liveAgentIds?.includes(agentId) ? { agentId } : undefined),
      },
    };
    return { runtime: runtime as unknown as ReconciliationRuntime, saved };
  }

  it("认领上个进程丢下的 spawn-only 行成 interrupted，活体与本进程新行豁免", async () => {
    const staleUpdatedAt = Date.now() - 60 * 60 * 1_000;
    const entries = [
      lifecycleEntryRow({ agentId: "agent_orphan", updatedAt: staleUpdatedAt }),
      // 活体豁免：注册表里有它，归还 runner 管。
      lifecycleEntryRow({ agentId: "agent_live", updatedAt: staleUpdatedAt }),
      // 本进程写入豁免：晚于接管时刻的行只可能是正在跑的活体。
      lifecycleEntryRow({ agentId: "agent_fresh", updatedAt: Date.now() }),
      lifecycleEntryRow({
        agentId: "agent_settled",
        status: "completed",
        updatedAt: staleUpdatedAt,
      }),
    ];
    const { runtime, saved } = createRuntime({
      entries,
      liveAgentIds: ["agent_live"],
    });

    const reconciled = await reconcileOrphanedSubagentLifecycles.call(runtime, {
      traceId: "trace-reconcile",
    } as Parameters<typeof reconcileOrphanedSubagentLifecycles>[0]);

    expect(reconciled).toBe(1);
    expect(saved).toHaveLength(1);
    const claimed = readLifecycleData(saved[0]);
    expect(claimed?.agentId).toBe("agent_orphan");
    expect(claimed?.status).toBe("interrupted");
    expect(claimed?.endedAt).toBeGreaterThanOrEqual(staleUpdatedAt);
    // 起点不被污染：created 仍是首次 spawn 的时刻。
    expect(saved[0]?.time.created).toBe(staleUpdatedAt - 1_000);
  });

  it("读存储失败只降级返回 0，不阻断会话恢复；能力缺席返回 0 而不是报错", async () => {
    const failing = {
      sessionId: PARENT_SESSION_ID,
      sessionStore: {
        sessionEntries: async () => {
          throw new Error("db locked");
        },
        saveSessionEntry: async () => {},
      },
      runtimeTaskRegistry: { get: () => undefined },
    } as unknown as ReconciliationRuntime;

    await expect(reconcileOrphanedSubagentLifecycles.call(failing, {} as never)).resolves.toBe(0);
    await expect(
      reconcileOrphanedSubagentLifecycles.call(
        { sessionId: PARENT_SESSION_ID } as never,
        {} as never,
      ),
    ).resolves.toBe(0);
  });
});
