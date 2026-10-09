import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogContext, Logger, SubagentSendMessageRequest } from "@zcode/contracts";
import {
  createExploreSubagentPort,
  type ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";
import { createSubagentSeatGate, type SubagentSeatGate } from "../src/subagent/seat-gate.js";

/**
 * 座位闸门在派发链路上的接线契约（spec: core/spec/subagent-seat-gate-and-registry-bounds.md）：
 * - ① 上界 10 时第 11 个子代理等座，有人 settle 后按 FIFO 起跑（配置键生效）；
 * - ② 等座中 abort 即取消等待、不占座、registry 不留 fake running；
 * - ③ 终态必释放：看门狗超时 / TaskStop / 复活失败都归还座位；
 * - ⑦ `maxConcurrentSubagents` 配置覆盖进闸门容量。
 *
 * 每个测试注入独立闸门实例，隔离进程级单例的计数。
 */

// 必须在启用 mock timers 之前抓取真实定时器：测试内部的超时兜底不能被 mock 吃掉。
const realSetTimeout = globalThis.setTimeout;

const TRACE = {
  traceId: "trace_seat",
  spanId: "span_seat",
  sessionId: "sess_parent",
  turnId: "turn_1",
};

const INACTIVITY_MS = 1_000;

interface ChildCall {
  agentId: string;
  fail(error: unknown): void;
  settle(): void;
}

interface Harness {
  calls: ChildCall[];
  gate: SubagentSeatGate;
  outputRootDir: string;
  port: ReturnType<typeof createExploreSubagentPort>;
  /** 让下一次 runExploreAgent 以 setup 失败告终（复活失败场景）。 */
  failNextChild(): void;
  /** 等第 index 次子执行体启动（0 起）。 */
  nextCall(index: number): Promise<ChildCall>;
}

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function launchRequest(overrides: Record<string, unknown> = {}): never {
  return {
    sessionId: "sess_parent",
    turnId: "turn_1",
    parentToolCallId: "toolu_seat",
    agentType: "general-purpose",
    description: "座位闸门测试子代理",
    prompt: "挂起等待调度",
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    trace: TRACE,
    ...overrides,
  } as never;
}

async function createHarness(
  options: { inactivityTimeoutMs?: number; maxConcurrent?: number } = {},
): Promise<Harness> {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-seat-"));
  const gate = createSubagentSeatGate(options.maxConcurrent);
  const calls: ChildCall[] = [];
  const waiters: Array<{ index: number; resolve: (call: ChildCall) => void }> = [];
  let seq = 0;
  let shouldFailNext = false;

  const publish = (call: ChildCall): void => {
    const pending = waiters.filter((waiter) => waiter.index === calls.length - 1);
    for (const waiter of pending) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(call);
    }
  };

  const port = createExploreSubagentPort({
    outputRootDir,
    seatGate: gate,
    createAgentId: () => `agent_seq_${++seq}`,
    logger: createSilentLogger(),
    // 默认禁用看门狗（0 = 显式关闭）：本文件只有看门狗用例需要表；不留 600s 计时器，
    // 否则测试失败时挂起的子任务会让测试进程多等 10 分钟才退出。
    inactivityTimeoutMs: options.inactivityTimeoutMs ?? 0,
    ...(options.maxConcurrent === undefined
      ? {}
      : { maxConcurrentSubagents: options.maxConcurrent }),
    enqueueParentTaskNotification: () => undefined,
    emitParentEvent: async () => {},
    runExploreAgent: async (request: ExploreSubagentRuntimeRequest) => {
      if (shouldFailNext) {
        shouldFailNext = false;
        throw new Error("child session failed to start");
      }
      let settle!: () => void;
      let fail!: (error: unknown) => void;
      const promise = new Promise<{ events: never[]; response: string }>((resolve, reject) => {
        settle = () => resolve({ events: [], response: "child response" });
        fail = reject;
      });
      const call: ChildCall = { agentId: request.agentId, fail, settle };
      calls.push(call);
      publish(call);
      await request.onSessionReady?.();
      return await promise;
    },
  });

  return {
    calls,
    gate,
    outputRootDir,
    port,
    failNextChild: () => {
      shouldFailNext = true;
    },
    nextCall: (index) => {
      if (calls[index]) return Promise.resolve(calls[index]);
      return new Promise((resolve) => waiters.push({ index, resolve }));
    },
  };
}

async function cleanup(harness: Harness): Promise<void> {
  await rm(harness.outputRootDir, { force: true, recursive: true });
}

