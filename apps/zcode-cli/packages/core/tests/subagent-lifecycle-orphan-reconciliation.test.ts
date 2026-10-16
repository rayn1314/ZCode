import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  mapSubagentLifecycleStatus,
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  createSessionId,
  createTraceId,
  type SessionEntryInfo,
  type SessionId,
  type TraceContext,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { reconcileOrphanedSubagentLifecycles } from "../src/runtime/methods/subagent-lifecycle-reconciliation.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

// 对账的接管时刻下限是**模块加载时刻**（`PROCESS_TAKEOVER_FLOOR_MS`）。构造历史行时把
// 时间戳放到足够早的过去，才能稳定落进"上一个进程写的"一侧。
const ORPHAN_WRITTEN_AT = Date.now() - 600_000;
const SESSION_ID: SessionId = createSessionId("reconcile");

interface FakeStore {
  entries: SessionEntryInfo[];
  saved: SessionEntryInfo[];
  sessionEntries?: (input: { sessionID: string; type: string }) => Promise<SessionEntryInfo[]>;
  saveSessionEntry?: (entry: SessionEntryInfo) => Promise<void>;
}

interface Harness {
  runtime: AgentRuntimeInternal;
  registry: InMemoryRuntimeTaskRegistry;
  store: FakeStore;
  warn: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  traceContext: TraceContext;
}

function lifecycleEntry(input: {
  agentId: string;
  status?: string;
  endedAt?: number;
  updatedAt?: number;
  childSessionId?: string;
}): SessionEntryInfo {
  const updated = input.updatedAt ?? ORPHAN_WRITTEN_AT;
  return {
    id: `subagent-lifecycle:${input.agentId}`,
    sessionID: SESSION_ID,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: ORPHAN_WRITTEN_AT, updated },
    data: {
      agentId: input.agentId,
      childSessionId: input.childSessionId ?? `sess_subagent_${input.agentId}`,
      agentType: "Explore",
      description: "orphaned explorer",
      background: false,
      status: input.status ?? "running",
      startedAt: ORPHAN_WRITTEN_AT,
      ...(input.endedAt === undefined ? {} : { endedAt: input.endedAt }),
    },
  };
}

function createHarness(options?: { entries?: SessionEntryInfo[] }): Harness {
  const registry = new InMemoryRuntimeTaskRegistry();
  const store: FakeStore = {
    entries: options?.entries ?? [],
    saved: [],
    sessionEntries: async () => store.entries,
    saveSessionEntry: async (entry) => {
      store.saved.push(entry);
      const index = store.entries.findIndex((candidate) => candidate.id === entry.id);
      if (index >= 0) store.entries[index] = entry;
      else store.entries.push(entry);
    },
  };
  const warn = vi.fn();
  const info = vi.fn();
  return {
    // 对账只用到 sessionStore / runtimeTaskRegistry / logger / sessionId 四处，
    // 其余运行时不参与这条路径，按 it 的需要 cast 最小面。
    runtime: {
      sessionId: SESSION_ID,
      sessionStore: store,
      runtimeTaskRegistry: registry,
      logger: { warn, info },
    } as unknown as AgentRuntimeInternal,
    registry,
    store,
    warn,
    info,
    traceContext: { traceId: createTraceId(), sessionId: SESSION_ID },
  };
}

async function runReconcile(harness: Harness): Promise<number> {
  return reconcileOrphanedSubagentLifecycles.call(harness.runtime, harness.traceContext);
}

