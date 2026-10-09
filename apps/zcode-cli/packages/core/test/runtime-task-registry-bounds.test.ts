import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  InMemoryRuntimeTaskRegistry,
  MAX_PENDING_MESSAGES,
  RuntimeTaskMessageQueueFullError,
} from "../src/runtime-task/registry.js";
import { createExploreSubagentPort } from "../src/subagent/runner.js";
import { createSubagentSeatGate } from "../src/subagent/seat-gate.js";
import type { SubagentSendMessageRequest } from "@zcode/contracts";
import {
  ListAgentsOutputSchema,
  type ListAgentsOutput,
  type SubagentRosterPort,
} from "@zcode/contracts";
import { listAgentsToolEntry } from "../src/tool/handlers/list-agents.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";

/**
 * 注册表的有界保留契约（spec: core/spec/subagent-seat-gate-and-registry-bounds.md）：
 * - 终态条目超过 N=50 按 settle 时间最旧先出，running 永不被驱逐；
 * - 驱逐不破坏 list-agents：live 缺失时 history 行仍可见；
 * - pendingMessages 超限 queueMessage 拒绝，SendMessage 如实拿到 agent_queue_full。
 */

const STARTED_AT = new Date("2026-10-04T08:00:00.000Z");
const TRACE = {
  traceId: "trace_bounds",
  spanId: "span_bounds",
  sessionId: "sess_parent",
  turnId: "turn_1",
};

function registerTerminal(
  registry: InMemoryRuntimeTaskRegistry,
  index: number,
  completedAt: Date,
): void {
  const agentId = `agent_${String(index).padStart(3, "0")}`;
  // 模拟真实链路：register running → finalize update 终态（evict 只在这一刻触发）。
  registry.register({
    taskId: agentId,
    agentId,
    agentType: "general-purpose",
    childSessionId: `sess_subagent_${agentId}`,
    description: `task ${index}`,
    isBackgrounded: true,
    startedAt: STARTED_AT,
    status: "running",
    taskType: "local_agent",
    type: "local_agent",
  });
  registry.update(agentId, (task) => ({ ...task, status: "completed", completedAt }));
}

test("终态条目超过 50：按 settle 时间最旧先出，running 不受影响", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  // 60 个终态，settle 时间随序号递增。
  for (let index = 0; index < 60; index++) {
    registerTerminal(registry, index, new Date(STARTED_AT.getTime() + index * 1_000));
  }
  // 一个 running 任务：永不因终态溢出被驱逐。
  registry.register({
    taskId: "agent_running",
    agentId: "agent_running",
    agentType: "general-purpose",
    childSessionId: "sess_subagent_agent_running",
    description: "still running",
    isBackgrounded: true,
    startedAt: STARTED_AT,
    status: "running",
    taskType: "local_agent",
    type: "local_agent",
  });

  const all = Object.keys(registry.all());
  const terminal = all.filter((id) => id !== "agent_running");
  assert.equal(terminal.length, 50, "终态保留窗口为 50");
  assert.equal(registry.get("agent_running")?.status, "running", "running 不被驱逐");

  // 最旧的 10 个（000–009）被驱逐，最近的 50 个（010–059）仍在。
  assert.equal(registry.get("agent_000"), undefined);
  assert.equal(registry.get("agent_009"), undefined);
  assert.ok(registry.get("agent_010"));
  assert.ok(registry.get("agent_059"));

  // 插入序保留：驱逐不改变其余条目的相对顺序（list-agents 依赖它）。
  const liveOrder = all.filter((id) => id !== "agent_running");
  assert.deepEqual(liveOrder, [...liveOrder].sort());
});

test("驱逐后 list-agents 仍可见：live 缺失由 history 补齐", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  for (let index = 0; index < 60; index++) {
    registerTerminal(registry, index, new Date(STARTED_AT.getTime() + index * 1_000));
  }
  assert.equal(registry.get("agent_000"), undefined, "前置：最旧条目已被驱逐");

  // roster 仍能投影出被驱逐的 agent：live 缺失 → history 行顶上。
  const roster: SubagentRosterPort = {
    async listByParentSession() {
      return [
        {
          agentId: "agent_000",
          childSessionId: "sess_subagent_agent_000",
          agentType: "general-purpose",
          description: "history for agent_000",
          status: "completed",
          isBackgrounded: true,
          startedAt: STARTED_AT.getTime(),
          endedAt: STARTED_AT.getTime(),
        },
      ];
    },
  };

  const output = (await listAgentsToolEntry.handler({}, {
    runtimeTaskRegistry: registry,
    sessionId: "sess_parent",
    abortSignal: new AbortController().signal,
    subagentRosterPort: roster,
  } as never)) as ListAgentsOutput;
  const parsed = ListAgentsOutputSchema.parse(output);

  const evicted = parsed.agents.find((agent) => agent.agentId === "agent_000");
  assert.ok(evicted, "被驱逐的 agent 必须仍出现在列表里");
  assert.equal(evicted.source, "history");
  // 未驱逐的行仍是 live。
  assert.ok(
    parsed.agents.some((agent) => agent.agentId === "agent_059" && agent.source === "live"),
  );
});

