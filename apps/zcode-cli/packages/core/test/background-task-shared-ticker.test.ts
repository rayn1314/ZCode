import assert from "node:assert/strict";
import test from "node:test";

import { SessionEventType, type SessionEvent, type TraceContext } from "@zcode/contracts";

import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { BackgroundTaskTracker } from "../src/tool/executor/background-tasks.js";
import type { ToolExecutorDeps } from "../src/tool/executor/types.js";

/**
 * 后台任务共享 ticker 契约（spec: core/spec/background-task-event-wait.md）：
 * - N 个后台任务只建 1 个 1Hz setInterval（不再 per-task 起表），每拍对活跃任务各 poll 一次；
 * - 最后一个任务落终态时 clearInterval 停表；活跃集合空了 ticker 不常驻；
 * - unref 保持：后台轮询不阻止进程退出。
 *
 * 替换全局 setInterval 为「记录回调、不真实起表」的假表：测试手动触发拍子，完全确定。
 */

/** 推进真实事件循环若干轮，让 poll 的微任务链结算完（假表不占用定时器）。 */
async function flushEventLoop(rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("多个后台任务共享单个 1Hz ticker，全终态后停表", { timeout: 10_000 }, async (t) => {
  const intervalsMs: number[] = [];
  const tickCallbacks: Array<() => void> = [];
  const clearedHandles: unknown[] = [];
  let unrefCalls = 0;

  const fakeSetInterval = ((callback: () => void, ms?: number): NodeJS.Timeout => {
    tickCallbacks.push(callback);
    intervalsMs.push(ms ?? 0);
    return {
      unref() {
        unrefCalls += 1;
      },
    } as unknown as NodeJS.Timeout;
  }) as unknown as typeof globalThis.setInterval;
  const fakeClearInterval = ((handle: NodeJS.Timeout): void => {
    clearedHandles.push(handle);
  }) as unknown as typeof globalThis.clearInterval;
  t.mock.method(globalThis, "setInterval", fakeSetInterval);
  t.mock.method(globalThis, "clearInterval", fakeClearInterval);

  type StubSnapshot = {
    taskId: string;
    status: "running" | "completed";
    startedAt: Date;
    completedAt?: Date;
  };
  const snapshots = new Map<string, StubSnapshot>();
  const pollCalls = new Map<string, number>();
  const events: SessionEvent[] = [];
  const registry = new InMemoryRuntimeTaskRegistry();

  const getBackgroundTask = async (taskId: string): Promise<StubSnapshot | undefined> => {
    pollCalls.set(taskId, (pollCalls.get(taskId) ?? 0) + 1);
    return snapshots.get(taskId);
  };

  const deps = {
    registry: {} as never,
    permissionService: {} as never,
    permissionBroker: {} as never,
    emitEvent: async (event: SessionEvent) => {
      events.push(event);
    },
    sessionId: "sess_ticker",
    defaultTimeoutMs: 30_000,
    readFileState: {},
    getWorkingDirectory: () => "E:/tmp",
    getWorkspaceRoot: () => "E:/tmp",
    runtimeScope: "main",
    getMode: () => "build",
    maxConcurrency: 5,
    runtimeTaskRegistry: registry,
    executionPort: { getBackgroundTask },
  } as unknown as ToolExecutorDeps;

  const tracker = new BackgroundTaskTracker(deps);
  const trace = { traceId: "trace_ticker" } as TraceContext;
  const startedAt = new Date();
  snapshots.set("bg_a", { taskId: "bg_a", status: "running", startedAt });
  snapshots.set("bg_b", { taskId: "bg_b", status: "running", startedAt });

  await tracker.trackBackgroundTask(
    { id: "call_a", name: "Bash", input: { command: "sleep 1" } },
    { status: "backgrounded", backgroundTaskId: "bg_a" },
    trace,
    undefined,
  );
  await tracker.trackBackgroundTask(
    { id: "call_b", name: "Bash", input: { command: "sleep 2" } },
    { status: "backgrounded", backgroundTaskId: "bg_b" },
    trace,
    undefined,
  );

  // 共享：两个任务只建一个表，且保持 1Hz + unref。
  assert.equal(intervalsMs.length, 1, "两个后台任务应共享单个 ticker");
  assert.equal(intervalsMs[0], 1_000);
  assert.equal(unrefCalls, 1);
  // track 内各立即 poll 一次（running 快照）。
  assert.deepEqual([...pollCalls.entries()].sort(), [
    ["bg_a", 1],
    ["bg_b", 1],
  ]);

  // 一拍扫描两个活跃任务。
  tickCallbacks[0]();
  await flushEventLoop();
  assert.equal(pollCalls.get("bg_a"), 2);
  assert.equal(pollCalls.get("bg_b"), 2);

  // 两个任务都落终态 → 下一拍各自结算 → 最后一个离开时停表。
  snapshots.set("bg_a", {
    taskId: "bg_a",
    status: "completed",
    startedAt,
    completedAt: new Date(),
  });
  snapshots.set("bg_b", {
    taskId: "bg_b",
    status: "completed",
    startedAt,
    completedAt: new Date(),
  });
  tickCallbacks[0]();
  await flushEventLoop();

  assert.equal(clearedHandles.length, 1, "全终态后应 clearInterval 停表");
  assert.equal(registry.get("bg_a")?.status, "completed");
  assert.equal(registry.get("bg_b")?.status, "completed");
  assert.equal(
    events.filter((event) => event.type === SessionEventType.BackgroundTaskCompleted).length,
    2,
  );

  // 空集：残留回调再触发也不产生轮询（真实 clearInterval 后本就不会再有拍子）。
  const callsBefore = pollCalls.get("bg_a");
  tickCallbacks[0]();
  await flushEventLoop();
  assert.equal(pollCalls.get("bg_a"), callsBefore);
  assert.equal(clearedHandles.length, 1, "停表不应被重复触发");
  assert.equal(intervalsMs.length, 1, "停表后不应再建新表");
});