// 等待窗 20s：settle→ready 链含父侧收尾的文件 IO，高负载（多套件并行）下给足余量；
// 真正的挂死兜底是用例级 timeout: 30_000。
function within<T>(promise: Promise<T>, label: string, ms = 20_000): Promise<T> {
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

/** 轮询直到条件成立（真实定时器）：settle 链含文件 IO，用微任务推不动。 */
async function waitUntil(predicate: () => boolean, label: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await new Promise((resolve) => realSetTimeout(resolve, 10));
  }
}

/** 把所有未结算的子执行体推到终态并等座位归零，避免测试间互相污染。 */
async function drainHarness(harness: Harness): Promise<void> {
  for (const call of harness.calls) {
    call.settle();
  }
  await waitUntil(() => harness.gate.stats().held === 0, "全部座位归还");
}

test(
  "上界 10：第 11 个等座，settle 后按 FIFO 起跑（配置键 maxConcurrentSubagents 生效）",
  { timeout: 30_000 },
  async () => {
    const harness = await createHarness({ maxConcurrent: 10 });
    try {
      const firstWave = await Promise.all(
        Array.from({ length: 10 }, () => harness.port.start(launchRequest())),
      );
      assert.equal(firstWave.length, 10);
      await waitUntil(() => harness.calls.length === 10, "前 10 个子执行体启动");
      assert.deepEqual(harness.gate.stats(), { capacity: 10, held: 10, waiting: 0 });

      // 第 11、12 个派发：占满后必须等座，不得越过上界启动 child。
      // 必须串行入队：start() 在元数据落盘后才 acquire，两个并发 start 的入队顺序
      // 取决于 IO 完成顺序（负载下会与派发顺序反转），并行派发会让 FIFO 断言等错人。
      const eleventh = harness.port.start(launchRequest());
      await waitUntil(() => harness.gate.stats().waiting === 1, "第 11 个进入等座队列");
      const twelfth = harness.port.start(launchRequest());
      await waitUntil(() => harness.gate.stats().waiting === 2, "第 12 个进入等座队列");
      assert.equal(harness.calls.length, 10, "等座期间不得创建子会话");

      // 归还 1 个座位：队首（第 11 个）先起跑，第 12 个继续等。
      harness.calls[0].settle();
      // 超时即带现场取证：gate/callsIds 一眼区分「入队顺序反了」「release 没跑」「ready 链断」。
      const eleventhOutput = await within(eleventh, "第 11 个拿到座位并 ready").catch(
        async (error: unknown) => {
          const task = await harness.port.getTask("agent_seq_11");
          const ids = harness.calls.map((c) => c.agentId).join(",");
          throw new Error(
            `${(error as Error).message} | gate=${JSON.stringify(harness.gate.stats())}` +
              ` callsIds=[${ids}] task11=${task?.status ?? "missing"}`,
          );
        },
      );
      await waitUntil(() => harness.calls.length === 11, "第 11 个子执行体启动");
      assert.equal(harness.calls[10]?.agentId, eleventhOutput.agentId, "FIFO：队首先起跑");
      assert.equal(harness.gate.stats().waiting, 1);

      harness.calls[1].settle();
      const twelfthOutput = await within(twelfth, "第 12 个拿到座位并 ready");
      await waitUntil(() => harness.calls.length === 12, "第 12 个子执行体启动");
      assert.equal(harness.calls[11]?.agentId, twelfthOutput.agentId, "FIFO：队尾后起跑");

      await drainHarness(harness);
      assert.deepEqual(harness.gate.stats(), { capacity: 10, held: 0, waiting: 0 });
    } finally {
      await cleanup(harness);
    }
  },
);

test(
  "等座中 abort：取消等待、不占座、registry 不留 fake running",
  { timeout: 30_000 },
  async () => {
    const harness = await createHarness({ maxConcurrent: 1 });
    try {
      const background = await harness.port.start(launchRequest());
      await harness.nextCall(0);

      const controller = new AbortController();
      const foreground = harness.port.launch(
        launchRequest({ wait: true, parentToolCallId: "toolu_fg" }),
        { signal: controller.signal },
      );
      await waitUntil(() => harness.gate.stats().waiting === 1, "前台进入等座队列");
      // 「不加 queued 状态」的取舍：等座期间 registry 保持 running 现状。
      const queued = await harness.port.getTask("agent_seq_2");
      assert.equal(queued?.status, "running");

      controller.abort(new Error("parent turn cancelled"));
      await assert.rejects(foreground, /parent turn cancelled/);

      // 取消的等待者不占座：held 不涨、waiting 出队，且 registry 条目被清掉。
      assert.deepEqual(harness.gate.stats(), { capacity: 1, held: 1, waiting: 0 });
      assert.equal(await harness.port.getTask("agent_seq_2"), undefined);
      assert.equal(harness.calls.length, 1, "被取消的派发从未创建子会话");

      harness.calls[0].settle();
      await waitUntil(() => harness.gate.stats().held === 0, "占座者结算后归还座位");
      assert.equal(
        (await harness.port.getTask(background.agentId))?.status,
        "completed",
        "占座者的终态不受等座取消影响",
      );
    } finally {
      await cleanup(harness);
    }
  },
);

