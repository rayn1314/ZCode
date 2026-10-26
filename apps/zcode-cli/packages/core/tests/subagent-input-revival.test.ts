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
  getInputRevivalBinding,
  registerInputRevivalBinding,
  releaseInputRevivalBindingsForSession,
  requestStopInputRevivalTurn,
} from "../src/subagent/input-revival-bridge.js";
import {
  createExploreSubagentPort,
  registerPersistedInputRevivalBinding,
  reviveSubagentTaskForInputTurn,
  settleSubagentInputRevivalFailure,
  settleSubagentInputRevivalSuccess,
  type ExploreSubagentPortOptions,
  type SubagentInputTurnHost,
} from "../src/subagent/runner.js";
import { restorePersistedSubagentInputRevival } from "../src/runtime/methods/resume.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import { SESSION_ENTRY_SUBAGENT_LIFECYCLE } from "@zcode/contracts";

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
    // 两条通知：开轮的复活可见性（spec D8）+ 终态结论。复活通知不 claim notified，
    // 所以终态通知照常入队。
    expect(harness.notifications).toHaveLength(2);
    expect(harness.notifications[0]).toMatchObject({ taskId: ids.agentId });
    expect(harness.notifications[0]?.text).toContain("<status>running</status>");
    expect(harness.notifications[0]?.text).toContain("was resumed and is running again");
    expect(harness.notifications[0]?.text).toContain("do not dispatch a duplicate agent");
    expect(harness.notifications[1]?.text).toContain("<status>completed</status>");
    expect(harness.notifications[1]?.text).toContain("<result>revived final answer</result>");
    expect(harness.notifications[1]?.text).toContain(
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
    expect(harness.notifications).toHaveLength(2);
    expect(harness.notifications[1]?.text).toContain("<status>failed</status>");
    expect(harness.notifications[1]?.text).toContain("provider exploded");
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
    // 复活可见性通知各一条；终态通知只结算一次（第二次 settle 撞守卫）。
    expect(harness.notifications).toHaveLength(2);
    expect(harness.notifications[1]?.text).toContain("<result>first</result>");
  });

  it("degrades to current behavior when no binding exists (spec D6)", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    // 父会话不在场（从未由本进程派发，也没有冷恢复登记）：复活与结算都不抛错、
    // 不产事件、不入通知。进程重启这条已由 D10 覆盖，不再是本用例的场景。
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
    // 复活可见性通知 + 恰好一条 stopped 终态通知。
    expect(harness.notifications).toHaveLength(2);
    expect(harness.notifications[0]?.text).toContain("<status>running</status>");
    expect(harness.notifications[1]?.text).toContain("<status>stopped</status>");

    // 停止后迟到的轮末结算撞终态守卫：不再产生第三条通知。
    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "late completion must be dropped",
    });
    expect(harness.notifications).toHaveLength(2);
    // stopTurn 消费即清：再次请求停止不会二次触发。
    requestStopInputRevivalTurn(ids.childSessionId);
    expect(host.stopCalls).toHaveLength(1);
  });
});

