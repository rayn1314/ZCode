import assert from "node:assert/strict";
import test from "node:test";
import type { SessionId } from "@zcode/contracts";
import {
  closeSessionTree,
  listSubagentChildSessionIds,
  listSubagentDescendantSessionIds,
  stopSubagentDescendantTurns,
} from "../src/zcode-protocol/session-tree.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

/**
 * S3 的收侧契约（spec `subagent-session-as-first-class.md` D5 / S3）：会话树的边判据、
 * 递归关停顺序（借用不变式：父后于子）、幂等与失败隔离、沿树中止只动后代。
 */

const ROOT = "sess_root";
const CHILD = "sess_subagent_child_1";
const GRANDCHILD = "sess_subagent_child_1_1";

interface NodeSpec {
  activeAbortController?: AbortController;
  /** 覆写 app.close；默认成功。用来验证「某节点关停失败不阻断其余节点」。 */
  close?: () => Promise<void>;
  parentSessionId?: string;
  taskType?: string;
}

interface TestRecord {
  activeAbortController?: AbortController;
  app: {
    close: () => Promise<void>;
    runtime: { stopActiveForegroundExecution: (options: { reason: string }) => unknown };
  };
  eventStore: { deleteSession: (sessionId: SessionId) => Promise<void> };
  parentSessionId?: string;
  taskType?: string;
  unsubscribe: () => void;
}

interface Harness {
  context: ZCodeProtocolAgentServerContext;
  /** 全局事件流，跨节点断言关停顺序。 */
  order: string[];
  /** disposeSession 调用时该 record 是否仍在注册表（顺序不变式）。 */
  registryHadRecordAtDispose: boolean[];
  sessions: Map<string, TestRecord>;
  warnings: Record<string, unknown>[];
}

