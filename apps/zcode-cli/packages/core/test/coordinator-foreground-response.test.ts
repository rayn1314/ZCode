import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { enqueueSubagentMessage } from "../src/runtime/methods/subagent-messages.js";
import { createCoordinatorResponsePort } from "../src/subagent/coordinator-response.js";
import type { EnqueueSubagentMessageInput } from "../src/runtime/types.js";

/**
 * 核心契约（回归背景：2026-10-01 前台 Agent 互等死锁，主会话 25 分钟零模型请求）：
 * 子代理回复入队后，若协调者仍前台等待本子代理，必须用 requestBackground 放行这次等待
 * （Agent 工具先返回 async_launched，回复才能被消费）；借用前台模型覆盖的运行没有
 * background waiter，必须如实报告 busy，不得假装释放。stale 分支丢弃消息且不触碰 registry。
 */

function createInput(overrides?: Partial<EnqueueSubagentMessageInput>): EnqueueSubagentMessageInput {
  return {
    responseId: "response_test_1",
    agentId: "agent_test_1",
    agentType: "coder",
    childSessionId: "sess_child",
    childToolCallId: "toolu_child_1",
    summary: "进展同步",
    message: "需要补丁路径",
    traceContext: {
      traceId: "trace_1",
      spanId: "span_1",
      parentSpanId: undefined,
      sessionId: "sess_parent",
      turnId: "turn_1",
    },
    ...overrides,
  };
}

function createRuntime(registry: InMemoryRuntimeTaskRegistry) {
  const enqueuedCommands: unknown[] = [];
  const runtime = {
    runtimeTaskRegistry: registry,
    branchGeneration: 0,
    logger: undefined,
    runtimeCommandQueue: { size: () => 0 },
    enqueueRuntimeCommand: (command: unknown) => {
      enqueuedCommands.push(command);
    },
  };
  return { runtime, enqueuedCommands };
}

function registerForegroundTask(
  registry: InMemoryRuntimeTaskRegistry,
  overrides?: { foregroundModelOverride?: boolean; status?: "running" | "completed" },
): void {
  registry.register({
    taskId: "agent_test_1",
    agentId: "agent_test_1",
    agentType: "coder",
    description: "专职实现者",
    isBackgrounded: false,
    status: overrides?.status ?? "running",
    startedAt: new Date(),
    childSessionId: "sess_child",
    taskType: "local_agent",
    type: "local_agent",
    ...(overrides?.foregroundModelOverride ? { foregroundModelOverride: true } : {}),
  } as Parameters<InMemoryRuntimeTaskRegistry["register"]>[0]);
}

test("协调者前台等待时：入队成功并把等待转后台", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime, enqueuedCommands } = createRuntime(registry);
  registerForegroundTask(registry);

  const result = enqueueSubagentMessage.call(runtime as never, createInput());

  assert.deepEqual(result, { foregroundWaitReleased: true });
  assert.equal(enqueuedCommands.length, 1);
  assert.equal(registry.get("agent_test_1")?.isBackgrounded, true);
});

test("借用前台模型覆盖：入队成功但不假装释放，如实报告 busy", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime, enqueuedCommands } = createRuntime(registry);
  registerForegroundTask(registry, { foregroundModelOverride: true });

  const result = enqueueSubagentMessage.call(runtime as never, createInput());

  assert.deepEqual(result, { foregroundWaitReleased: false, foregroundWaitBusy: true });
  assert.equal(enqueuedCommands.length, 1);
  // requestBackground 不得被调用：runner 对这种运行不认 background 请求。
  assert.equal(registry.get("agent_test_1")?.isBackgrounded, false);
});

test("任务已后台：正常入队，无放行动作", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime, enqueuedCommands } = createRuntime(registry);
  registerForegroundTask(registry);
  assert.equal(registry.requestBackground("agent_test_1"), true);

  const result = enqueueSubagentMessage.call(runtime as never, createInput());

  assert.equal(result, undefined);
  assert.equal(enqueuedCommands.length, 1);
});

test("任务已终态：正常入队，无放行动作", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime, enqueuedCommands } = createRuntime(registry);
  registerForegroundTask(registry, { status: "completed" });

  const result = enqueueSubagentMessage.call(runtime as never, createInput());

  assert.equal(result, undefined);
  assert.equal(enqueuedCommands.length, 1);
});

test("任务不在注册表：正常入队，无放行动作", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime, enqueuedCommands } = createRuntime(registry);

  const result = enqueueSubagentMessage.call(runtime as never, createInput());

  assert.equal(result, undefined);
  assert.equal(enqueuedCommands.length, 1);
});

test("stale branch：消息被丢弃，不触碰 registry", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime, enqueuedCommands } = createRuntime(registry);
  // rewind 后 runtime 进入新分支时代：task 携带旧时代章，与 runtime 当前时代不一致。
  registry.setActiveBranchGeneration(3);
  registerForegroundTask(registry);
  (runtime as { branchGeneration: number }).branchGeneration = 4;

  const result = enqueueSubagentMessage.call(runtime as never, createInput());

  assert.equal(result, undefined);
  assert.equal(enqueuedCommands.length, 0);
  assert.equal(registry.get("agent_test_1")?.isBackgrounded, false);
});

test("port 集成：前台等待被放行时 respond 返回 released", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime } = createRuntime(registry);
  registerForegroundTask(registry);
  const port = createCoordinatorResponsePort({
    agentId: "agent_test_1",
    agentType: "coder",
    childSessionId: "sess_child",
    enqueue: (input) => enqueueSubagentMessage.call(runtime as never, input),
  });

  const result = port.respond({
    childToolCallId: "toolu_child_1",
    summary: "进展同步",
    message: "需要补丁路径",
    trace: createInput().traceContext,
  });

  assert.equal(result.status, "success");
  assert.equal(result.coordinatorAttention, "released");
  assert.equal(registry.get("agent_test_1")?.isBackgrounded, true);
});

test("port 集成：busy 时 respond 返回诚实文案", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime } = createRuntime(registry);
  registerForegroundTask(registry, { foregroundModelOverride: true });
  const port = createCoordinatorResponsePort({
    agentId: "agent_test_1",
    agentType: "coder",
    childSessionId: "sess_child",
    enqueue: (input) => enqueueSubagentMessage.call(runtime as never, input),
  });

  const result = port.respond({
    childToolCallId: "toolu_child_2",
    summary: "进展同步",
    message: "需要补丁路径",
    trace: createInput().traceContext,
  });

  assert.equal(result.status, "success");
  assert.equal(result.coordinatorAttention, "busy");
  assert.match(result.message, /Do not wait for a reply/);
  assert.equal(registry.get("agent_test_1")?.isBackgrounded, false);
});

test("port 集成：任务不在注册表时保持原有排队语义", () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const { runtime } = createRuntime(registry);
  const port = createCoordinatorResponsePort({
    agentId: "agent_test_1",
    agentType: "coder",
    childSessionId: "sess_child",
    enqueue: (input) => enqueueSubagentMessage.call(runtime as never, input),
  });

  const result = port.respond({
    childToolCallId: "toolu_child_3",
    summary: "进展同步",
    message: "需要补丁路径",
    trace: createInput().traceContext,
  });

  assert.equal(result.status, "success");
  assert.equal(result.coordinatorAttention, undefined);
  assert.equal(result.message, "Response was queued for the coordinator.");
});
