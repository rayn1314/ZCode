import assert from "node:assert/strict";
import test from "node:test";
import { createSessionResidentPoolHost } from "../src/zcode-protocol/session-residency.js";
import { SessionResidentPool } from "../src/zcode-protocol/session-resident-pool.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

/**
 * S3 的常驻侧契约（spec `subagent-session-as-first-class.md` D5 借用不变式）：
 * 有驻留子会话的父不可被 idle 回收——子 runtime 借父 App 的进程内适配器，
 * 父 App 的 close() 会 dispose 掉它们。回收仍单会话、不级联。
 */

const IDLE_PARENT = "sess_idle_parent";
const PARENT_WITH_CHILD = "sess_parent_with_child";
const CHILD = "sess_subagent_child_1";

interface Harness {
  context: ZCodeProtocolAgentServerContext;
  deactivated: string[];
  sessions: Map<string, unknown>;
}

function createHarness(): Harness {
  const deactivated: string[] = [];
  const sessions = new Map<string, unknown>();
  const context = {
    logger: { info: () => {}, warn: () => {} },
    sessions,
    v4Gateway: {
      assertSessionRuntimeDeactivatable: () => {},
      deactivateSession: (sessionId: string) => {
        deactivated.push(sessionId);
      },
      hasConversationSubscribers: () => false,
      hasResidencyBlockingCommands: () => false,
    },
    v4Interactions: { hasPendingForSession: () => false },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, deactivated, sessions };
}

function addRecord(
  harness: Harness,
  sessionId: string,
  spec: { parentSessionId?: string; taskType?: string } = {},
): void {
  harness.sessions.set(sessionId, {
    app: {
      close: async () => {},
      runtime: { hasResidencyBlockingWork: () => false },
    },
    eventStore: { deleteSession: async () => {} },
    legacyStreamSubscribed: false,
    persistence: "immediate",
    unsubscribe: () => {},
    updatedAt: 0,
    ...(spec.parentSessionId ? { parentSessionId: spec.parentSessionId } : {}),
    ...(spec.taskType ? { taskType: spec.taskType } : {}),
  });
}

test("readResidencyFacts 只把 (parentSessionId, subagent_child) 驻留记录算作 hasResidentChildren", () => {
  const harness = createHarness();
  addRecord(harness, IDLE_PARENT);
  addRecord(harness, PARENT_WITH_CHILD);
  addRecord(harness, CHILD, { parentSessionId: PARENT_WITH_CHILD, taskType: "subagent_child" });
  // fork 与选段侧聊也带父指针，但不是子代理，不能把父 pin 住。
  addRecord(harness, "sess_fork", { parentSessionId: PARENT_WITH_CHILD, taskType: "fork" });
  addRecord(harness, "sess_side_chat", {
    parentSessionId: IDLE_PARENT,
    taskType: "selection_side_chat",
  });

  const host = createSessionResidentPoolHost(harness.context);
  assert.equal(host.readResidencyFacts(PARENT_WITH_CHILD)?.hasResidentChildren, true);
  assert.equal(host.readResidencyFacts(IDLE_PARENT)?.hasResidentChildren, false);
  // 子会话自身没有驻留子记录，资格不受影响（回收仍单会话、不级联）。
  assert.equal(host.readResidencyFacts(CHILD)?.hasResidentChildren, false);
});

test("有驻留子会话的父不被 idle 回收，无子的空闲会话与子会话自身被回收", async () => {
  const harness = createHarness();
  addRecord(harness, IDLE_PARENT);
  addRecord(harness, PARENT_WITH_CHILD);
  addRecord(harness, CHILD, { parentSessionId: PARENT_WITH_CHILD, taskType: "subagent_child" });

  let now = 0;
  const pool = new SessionResidentPool(createSessionResidentPoolHost(harness.context), {
    idleTimeoutMs: 1_000,
    now: () => now,
  });

  // 第一次收敛只建立 eligible 计时窗口（TTL 未到，谁也不回收）。
  pool.rebalance();
  now = 2_000;
  pool.rebalance();
  await pool.waitForDeactivation(IDLE_PARENT);
  await pool.waitForDeactivation(CHILD);

  assert.deepEqual([...harness.sessions.keys()], [PARENT_WITH_CHILD]);
  assert.deepEqual([...harness.deactivated].sort(), [CHILD, IDLE_PARENT].sort());
});