describe("reconcileOrphanedSubagentLifecycles", () => {
  let agentId: string;

  beforeEach(() => {
    agentId = `agent_${randomUUID()}`;
  });

  it("认领上一个进程丢下的孤儿行，写成 interrupted 并保留原行事实（A1）", async () => {
    const harness = createHarness({ entries: [lifecycleEntry({ agentId })] });

    const count = await runReconcile(harness);

    expect(count).toBe(1);
    expect(harness.store.saved).toHaveLength(1);
    const saved = harness.store.saved[0]!;
    expect(saved.id).toBe(`subagent-lifecycle:${agentId}`);
    expect(saved.time.created).toBe(ORPHAN_WRITTEN_AT);
    expect(saved.data).toMatchObject({
      agentId,
      childSessionId: `sess_subagent_${agentId}`,
      agentType: "Explore",
      description: "orphaned explorer",
      status: "interrupted",
      startedAt: ORPHAN_WRITTEN_AT,
    });
    expect(typeof (saved.data as { endedAt?: unknown }).endedAt).toBe("number");
    expect(harness.info).toHaveBeenCalledTimes(1);
  });

  it("活体豁免：注册表里有该 agentId 就不改写（A2）", async () => {
    const harness = createHarness({ entries: [lifecycleEntry({ agentId })] });
    harness.registry.register({
      taskId: agentId,
      agentId,
      type: "local_agent",
      agentType: "Explore",
      description: "running explorer",
      status: "running",
      startedAt: new Date(ORPHAN_WRITTEN_AT),
      childSessionId: `sess_subagent_${agentId}`,
      isBackgrounded: true,
    } as never);

    const count = await runReconcile(harness);

    expect(count).toBe(0);
    expect(harness.store.saved).toHaveLength(0);
  });

  it("终态豁免：已结算的行不再改写（A3）", async () => {
    const completed = `agent_${randomUUID()}`;
    const alreadyReconciled = `agent_${randomUUID()}`;
    const harness = createHarness({
      entries: [
        lifecycleEntry({ agentId: completed, status: "completed", endedAt: ORPHAN_WRITTEN_AT }),
        lifecycleEntry({
          agentId: alreadyReconciled,
          status: "interrupted",
          endedAt: ORPHAN_WRITTEN_AT,
        }),
      ],
    });

    expect(await runReconcile(harness)).toBe(0);
    expect(harness.store.saved).toHaveLength(0);
  });

  it("脏数据：终态词缺 endedAt 不改写，running 词带 endedAt 仍被认领（A3）", async () => {
    const failedWithoutEnd = `agent_${randomUUID()}`;
    const runningWithEnd = `agent_${randomUUID()}`;
    const harness = createHarness({
      entries: [
        lifecycleEntry({ agentId: failedWithoutEnd, status: "failed" }),
        lifecycleEntry({ agentId: runningWithEnd, status: "running", endedAt: ORPHAN_WRITTEN_AT }),
      ],
    });

    const count = await runReconcile(harness);

    // 判据只看 roster 会不会把它显示成 lost，不看单一字段。
    expect(count).toBe(1);
    expect(harness.store.saved.map((entry) => entry.id)).toEqual([
      `subagent-lifecycle:${runningWithEnd}`,
    ]);
  });

  it("同进程豁免：晚于接管时刻写入的行不改写（A4）", async () => {
    const harness = createHarness({
      entries: [lifecycleEntry({ agentId, updatedAt: Date.now() + 60_000 })],
    });

    expect(await runReconcile(harness)).toBe(0);
    expect(harness.store.saved).toHaveLength(0);
  });

  it("幂等：第二次接管不再改写，行内容保持一致（A5）", async () => {
    const harness = createHarness({ entries: [lifecycleEntry({ agentId })] });

    expect(await runReconcile(harness)).toBe(1);
    const afterFirst = structuredClone(harness.store.entries[0]!);
    expect(await runReconcile(harness)).toBe(0);
    expect(harness.store.entries[0]).toEqual(afterFirst);
    expect(harness.store.saved).toHaveLength(1);
  });

  it("失败降级：读抛错只 warn，不阻断（A6）", async () => {
    const harness = createHarness();
    harness.store.sessionEntries = async () => {
      throw new Error("store offline");
    };

    await expect(runReconcile(harness)).resolves.toBe(0);
    expect(harness.warn).toHaveBeenCalledTimes(1);
  });

  it("失败降级：单行写失败只跳过该行，其余继续（A6）", async () => {
    const broken = `agent_${randomUUID()}`;
    const healthy = `agent_${randomUUID()}`;
    const harness = createHarness({
      entries: [lifecycleEntry({ agentId: broken }), lifecycleEntry({ agentId: healthy })],
    });
    const save = harness.store.saveSessionEntry!;
    harness.store.saveSessionEntry = async (entry) => {
      if (entry.id.endsWith(broken)) throw new Error("write failed");
      await save(entry);
    };

    expect(await runReconcile(harness)).toBe(1);
    expect(harness.store.saved.map((entry) => entry.id)).toEqual([`subagent-lifecycle:${healthy}`]);
    expect(harness.warn).toHaveBeenCalledTimes(1);
  });

  it("能力缺席：宿主没有 entry 读写能力时静默返回 0（A6）", async () => {
    const harness = createHarness({ entries: [lifecycleEntry({ agentId })] });
    harness.store.sessionEntries = undefined;
    harness.store.saveSessionEntry = undefined;

    await expect(runReconcile(harness)).resolves.toBe(0);
    expect(harness.warn).not.toHaveBeenCalled();
  });

  it("投影：interrupted 原样透出，未认领的形态仍是 lost（A7）", () => {
    expect(mapSubagentLifecycleStatus("interrupted")).toBe("interrupted");
    expect(mapSubagentLifecycleStatus("running")).toBe("lost");
    expect(mapSubagentLifecycleStatus(undefined)).toBe("lost");
  });
});
