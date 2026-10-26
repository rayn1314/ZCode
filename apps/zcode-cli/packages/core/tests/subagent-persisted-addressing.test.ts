import { describe, expect, it } from "vitest";
import {
  SessionEventType,
  createSessionEvent,
  createSessionId,
  type SessionEntryInfo,
  type SessionStorePort,
} from "@zcode/contracts";
import {
  buildSubagentLifecycleEntry,
  readPersistedSubagentTask,
} from "../src/runtime/methods/subagent-lifecycle-persistence.js";

const sessionId = createSessionId("persisted-task-reader");

function lifecycleRow(agentId: string, payload: Record<string, unknown>): SessionEntryInfo {
  return buildSubagentLifecycleEntry({
    event: createSessionEvent(SessionEventType.SubagentSpawned, sessionId, {
      agentId,
      childSessionId: `subagent_${agentId}`,
      agentType: "explore",
      description: "Persisted work",
      background: true,
      ...payload,
    }),
  });
}

function storeWith(rows: readonly SessionEntryInfo[]): SessionStorePort {
  return {
    sessionEntry: async ({ id }: { id: string }) => rows.find((row) => row.id === id) ?? null,
    sessionEntries: async () => [...rows],
  } as unknown as SessionStorePort;
}

// spec `subagent-session-messaging.md` D9：`agent_*` 跨进程持久可寻址，句柄来源是 lifecycle entry。
describe("readPersistedSubagentTask（spec D9）", () => {
  it("把 lifecycle entry 重建为终态快照，并保留句柄与子会话", async () => {
    const snapshot = await readPersistedSubagentTask(
      storeWith([
        lifecycleRow("agent_reader", {
          parentToolCallId: "tool_agent_reader",
          status: "completed",
        }),
      ]),
      sessionId,
      "agent_reader",
    );

    expect(snapshot).toMatchObject({
      agentId: "agent_reader",
      childSessionId: "subagent_agent_reader",
      parentToolCallId: "tool_agent_reader",
      status: "completed",
      isBackgrounded: true,
      type: "local_agent",
      // 上一条命里已宣告过终态：重建不得再触发一遍通知。
      notified: true,
    });
  });

  it("spawn-only 的陈旧 entry 归一为 lost（不是 running）", async () => {
    const snapshot = await readPersistedSubagentTask(
      storeWith([lifecycleRow("agent_stale", { status: "running" })]),
      sessionId,
      "agent_stale",
    );

    expect(snapshot?.status).toBe("lost");
  });

  it("entry 不存在时返回 undefined，让调用方维持原失败文案", async () => {
    await expect(
      readPersistedSubagentTask(storeWith([]), sessionId, "agent_missing"),
    ).resolves.toBeUndefined();
  });

  it("旧宿主未实现单行读时回退到 sessionEntries", async () => {
    const rows = [lifecycleRow("agent_fallback", { status: "failed" })];
    const store = {
      sessionEntries: async () => rows,
    } as unknown as SessionStorePort;

    await expect(
      readPersistedSubagentTask(store, sessionId, "agent_fallback"),
    ).resolves.toMatchObject({ agentId: "agent_fallback", status: "failed" });
  });

  it("读存储抛错只降级，不断言 agent 不存在", async () => {
    const store = {
      sessionEntry: async () => {
        throw new Error("disk on fire");
      },
    } as unknown as SessionStorePort;

    await expect(
      readPersistedSubagentTask(store, sessionId, "agent_broken"),
    ).resolves.toBeUndefined();
  });
});