test("驱逐后 task-output / stopTask 对未知 id 明确 not-found，不 crash", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  for (let index = 0; index < 60; index++) {
    registerTerminal(registry, index, new Date(STARTED_AT.getTime() + index * 1_000));
  }
  assert.equal(registry.get("agent_000"), undefined, "前置：最旧条目已被驱逐");

  // task-output：明确 TASK_NOT_FOUND 失败，不抛异常。
  const output = await taskOutputToolEntry.handler({ task_id: "agent_000" }, {
    runtimeTaskRegistry: registry,
    sessionId: "sess_parent",
    abortSignal: new AbortController().signal,
  } as never);
  assert.equal((output as { result?: boolean }).result, false);
  assert.match(String((output as { message?: string }).message), /No task found with ID/);

  // stopTask：无条目返回 undefined（上层映射 not-found），不 crash。
  const port = createExploreSubagentPort({
    runtimeTaskRegistry: registry,
    enqueueParentTaskNotification: () => undefined,
    emitParentEvent: async () => {},
    runExploreAgent: async () => await new Promise<never>(() => {}),
  });
  assert.equal(await port.stopTask("agent_000"), undefined);
});

test("pendingMessages 超限：queueMessage 拒绝并抛队列满错误", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registry.register({
    taskId: "agent_queue",
    agentId: "agent_queue",
    agentType: "general-purpose",
    childSessionId: "sess_subagent_agent_queue",
    description: "queue target",
    isBackgrounded: true,
    startedAt: STARTED_AT,
    status: "running",
    taskType: "local_agent",
    type: "local_agent",
  });

  for (let index = 0; index < MAX_PENDING_MESSAGES; index++) {
    registry.queueMessage("agent_queue", {
      id: `msg_${index}`,
      message: `payload ${index}`,
      queuedAt: new Date(),
    });
  }
  assert.equal(registry.get("agent_queue")?.pendingMessages?.length, MAX_PENDING_MESSAGES);

  assert.throws(
    () =>
      registry.queueMessage("agent_queue", {
        id: "msg_overflow",
        message: "overflow",
        queuedAt: new Date(),
      }),
    (error: unknown) =>
      error instanceof RuntimeTaskMessageQueueFullError && error.capacity === MAX_PENDING_MESSAGES,
  );
  // 拒绝是原子的：溢出那条不入队，队列保持原样。
  assert.equal(registry.get("agent_queue")?.pendingMessages?.length, MAX_PENDING_MESSAGES);

  // drain 后恢复容量：上限只挡堆积，不永久封死。
  const drained = registry.drainMessages("agent_queue");
  assert.equal(drained.length, MAX_PENDING_MESSAGES);
  registry.queueMessage("agent_queue", { id: "msg_after", message: "ok", queuedAt: new Date() });
  assert.equal(registry.get("agent_queue")?.pendingMessages?.length, 1);
});

test("SendMessage 队列满：错误如实传出（agent_queue_full），不假成功", async () => {
  const harness = await createSendMessageHarness();
  try {
    const task = await harness.port.start({
      sessionId: "sess_parent",
      turnId: "turn_1",
      parentToolCallId: "toolu_seat",
      agentType: "general-purpose",
      description: "队列满测试",
      prompt: "挂起",
      workingDirectory: "/tmp",
      workspaceRoot: "/tmp",
      trace: TRACE,
    } as never);
    // 等子会话 ready（此时无 messageSink 注册，SendMessage 走 queued 分支）。
    await harness.childStarted;

    const request: SubagentSendMessageRequest = {
      sessionId: "sess_parent",
      turnId: "turn_1",
      parentToolCallId: "toolu_msg",
      to: task.agentId,
      message: "补充任务",
      workingDirectory: "/tmp",
      workspaceRoot: "/tmp",
      trace: TRACE,
    };
    for (let index = 0; index < MAX_PENDING_MESSAGES; index++) {
      const result = await harness.port.sendMessage(request);
      assert.equal(result.status, "success");
      assert.equal(result.delivery, "queued");
    }

    const overflow = await harness.port.sendMessage(request);
    assert.equal(overflow.status, "failed");
    assert.equal(overflow.errorCode, "agent_queue_full");
    assert.match(String(overflow.message), /agent_queue_full/);
    assert.match(String(overflow.message), /NOT queued/);
  } finally {
    await harness.cleanup();
  }
});

interface SendMessageHarness {
  childStarted: Promise<void>;
  cleanup(): Promise<void>;
  port: ReturnType<typeof createExploreSubagentPort>;
}

async function createSendMessageHarness(): Promise<SendMessageHarness> {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-queue-"));
  let markStarted!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    markStarted = resolve;
  });

  const port = createExploreSubagentPort({
    outputRootDir,
    // 独立闸门：不污染进程级单例的计数。
    seatGate: createSubagentSeatGate(1),
    // 0 = 禁用看门狗：本测试的子任务故意永不结算，不留 600s 计时器拖住测试进程退出。
    inactivityTimeoutMs: 0,
    enqueueParentTaskNotification: () => undefined,
    emitParentEvent: async () => {},
    runExploreAgent: async (request) => {
      await request.onSessionReady?.();
      markStarted();
      return await new Promise<never>(() => {});
    },
  });

  return {
    childStarted,
    cleanup: () => rm(outputRootDir, { force: true, recursive: true }),
    port,
  };
}