test("终态必释放：看门狗超时落 failed 后归还座位", { timeout: 30_000 }, async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = await createHarness({
    inactivityTimeoutMs: INACTIVITY_MS,
    maxConcurrent: 1,
  });
  try {
    const output = await within(harness.port.start(launchRequest()), "后台派发返回");
    await harness.nextCall(0);
    assert.equal(harness.gate.stats().held, 1);

    t.mock.timers.tick(INACTIVITY_MS);
    const task = await within(harness.port.waitForTask(output.agentId), "超时后落到终态");
    assert.equal(task?.status, "failed");
    await waitUntil(() => harness.gate.stats().held === 0, "超时终态归还座位");
    assert.deepEqual(harness.gate.stats(), { capacity: 1, held: 0, waiting: 0 });
  } finally {
    t.mock.timers.reset();
    await cleanup(harness);
  }
});

test("终态必释放：TaskStop 落 killed 后归还座位", { timeout: 30_000 }, async () => {
  const harness = await createHarness({ maxConcurrent: 1 });
  try {
    const output = await harness.port.start(launchRequest());
    await harness.nextCall(0);
    assert.equal(harness.gate.stats().held, 1);

    const stopped = await harness.port.stopTask(output.agentId);
    assert.equal(stopped?.status, "killed");
    await waitUntil(() => harness.gate.stats().held === 0, "停止终态归还座位");
    assert.deepEqual(harness.gate.stats(), { capacity: 1, held: 0, waiting: 0 });
  } finally {
    await cleanup(harness);
  }
});

test("终态必释放：SendMessage 复活失败归还座位并还原旧 snapshot", { timeout: 30_000 }, async () => {
  const harness = await createHarness({ maxConcurrent: 1 });
  try {
    const output = await harness.port.start(launchRequest());
    await harness.nextCall(0);
    harness.calls[0].settle();
    await within(harness.port.waitForTask(output.agentId), "首个生命周期结算");
    await waitUntil(() => harness.gate.stats().held === 0, "首个生命周期归还座位");

    // 复活即占座：setup 失败后必须归还，且不能留下一个未启动的新 turn 卡成 running。
    harness.failNextChild();
    const request: SubagentSendMessageRequest = {
      sessionId: "sess_parent",
      turnId: "turn_1",
      parentToolCallId: "toolu_msg",
      to: output.agentId,
      message: "继续任务",
      workingDirectory: "/tmp",
      workspaceRoot: "/tmp",
      trace: TRACE,
    };
    await assert.rejects(harness.port.sendMessage(request), /child session failed to start/);
    await waitUntil(() => harness.gate.stats().held === 0, "复活失败归还座位");
    assert.deepEqual(harness.gate.stats(), { capacity: 1, held: 0, waiting: 0 });
    assert.equal(
      (await harness.port.getTask(output.agentId))?.status,
      "completed",
      "复活失败还原旧 terminal snapshot",
    );
  } finally {
    await cleanup(harness);
  }
});

test(
  "配置覆盖：maxConcurrentSubagents=1 时第二个派发等座，settle 后放行",
  { timeout: 30_000 },
  async () => {
    const harness = await createHarness({ maxConcurrent: 1 });
    try {
      const first = await harness.port.start(launchRequest());
      await harness.nextCall(0);

      const second = harness.port.start(launchRequest());
      await waitUntil(() => harness.gate.stats().waiting === 1, "第二个派发等座");
      assert.equal(harness.calls.length, 1);

      harness.calls[0].settle();
      const secondOutput = await within(second, "settle 后第二个派发放行");
      await waitUntil(() => harness.calls.length === 2, "第二个子执行体启动");
      assert.equal(harness.calls[1]?.agentId, secondOutput.agentId);
      assert.equal(harness.gate.stats().held, 1);

      harness.calls[1].settle();
      // release 在 finalize 之后：held 归零即两个终态都已落地。
      await waitUntil(() => harness.gate.stats().held === 0, "全部座位归还");
      assert.equal((await harness.port.getTask(first.agentId))?.status, "completed");
      assert.equal((await harness.port.getTask(secondOutput.agentId))?.status, "completed");
      assert.deepEqual(harness.gate.stats(), { capacity: 1, held: 0, waiting: 0 });
    } finally {
      await cleanup(harness);
    }
  },
);
