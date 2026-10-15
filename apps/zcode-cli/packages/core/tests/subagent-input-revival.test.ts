import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  SessionEventType,
  createSessionId,
  createTraceId,
  createTurnId,
  type SessionEvent,
  type SessionId,
  type SubagentRunRequest,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import {
  registerInputRevivalBinding,
  requestStopInputRevivalTurn,
} from "../src/subagent/input-revival-bridge.js";
import {
  createExploreSubagentPort,
  reviveSubagentTaskForInputTurn,
  settleSubagentInputRevivalFailure,
  settleSubagentInputRevivalSuccess,
  type ExploreSubagentPortOptions,
  type SubagentInputTurnHost,
} from "../src/subagent/runner.js";

// 复活桥是进程级登记表，测试之间不清理：每个用例用独立 ID，避免残留绑定串扰。
interface TestIds {
  agentId: string;
  childSessionId: SessionId;
  outputFile: string;
  parentSessionId: SessionId;
  parentToolCallId: string;
  request: SubagentRunRequest;
}

function createIds(outputRootDir: string): TestIds {
  // 与端口缺省同构（`agent_<uuid>`），保证每个用例的桥键唯一。
  const agentId = `agent_${randomUUID()}`;
  const parentSessionId = createSessionId("parent");
  const parentToolCallId = `toolu_${agentId}`;
  return {
    agentId,
    childSessionId: createSessionId(`subagent_${agentId}`),
    outputFile: join(outputRootDir, parentSessionId, agentId, "output.txt"),
    parentSessionId,
    parentToolCallId,
    request: {
      sessionId: parentSessionId,
      parentToolCallId,
      agentType: "general-purpose",
      description: "revive target",
      prompt: "original dispatch prompt",
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
      trace: { traceId: createTraceId(), sessionId: parentSessionId },
    },
  };
}

interface Harness {
  emitted: SessionEvent[];
  notifications: { taskId?: string; text: string }[];
  options: ExploreSubagentPortOptions;
  registry: InMemoryRuntimeTaskRegistry;
}

function createHarness(outputRootDir: string, ids: TestIds): Harness {
  const emitted: SessionEvent[] = [];
  const notifications: { taskId?: string; text: string }[] = [];
  const registry = new InMemoryRuntimeTaskRegistry();
  const options: ExploreSubagentPortOptions = {
    runExploreAgent: async () => ({ events: [], response: "", traceId: createTraceId() }),
    emitParentEvent: async (event) => {
      emitted.push(event);
    },
    enqueueParentTaskNotification: (notification) => {
      notifications.push({ taskId: notification.taskId, text: notification.text });
    },
    getProfiles: () => [
      { name: "general-purpose", description: "do things", source: "built-in", systemPrompt: "" },
    ],
    outputRootDir,
    // 派发执行体的 agentId 必须确定，否则注册表键与断言对不上。
    createAgentId: () => ids.agentId,
    // 必须注入同一份 registry：缺省会让端口自建第二个 InMemory 注册表，断言全部落空。
    runtimeTaskRegistry: registry,
    // 这些单测只覆盖生命周期挂钩，模型面用不到；超时放宽避免误触发活动看门狗。
    inactivityTimeoutMs: 60_000,
  };
  return { emitted, notifications, options, registry };
}

function terminalFailedTask(ids: TestIds) {
  return {
    taskId: ids.agentId,
    agentId: ids.agentId,
    agentType: "general-purpose",
    childSessionId: ids.childSessionId,
    description: "revive target",
    isBackgrounded: false,
    notified: true,
    outputFile: ids.outputFile,
    parentSessionId: ids.parentSessionId,
    parentToolCallId: ids.parentToolCallId,
    prompt: "original dispatch prompt",
    startedAt: new Date(Date.now() - 60_000),
    status: "failed" as const,
    error: "Background agent task stopped.",
    taskType: "local_agent" as const,
    type: "local_agent" as const,
  };
}

