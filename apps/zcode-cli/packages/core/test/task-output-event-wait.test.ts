import assert from "node:assert/strict";
import test from "node:test";

import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { taskOutputToolEntry } from "../src/tool/handlers/task-output.js";

/**
 * TaskOutput 阻塞等待的事件化契约（spec: core/spec/background-task-event-wait.md）：
 * - 主路径是 registry 终态事件，不再 100ms 忙轮询——mock setTimeout 且不 tick 的情况下
 *   也要能收口（实现若依赖节拍会挂到 within 超时）；
 * - 超时语义不变：按配置 timeout 返回 timeout + 当前快照，timeout<=0 立即短路；
 * - 「注册后、开始等之前」落终态不漏：入口 get 兜住，waitForTerminal 对已终态立即 resolve；
 * - abort 抛与旧实现同形的 AbortError，且撤下 registry waiter（terminalWaiters 不残留）；
 * - TaskStop 落 killed 终态即中断等待，按 success 收口并认领 notified。
 */

// 必须在启用 mock timers 之前抓取真实定时器：within 的超时兜底不能被 mock 吃掉。
const realSetTimeout = globalThis.setTimeout;

/** 用真实定时器给关键等待加兜底：事件没来时给出明确失败，而不是挂死测试。 */
function within<T>(promise: Promise<T>, label: string, ms = 5_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new Error(`等待超时：${label}`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** 推进真实事件循环，让 handler 走到 waitForTerminal 挂上 waiter（mock timers 不影响它）。 */
function flushEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function registerRunningTask(registry: InMemoryRuntimeTaskRegistry, taskId: string): void {
  registry.register({
    taskId,
    agentId: taskId,
    agentType: "general-purpose",
    childSessionId: `sub_${taskId}`,
    description: "等待终态的后台任务",
    isBackgrounded: true,
    startedAt: new Date(),
    status: "running",
    taskType: "local_agent",
    type: "local_agent",
  });
}

function callTaskOutput(
  registry: InMemoryRuntimeTaskRegistry,
  input: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<unknown> {
  return taskOutputToolEntry.handler(input, {
    runtimeTaskRegistry: registry,
    sessionId: "sess_wait_test",
    abortSignal: abortSignal ?? new AbortController().signal,
  } as never);
}

function terminalWaiterKeys(registry: InMemoryRuntimeTaskRegistry): number {
  return (registry as unknown as { terminalWaiters: Map<string, Set<unknown>> }).terminalWaiters
    .size;
}

interface TaskOutputOutcome {
  retrieval_status: string;
  task: { status: string; task_id?: string } | null;
}

test("阻塞等待：终态事件一到立即返回，不等 100ms 轮询节拍", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    const registry = new InMemoryRuntimeTaskRegistry();
    registerRunningTask(registry, "task_evt");

    const promise = callTaskOutput(registry, { task_id: "task_evt", block: true, timeout: 30_000 });
    // 进到等待：handler 已挂上 waitForTerminal；此刻 mock 下没有任何 tick 可用。
    await flushEventLoop();

    registry.update("task_evt", (task) => ({
      ...task,
      status: "completed",
      completedAt: new Date(),
    }));

    const output = (await within(promise, "终态事件唤醒等待", 3_000)) as TaskOutputOutcome;
    assert.equal(output.retrieval_status, "success");
    assert.equal(output.task?.status, "completed");
    // 完成结果已交付的 claim：notified 被认领，后续 completion notification 不重复。
    assert.equal(registry.get("task_evt")?.notified, true);
    // 收口：waiter 已结算，不残留。
    assert.equal(terminalWaiterKeys(registry), 0);
  } finally {
    t.mock.timers.reset();
  }
});

test(
  "阻塞等待：超时按配置返回 timeout 快照，timeout<=0 立即短路",
  { timeout: 10_000 },
  async () => {
    const registry = new InMemoryRuntimeTaskRegistry();
    registerRunningTask(registry, "task_timeout");

    const startedAt = Date.now();
    const output = (await within(
      callTaskOutput(registry, { task_id: "task_timeout", block: true, timeout: 40 }),
      "配置超时返回",
      3_000,
    )) as TaskOutputOutcome;
    const elapsed = Date.now() - startedAt;
    assert.equal(output.retrieval_status, "timeout");
    assert.equal(output.task?.status, "running");
    // 至少等到配置的超时才放弃（留抖动余量）。
    assert.ok(elapsed >= 35, `应等满配置超时，实际 ${elapsed}ms`);

    // timeout<=0：不进等待、不查节拍，直接回当前快照（旧轮询语义）。
    const immediate = (await within(
      callTaskOutput(registry, { task_id: "task_timeout", block: true, timeout: 0 }),
      "timeout<=0 短路",
      3_000,
    )) as TaskOutputOutcome;
    assert.equal(immediate.retrieval_status, "timeout");
    assert.equal(immediate.task?.status, "running");
  },
);

test("阻塞等待：注册后立刻终态不漏（进等待前的窗口）", { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  try {
    // (a) handler 被调用之前任务已终态：入口 get 直接命中。
    const registryA = new InMemoryRuntimeTaskRegistry();
    registerRunningTask(registryA, "task_pre");
    registryA.update("task_pre", (task) => ({
      ...task,
      status: "completed",
      completedAt: new Date(),
    }));
    const pre = (await within(
      callTaskOutput(registryA, { task_id: "task_pre", block: true, timeout: 30_000 }),
      "调用前已终态",
      3_000,
    )) as TaskOutputOutcome;
    assert.equal(pre.retrieval_status, "success");
    assert.equal(pre.task?.status, "completed");

    // (b) handler 同帧（emitWaitingProgress 的 await 窗口内）落终态：waiter 挂上之前已终态。
    const registryB = new InMemoryRuntimeTaskRegistry();
    registerRunningTask(registryB, "task_same_tick");
    const sameTick = callTaskOutput(registryB, {
      task_id: "task_same_tick",
      block: true,
      timeout: 30_000,
    });
    registryB.update("task_same_tick", (task) => ({
      ...task,
      status: "completed",
      completedAt: new Date(),
    }));
    const b = (await within(sameTick, "同帧终态", 3_000)) as TaskOutputOutcome;
    assert.equal(b.retrieval_status, "success");
    assert.equal(b.task?.status, "completed");

    // 底层契约：waitForTerminal 对已终态立即 resolve，不注册 waiter（handler 依赖的收口保证）。
    const settled = await registryB.waitForTerminal("task_same_tick");
    assert.equal(settled?.status, "completed");
    assert.equal(terminalWaiterKeys(registryB), 0);
  } finally {
    t.mock.timers.reset();
  }
});

test(
  "阻塞等待：abort 以 AbortError 收口并撤 waiter；TaskStop 落终态即返回",
  { timeout: 10_000 },
  async () => {
    // abort：等待中取消 → 与旧 throwIfAborted 同形的 AbortError，且 terminalWaiters 不残留。
    const registryAbort = new InMemoryRuntimeTaskRegistry();
    registerRunningTask(registryAbort, "task_abort");
    const controller = new AbortController();
    const aborting = callTaskOutput(
      registryAbort,
      { task_id: "task_abort", block: true, timeout: 30_000 },
      controller.signal,
    );
    await flushEventLoop();
    assert.equal(terminalWaiterKeys(registryAbort), 1, "前置：waiter 已挂上");
    controller.abort();
    await assert.rejects(
      within(aborting, "abort 收口", 3_000),
      (error: Error) => error.name === "AbortError",
      "等待应以 AbortError 收口",
    );
    assert.equal(terminalWaiterKeys(registryAbort), 0, "abort 后不应残留终态 waiter");

    // TaskStop：registry 落 killed 终态 → 等待被事件中断，按 success 返回并认领 notified。
    const registryStop = new InMemoryRuntimeTaskRegistry();
    registerRunningTask(registryStop, "task_stop");
    const stopping = callTaskOutput(registryStop, {
      task_id: "task_stop",
      block: true,
      timeout: 30_000,
    });
    await flushEventLoop();
    registryStop.update("task_stop", (task) => ({
      ...task,
      status: "killed",
      completedAt: new Date(),
    }));
    const stopped = (await within(stopping, "TaskStop 中断等待", 3_000)) as TaskOutputOutcome;
    assert.equal(stopped.retrieval_status, "success");
    assert.equal(stopped.task?.status, "killed");
    assert.equal(registryStop.get("task_stop")?.notified, true);
    assert.equal(terminalWaiterKeys(registryStop), 0);
  },
);