describe("跨进程复活（spec D10）", () => {
  let outputRootDir: string;

  beforeEach(async () => {
    outputRootDir = await mkdtemp(join(tmpdir(), "zcode-input-revival-persisted-"));
  });

  afterEach(async () => {
    await rm(outputRootDir, { recursive: true, force: true });
  });

  /** `readPersistedSubagentTask` 的重建形状：终态、已通知过、没有 outputFile / prompt。 */
  function persistedTerminalTask(ids: TestIds) {
    return {
      taskId: ids.agentId,
      agentId: ids.agentId,
      agentType: "general-purpose",
      childSessionId: ids.childSessionId,
      description: "revive target",
      isBackgrounded: true,
      notified: true,
      parentSessionId: ids.parentSessionId,
      parentToolCallId: ids.parentToolCallId,
      startedAt: new Date(Date.now() - 60_000),
      completedAt: new Date(Date.now() - 30_000),
      status: "interrupted" as const,
      taskType: "local_agent" as const,
      type: "local_agent" as const,
    };
  }

  it("父会话恢复时按 lifecycle entry 重建绑定，已存在的活绑定不覆盖", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    const entries = [
      {
        id: `subagent-lifecycle:${ids.agentId}`,
        sessionID: ids.parentSessionId,
        type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
        time: { created: Date.now(), updated: Date.now() },
        data: {
          agentId: ids.agentId,
          agentType: "general-purpose",
          childSessionId: ids.childSessionId,
          description: "revive target",
          status: "interrupted",
          startedAt: Date.now() - 1_000,
          endedAt: Date.now(),
          parentToolCallId: ids.parentToolCallId,
          background: true,
        },
      },
    ];
    const runtime = {
      sessionId: ids.parentSessionId,
      subagentPortOptions: harness.options,
      runtimeTaskRegistry: harness.registry,
      workingDirectory: outputRootDir,
      workspaceRoot: outputRootDir,
      rootTraceContext: { traceId: createTraceId(), sessionId: ids.parentSessionId },
    } as unknown as AgentRuntimeInternal;

    restorePersistedSubagentInputRevival.call(runtime, entries);

    const binding = getInputRevivalBinding<{
      agentId: string;
      request: SubagentRunRequest;
    }>(ids.childSessionId);
    expect(binding?.agentId).toBe(ids.agentId);
    expect(binding?.request).toMatchObject({
      sessionId: ids.parentSessionId,
      parentToolCallId: ids.parentToolCallId,
      agentType: "general-purpose",
      description: "revive target",
      // 原文 prompt 不落 entry，留给复活开轮时从子会话历史补回。
      prompt: "",
    });

    // 同进程派发/续跑已经登记过的子会话：重建不得覆盖活绑定（它带着活请求与 sink）。
    const liveRequest = { ...ids.request, prompt: "live dispatch prompt" };
    const replaced = registerPersistedInputRevivalBinding({
      options: harness.options,
      registry: harness.registry,
      request: liveRequest,
      agentId: ids.agentId,
      childSessionId: ids.childSessionId,
      parentSessionId: ids.parentSessionId,
    });
    expect(replaced).toBe(false);
    expect(
      getInputRevivalBinding<{ request: SubagentRunRequest }>(ids.childSessionId)?.request.prompt,
    ).toBe("");
  });

  it("注册表为空但持久化里有终态快照时仍复活并结算（含 prompt 补回）", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    harness.options.findPersistedSubagentTask = async (agentId) =>
      agentId === ids.agentId ? persistedTerminalTask(ids) : undefined;
    // 冷恢复重建的绑定；注册表故意留空，模拟新进程。
    bindingFor(harness, ids);
    const context = turnContext(ids);
    const host = createHost();
    host.readInitialPrompt = () => "original dispatch prompt";

    await reviveSubagentTaskForInputTurn(ids.childSessionId, host, context);

    const revived = harness.registry.get(ids.agentId);
    expect(revived?.status).toBe("running");
    expect(revived?.inputRevival).toBe(true);
    expect(revived?.notified).toBe(false);
    expect(revived?.parentToolCallId).toBe(ids.parentToolCallId);
    expect(harness.notifications).toHaveLength(1);
    expect(harness.notifications[0]?.text).toContain("was resumed and is running again");

    await settleSubagentInputRevivalSuccess(ids.childSessionId, context, {
      events: [],
      response: "revived after restart",
    });

    expect(harness.notifications).toHaveLength(2);
    expect(harness.notifications[1]?.text).toContain("<status>completed</status>");
    expect(harness.notifications[1]?.text).toContain("<result>revived after restart</result>");
    expect(harness.registry.get(ids.agentId)?.status).toBe("completed");
    // metadata 的 prompt 由子会话历史补回，不被空串覆盖（D10 边界 2）。
    const metadata = JSON.parse(
      await readFile(join(outputRootDir, ids.parentSessionId, ids.agentId, "metadata.json"), "utf8"),
    ) as { prompt?: string; status?: string };
    expect(metadata.prompt).toBe("original dispatch prompt");
    expect(metadata.status).toBe("completed");
  });

  it("持久化快照仍是非终态时不复活（那是本进程正在跑的语义）", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    harness.options.findPersistedSubagentTask = async () => ({
      ...persistedTerminalTask(ids),
      status: "running" as const,
    });
    bindingFor(harness, ids);

    await reviveSubagentTaskForInputTurn(ids.childSessionId, createHost(), turnContext(ids));

    expect(harness.registry.get(ids.agentId)).toBeUndefined();
    expect(harness.notifications).toHaveLength(0);
    expect(harness.emitted).toHaveLength(0);
  });

  it("父 runtime 关闭时只释放自己名下的绑定", async () => {
    const ids = createIds(outputRootDir);
    const otherIds = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    const parentA = createSessionId("release-parent-a");
    const parentB = createSessionId("release-parent-b");
    registerInputRevivalBinding({
      agentId: ids.agentId,
      childSessionId: ids.childSessionId,
      parentSessionId: parentA,
      options: harness.options,
      registry: harness.registry,
      request: ids.request,
    });
    registerInputRevivalBinding({
      agentId: otherIds.agentId,
      childSessionId: otherIds.childSessionId,
      parentSessionId: parentB,
      options: harness.options,
      registry: harness.registry,
      request: otherIds.request,
    });

    releaseInputRevivalBindingsForSession(parentA);

    expect(getInputRevivalBinding(ids.childSessionId)).toBeUndefined();
    expect(getInputRevivalBinding(otherIds.childSessionId)).toBeDefined();
    // 收尾：桥是进程级登记表，别把本用例的绑定留给后续用例。
    releaseInputRevivalBindingsForSession(parentB);
    expect(getInputRevivalBinding(otherIds.childSessionId)).toBeUndefined();
  });
});