function bindingFor(harness: Harness, ids: TestIds): void {
  registerInputRevivalBinding({
    agentId: ids.agentId,
    childSessionId: ids.childSessionId,
    parentSessionId: ids.parentSessionId,
    options: harness.options,
    registry: harness.registry,
    request: ids.request,
  });
}

function turnContext(ids: TestIds) {
  return {
    turnId: createTurnId(),
    traceContext: { traceId: createTraceId(), sessionId: ids.childSessionId },
  };
}

function createHost(): SubagentInputTurnHost & {
  stopCalls: string[];
  steerTurn: ReturnType<typeof vi.fn>;
} {
  const stopCalls: string[] = [];
  const steerTurn = vi.fn(async () => ({
    kind: "rejected" as const,
    reason: "no_active_turn" as const,
  }));
  return {
    stopCalls,
    steerTurn,
    stopActiveForegroundExecution: (options?: { reason?: string }) => {
      stopCalls.push(options?.reason ?? "");
      return { kind: "stopped" as const, foregroundExecutionId: "exec_1" };
    },
  };
}

describe("subagent input revival (复活归一)", () => {
  let outputRootDir: string;

  beforeEach(async () => {
    outputRootDir = await mkdtemp(join(tmpdir(), "zcode-input-revival-"));
  });

  afterEach(async () => {
    await rm(outputRootDir, { recursive: true, force: true });
  });

  it("dispatch run registers the revival binding and its lifecycle settles through finalize*", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    const port = createExploreSubagentPort(harness.options);
    harness.options.runExploreAgent = async () => ({
      events: [],
      response: "dispatch result",
      traceId: createTraceId(),
    });

    const output = await port.run(ids.request);
    expect(output.status).toBe("completed");

    // 前台派发轮：结果走工具返回，runner 不发 task-notification；注册表落 completed，
    // 复活绑定已随快照注册（这是本用例的关键前提）。
    const afterDispatch = harness.registry.get(ids.agentId);
    expect(afterDispatch?.status).toBe("completed");
    expect(harness.notifications).toHaveLength(0);

    // 用户手动中断：模拟 stopTask/失败留下的终态（已通知过父）。
    harness.registry.update(ids.agentId, (task) => ({
      ...task,
      status: "failed",
      notified: true,
      error: "Background agent task stopped.",
      completedAt: new Date(),
    }));

    // 输入复活（A1 前半）：重新注册 running、补发 resumed Spawned。
    const context = turnContext(ids);
    const host = createHost();
    await reviveSubagentTaskForInputTurn(ids.childSessionId, host, context);
    const revived = harness.registry.get(ids.agentId);
    expect(revived?.status).toBe("running");
    expect(revived?.inputRevival).toBe(true);
    expect(revived?.notified).toBe(false);
    expect(revived?.parentToolCallId).toBe(ids.parentToolCallId);
    expect(revived?.turnId).toBe(context.turnId);
    const spawnedEvents = harness.emitted.filter(
      (event) => event.type === SessionEventType.SubagentSpawned,
    );
    expect(spawnedEvents).toHaveLength(2);
    expect(spawnedEvents[1]?.payload).toMatchObject({
      agentId: ids.agentId,
      parentToolCallId: ids.parentToolCallId,
      resumed: true,
      status: "running",
    });
    // 投影追齐（spec D7）：复活补发 BackgroundTaskStarted(running)，否则投影永久停在
    // 旧生命终态（TaskStop 拒绝、面板显示已结束）。
    const startedEvents = harness.emitted.filter(
      (event) => event.type === SessionEventType.BackgroundTaskStarted,
    );
    expect(startedEvents.length).toBeGreaterThanOrEqual(1);
    expect(startedEvents.at(-1)?.payload).toMatchObject({
      childSessionId: ids.childSessionId,
      status: "running",
      taskKind: "subagent",
      taskId: ids.agentId,
      toolCallId: ids.parentToolCallId,
      toolName: "Agent",
    });

    // 复活轮跑完（A1 后半）：走 finalize* 发通知，正文为新结论、锚点=原始 Agent 卡片。
    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "revived final answer",
    });
    const settled = harness.registry.get(ids.agentId);
    expect(settled?.status).toBe("completed");
    expect(settled?.notified).toBe(true);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain("<status>completed</status>");
    expect(harness.notifications[0]?.text).toContain("<result>revived final answer</result>");
    expect(harness.notifications[0]?.text).toContain(
      `<tool-use-id>${ids.parentToolCallId}</tool-use-id>`,
    );
    const written = await readFile(ids.outputFile, "utf8");
    expect(written).toContain("revived final answer");
  });

  it("revival failure settles as failed with the error surfaced to the parent", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    bindingFor(harness, ids);
    harness.registry.register(terminalFailedTask(ids));
    const context = turnContext(ids);
    await reviveSubagentTaskForInputTurn(ids.childSessionId, createHost(), context);

    await settleSubagentInputRevivalFailure(
      ids.childSessionId,
      context,
      new Error("provider exploded"),
    );

    const task = harness.registry.get(ids.agentId);
    expect(task?.status).toBe("failed");
    expect(task?.notified).toBe(true);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain("<status>failed</status>");
    expect(harness.notifications[0]?.text).toContain("provider exploded");
  });

  it("runner-held turns are untouched: no revive on non-terminal, no settle without inputRevival", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    bindingFor(harness, ids);
    // runner 执行体持有的轮：running 且无 inputRevival 标记。
    harness.registry.register({
      ...terminalFailedTask(ids),
      status: "running",
      notified: false,
      error: undefined,
    });

    const context = turnContext(ids);
    await reviveSubagentTaskForInputTurn(ids.childSessionId, createHost(), context);
    const task = harness.registry.get(ids.agentId);
    expect(task?.status).toBe("running");
    expect(task?.inputRevival).toBeUndefined();

    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "must not be delivered twice",
    });
    await settleSubagentInputRevivalFailure(ids.childSessionId, context, new Error("nope"));
    expect(harness.notifications).toHaveLength(0);
    expect(harness.registry.get(ids.agentId)?.status).toBe("running");
  });

  it("settle is idempotent: a second settle after a terminal one is a no-op", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    bindingFor(harness, ids);
    harness.registry.register(terminalFailedTask(ids));
    const context = turnContext(ids);
    await reviveSubagentTaskForInputTurn(ids.childSessionId, createHost(), context);

    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "first",
    });
    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "duplicate",
    });
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain("<result>first</result>");
  });

  it("degrades to current behavior when no binding exists (spec D6)", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    // 未登记的子会话（如进程重启后）：复活与结算都不抛错、不产事件、不入通知。
    const context = turnContext(ids);
    await expect(
      reviveSubagentTaskForInputTurn(ids.childSessionId, createHost(), context),
    ).resolves.toBeUndefined();
    await expect(
      settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
        events: [],
        response: "nobody hears this",
      }),
    ).resolves.toBeUndefined();
    expect(harness.emitted).toHaveLength(0);
    expect(harness.notifications).toHaveLength(0);
  });

  it("stopTask on a revived task stops the real turn and leaves exactly one stopped notification", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    bindingFor(harness, ids);
    harness.registry.register(terminalFailedTask(ids));
    const context = turnContext(ids);
    const host = createHost();
    await reviveSubagentTaskForInputTurn(ids.childSessionId, host, context);
    expect(harness.registry.get(ids.agentId)?.status).toBe("running");

    const port = createExploreSubagentPort(harness.options);
    const stopped = await port.stopTask?.(ids.agentId);
    expect(stopped?.status).toBe("killed");
    // 真实执行的轮经桥 stopTurn 停掉（A6）。
    expect(host.stopCalls).toHaveLength(1);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain("<status>stopped</status>");

    // 停止后迟到的轮末结算撞终态守卫：不再产生第二条通知。
    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "late completion must be dropped",
    });
    expect(harness.notifications).toHaveLength(1);
    // stopTurn 消费即清：再次请求停止不会二次触发。
    requestStopInputRevivalTurn(ids.childSessionId);
    expect(host.stopCalls).toHaveLength(1);
  });
});