function createHarness(): Harness {
  const order: string[] = [];
  const registryHadRecordAtDispose: boolean[] = [];
  const warnings: Record<string, unknown>[] = [];
  const sessions = new Map<string, TestRecord>();
  const context = {
    logger: {
      info: () => {},
      warn: (_message: string, logContext: Record<string, unknown>) => warnings.push(logContext),
    },
    sessions,
    v4Gateway: {
      disposeSession: (sessionId: string) => {
        registryHadRecordAtDispose.push(sessions.has(sessionId));
        order.push(`dispose:${sessionId}`);
      },
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, order, registryHadRecordAtDispose, sessions, warnings };
}

function addNode(harness: Harness, sessionId: string, spec: NodeSpec = {}): TestRecord {
  const close = spec.close;
  const record: TestRecord = {
    app: {
      close: async () => {
        harness.order.push(`close:${sessionId}`);
        await close?.();
      },
      runtime: {
        stopActiveForegroundExecution: (options) => {
          harness.order.push(`stop:${sessionId}:${options.reason}`);
          return { kind: "stopped", foregroundExecutionId: `fg_${sessionId}` };
        },
      },
    },
    eventStore: {
      deleteSession: async () => {
        harness.order.push(`delete:${sessionId}`);
      },
    },
    unsubscribe: () => {
      harness.order.push(`unsubscribe:${sessionId}`);
    },
    ...(spec.activeAbortController ? { activeAbortController: spec.activeAbortController } : {}),
    ...(spec.parentSessionId ? { parentSessionId: spec.parentSessionId } : {}),
    ...(spec.taskType ? { taskType: spec.taskType } : {}),
  };
  spec.activeAbortController?.signal.addEventListener("abort", () => {
    harness.order.push(`abort:${sessionId}`);
  });
  harness.sessions.set(sessionId, record);
  return record;
}

test("listSubagentChildSessionIds 只命中 (parentSessionId, subagent_child) 边，不连坐 fork 与选段侧聊", () => {
  const harness = createHarness();
  addNode(harness, ROOT, { taskType: "interactive" });
  addNode(harness, "sess_child", { parentSessionId: ROOT, taskType: "subagent_child" });
  // fork 与选段侧聊同样带父指针，但不是子代理：只按 parentSessionId 匹配会连坐它们。
  addNode(harness, "sess_fork", { parentSessionId: ROOT, taskType: "fork" });
  addNode(harness, "sess_side_chat", { parentSessionId: ROOT, taskType: "selection_side_chat" });
  addNode(harness, "sess_other_parent_child", {
    parentSessionId: "sess_other",
    taskType: "subagent_child",
  });

  assert.deepEqual(listSubagentChildSessionIds(harness.context, ROOT), ["sess_child"]);
  assert.deepEqual(listSubagentChildSessionIds(harness.context, "sess_missing"), []);
});

test("closeSessionTree 先子后父、每个节点都关停，且 dispose 早于注册表删除", async () => {
  const harness = createHarness();
  addNode(harness, ROOT);
  addNode(harness, CHILD, { parentSessionId: ROOT, taskType: "subagent_child" });
  addNode(harness, GRANDCHILD, { parentSessionId: CHILD, taskType: "subagent_child" });

  await closeSessionTree(harness.context, ROOT);

  // 每节点四步，子/孙严格早于父；delete = 内存 event store 释放（v4 路径原先漏掉的那一步）。
  assert.deepEqual(harness.order, [
    `unsubscribe:${GRANDCHILD}`,
    `close:${GRANDCHILD}`,
    `dispose:${GRANDCHILD}`,
    `delete:${GRANDCHILD}`,
    `unsubscribe:${CHILD}`,
    `close:${CHILD}`,
    `dispose:${CHILD}`,
    `delete:${CHILD}`,
    `unsubscribe:${ROOT}`,
    `close:${ROOT}`,
    `dispose:${ROOT}`,
    `delete:${ROOT}`,
  ]);
  assert.equal(harness.sessions.size, 0);
  // gateway 靠 context.sessions 定位 workspace 才能推 session.removed：dispose 时必须还在。
  assert.deepEqual(harness.registryHadRecordAtDispose, [true, true, true]);
});

test("closeSessionTree 幂等：根缺席不抛错，重复调用不重复关停", async () => {
  const harness = createHarness();
  addNode(harness, ROOT);
  addNode(harness, CHILD, { parentSessionId: ROOT, taskType: "subagent_child" });

  await closeSessionTree(harness.context, "sess_missing");
  assert.deepEqual(harness.order, [], "根 record 缺席时整棵树不动");
  assert.equal(harness.sessions.size, 2);

  await closeSessionTree(harness.context, ROOT);
  const afterFirstCall = [...harness.order];
  await closeSessionTree(harness.context, ROOT);
  assert.deepEqual(harness.order, afterFirstCall);
  assert.equal(harness.sessions.size, 0);
});

test("某个节点的 app.close 抛错不阻断兄弟节点与父的关停", async () => {
  const harness = createHarness();
  addNode(harness, ROOT);
  addNode(harness, CHILD, {
    parentSessionId: ROOT,
    taskType: "subagent_child",
    close: async () => {
      throw new Error("child close boom");
    },
  });
  addNode(harness, "sess_sibling", { parentSessionId: ROOT, taskType: "subagent_child" });

  await closeSessionTree(harness.context, ROOT);

  assert.equal(harness.sessions.size, 0, "失败节点的注册表摘除与其余节点都要完成");
  assert.deepEqual(
    harness.order.filter((entry) => entry.startsWith("delete:")),
    [`delete:${CHILD}`, "delete:sess_sibling", `delete:${ROOT}`],
  );
  assert.equal(harness.warnings.length, 1);
  assert.equal(harness.warnings[0].event, "zcode_protocol.session.close_failed");
  assert.equal(harness.warnings[0].step, "app_close");
  assert.equal(harness.warnings[0].sessionId, CHILD);
  assert.equal(harness.warnings[0].error, "child close boom");
});

test("stopSubagentDescendantTurns 停后代的前台轮并 abort 其取消句柄，绝不动根", () => {
  const harness = createHarness();
  const rootController = new AbortController();
  const childController = new AbortController();
  addNode(harness, ROOT, { activeAbortController: rootController });
  addNode(harness, CHILD, {
    activeAbortController: childController,
    parentSessionId: ROOT,
    taskType: "subagent_child",
  });
  addNode(harness, GRANDCHILD, { parentSessionId: CHILD, taskType: "subagent_child" });

  stopSubagentDescendantTurns(harness.context, ROOT, "parent session stopped");

  assert.deepEqual(harness.order, [
    `stop:${CHILD}:parent session stopped`,
    `abort:${CHILD}`,
    `stop:${GRANDCHILD}:parent session stopped`,
  ]);
  assert.equal(childController.signal.aborted, true);
  assert.equal((childController.signal.reason as Error).message, "parent session stopped");
  assert.equal(rootController.signal.aborted, false);
  assert.equal(harness.sessions.size, 3, "中止不关会话，record 必须仍在注册表");
});

test("listSubagentDescendantSessionIds 先子后孙；自指与互指环不会无限展开", async () => {
  const harness = createHarness();
  addNode(harness, ROOT);
  addNode(harness, CHILD, { parentSessionId: ROOT, taskType: "subagent_child" });
  addNode(harness, GRANDCHILD, { parentSessionId: CHILD, taskType: "subagent_child" });
  addNode(harness, "sess_self_loop", {
    parentSessionId: "sess_self_loop",
    taskType: "subagent_child",
  });
  addNode(harness, "sess_cycle_a", { parentSessionId: "sess_cycle_b", taskType: "subagent_child" });
  addNode(harness, "sess_cycle_b", { parentSessionId: "sess_cycle_a", taskType: "subagent_child" });

  assert.deepEqual(listSubagentDescendantSessionIds(harness.context, ROOT), [CHILD, GRANDCHILD]);
  // 根自身永远不在后代里，畸形自指因此被去重挡掉。
  assert.deepEqual(listSubagentDescendantSessionIds(harness.context, "sess_self_loop"), []);
  assert.deepEqual(listSubagentDescendantSessionIds(harness.context, "sess_cycle_a"), [
    "sess_cycle_b",
  ]);

  // 同一条环保护也覆盖关停路径：自指 record 必须能被关掉且不递归展开。
  await closeSessionTree(harness.context, "sess_self_loop");
  assert.equal(harness.sessions.has("sess_self_loop"), false);
});