describe("派发生存边界（spec send-queued-now-preempt-semantics.md D3）", () => {
  let outputRootDir: string;

  beforeEach(async () => {
    outputRootDir = await mkdtemp(join(tmpdir(), "zcode-dispatch-survival-"));
  });

  afterEach(async () => {
    await rm(outputRootDir, { recursive: true, force: true });
  });

  it("后台 start 派发不链接父 turn signal：父中止后任务存活，终止权只归 TaskStop", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    // 桩先上报 session ready（真实链路 persist-before-spawn 由 AgentRuntime 调用），
    // 再挂起不结束，才能观察「父中止后任务是否还活着」。
    harness.options.runExploreAgent = async (agentRequest) => {
      await agentRequest.onSessionReady?.();
      return new Promise(() => {}) as never;
    };
    const port = createExploreSubagentPort(harness.options);
    const abortController = new AbortController();

    const started = await port.start?.(ids.request, { signal: abortController.signal });
    expect(started?.agentId).toBe(ids.agentId);
    expect(harness.registry.get(ids.agentId)?.status).toBe("running");

    // 「立即发送」抢占 = 父 turn abort：后台派发即句柄（派发后 taskAbort 不挂父 signal），
    // 父轮中止不得连带子代理陪葬；现在 stopActiveForegroundExecution 只 abort 父轮本身。
    abortController.abort(new Error("parent turn preempted by sendQueuedNow"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(harness.registry.get(ids.agentId)?.status).toBe("running");

    // 终止权仍归 TaskStop（owner=父 runtime registry + TaskStop，不经父 signal）。
    const stopped = await port.stopTask?.(ids.agentId);
    expect(stopped?.status).toBe("killed");
    expect(harness.notifications).toHaveLength(1);
  });

  it("前台 wait 派发的 taskAbort 链接父 signal：父中止即取消（现状契约）", async () => {
    const ids = createIds(outputRootDir);
    const harness = createHarness(outputRootDir, ids);
    harness.options.runExploreAgent = async (agentRequest) => {
      await agentRequest.onSessionReady?.();
      return new Promise(() => {}) as never;
    };
    const port = createExploreSubagentPort(harness.options);
    const abortController = new AbortController();

    // 前台 wait = 父轮内的工具调用，随父轮取消而失败是正确语义（D3 上分支）。
    const promise = port.run(ids.request, { signal: abortController.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    abortController.abort(new Error("parent turn preempted by sendQueuedNow"));
    await expect(promise).rejects.toThrow("cancel");
  });
});
