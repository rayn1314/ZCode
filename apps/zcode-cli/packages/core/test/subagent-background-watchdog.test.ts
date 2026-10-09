import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionEventType,
  type LogContext,
  type Logger,
  type SessionEvent,
} from "@zcode/contracts";
import {
  createExploreSubagentPort,
  type ExploreSubagentRuntimeRequest,
  type ParentTaskNotificationCommand,
} from "../src/subagent/runner.js";

/**
 * 后台子代理活动看门狗的核心契约（spec: core/spec/subagent-background-watchdog.md）：
 * - 后台派发（默认路径）与前台同构地武装看门狗：零活动到点 → abort → failed 终态，
 *   registry 离开 running（父会话才不会被 residency 永久 pin）；
 * - 前台转后台后看门狗不随前台帧停表，超时照样落终态；
 * - reportActivity 由子会话事件订阅驱动，活动会重置计时（证明接线存在，不误杀）；
 * - settle 必停表：结算后推进时钟不会二次开火。
 *
 * 子执行桩模拟「卡在工具/MCP/文件 IO」的形态：既不上报活动，也无视 abort signal——
 * 没有 guard 版执行体时，abort 后永不 settle，registry 会永远卡在 running。
 */

// 必须在启用 mock timers 之前抓取真实定时器：测试内部的超时兜底不能被 mock 吃掉。
const realSetTimeout = globalThis.setTimeout;

const TRACE = {
  traceId: "trace_watchdog",
  spanId: "span_watchdog",
  sessionId: "sess_parent",
  turnId: "turn_1",
};

const INACTIVITY_MS = 1_000;

interface Harness {
  /** 子执行体已启动（看门狗已武装、readyGate 已放行）。 */
  childStarted: Promise<void>;
  events: SessionEvent[];
  notifications: ParentTaskNotificationCommand[];
  outputRootDir: string;
  port: ReturnType<typeof createExploreSubagentPort>;
  /** 子会话事件订阅送进来的活动回调；未接线时为 undefined。 */
  reportActivity: (() => void) | undefined;
  warns: LogContext[];
}

function createLogger(warns: LogContext[]): Logger {
  const logger: Logger = {
    debug() {},
    error() {},
    info() {},
    warn(_message: string, context?: LogContext) {
      warns.push(context ?? {});
    },
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
    parentToolCallId: "toolu_watchdog",
    agentType: "general-purpose",
    description: "看门狗测试子代理",
    prompt: "保持挂起",
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    trace: TRACE,
    ...overrides,
  } as never;
}

async function createHarness(options: { autoBackgroundMs?: number } = {}): Promise<Harness> {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-watchdog-"));
  const events: SessionEvent[] = [];
  const notifications: ParentTaskNotificationCommand[] = [];
  const warns: LogContext[] = [];
  let markChildStarted!: () => void;
  const childStarted = new Promise<void>((resolve) => {
    markChildStarted = resolve;
  });
  let capturedReportActivity: (() => void) | undefined;

  const port = createExploreSubagentPort({
    outputRootDir,
    inactivityTimeoutMs: INACTIVITY_MS,
    ...(options.autoBackgroundMs === undefined
      ? {}
      : { autoBackgroundMs: options.autoBackgroundMs }),
    logger: createLogger(warns),
    enqueueParentTaskNotification: (notification) => {
      notifications.push(notification);
      return undefined;
    },
    emitParentEvent: async (event) => {
      events.push(event);
    },
    runExploreAgent: async (request: ExploreSubagentRuntimeRequest) => {
      await request.onSessionReady?.();
      capturedReportActivity = request.reportActivity;
      markChildStarted();
      return await new Promise<never>(() => {});
    },
  });

  return {
    childStarted,
    events,
    notifications,
    outputRootDir,
    port,
    get reportActivity() {
      return capturedReportActivity;
    },
    warns,
  };
}

async function cleanup(harness: Harness): Promise<void> {
  await rm(harness.outputRootDir, { force: true, recursive: true });
}

/** 推进真实的事件循环若干轮，让 microtask 与真实 I/O 结算完（mock timers 不影响它）。 */
function flushEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** 用真实定时器给关键等待加兜底：看门狗没按预期开火时给出明确失败，而不是挂死。 */
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

function timeoutFiredCount(warns: LogContext[]): number {
  return warns.filter((context) => context.event === "subagent.activity_timeout").length;
}

test(
  "后台零活动 → 看门狗超时 → failed 终态、registry 离开 running、表被清掉",
  { timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = await createHarness();
    try {
      const output = await within(harness.port.launch(launchRequest()), "后台派发返回");
      assert.equal(output.status, "async_launched");
      await within(harness.childStarted, "子执行体启动");
      assert.equal((await harness.port.getTask(output.agentId))?.status, "running");

      t.mock.timers.tick(INACTIVITY_MS);

      const task = await within(harness.port.waitForTask(output.agentId), "超时后落到终态");
      assert.equal(task?.status, "failed");
      assert.match(String(task?.error), /Subagent was inactive for 1000ms/);

      // 父会话必须拿到终态事件与通知：registry 非 running 之外的可观测信号。
      const completedEvent = harness.events.find(
        (event) => event.type === SessionEventType.BackgroundTaskCompleted,
      );
      assert.ok(completedEvent);
      assert.equal((completedEvent.payload as { status?: string }).status, "failed");
      assert.equal(harness.notifications.length, 1);
      assert.match(harness.notifications[0]?.text ?? "", /failed/);

      // settle 必停表：结算后再推进任意时长也不会二次开火。
      t.mock.timers.tick(60 * INACTIVITY_MS);
      assert.equal(timeoutFiredCount(harness.warns), 1);
      assert.equal((await harness.port.getTask(output.agentId))?.status, "failed");
    } finally {
      t.mock.timers.reset();
      await cleanup(harness);
    }
  },
);

test(
  "前台转后台（autoBackground）后看门狗仍活着：转换点之后超时同样落 failed",
  { timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = await createHarness({ autoBackgroundMs: 200 });
    try {
      const launchPromise = harness.port.launch(launchRequest({ wait: true }));
      await within(harness.childStarted, "子执行体启动");
      await flushEventLoop();

      // 到点转后台：run() 帧返回 async_launched，执行体仍在跑。
      t.mock.timers.tick(200);
      const output = await within(launchPromise, "前台转后台返回");
      assert.equal(output.status, "async_launched");
      const converted = await harness.port.getTask(output.agentId);
      assert.equal(converted?.status, "running");
      assert.equal(converted?.isBackgrounded, true);

      // 关键：看门狗没有随前台帧停表，仍按「上次活动 + 1000ms」在 t=1000 开火。
      t.mock.timers.tick(INACTIVITY_MS - 200);
      const task = await within(harness.port.waitForTask(output.agentId), "转换后超时落到终态");
      assert.equal(task?.status, "failed");
      assert.match(String(task?.error), /Subagent was inactive for 1000ms/);
      assert.equal(timeoutFiredCount(harness.warns), 1);
    } finally {
      t.mock.timers.reset();
      await cleanup(harness);
    }
  },
);

test(
  "活动事件重置计时：reportActivity 接线存在，持续有活动不误杀",
  { timeout: 15_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const harness = await createHarness();
    try {
      const output = await within(harness.port.launch(launchRequest()), "后台派发返回");
      await within(harness.childStarted, "子执行体启动");
      assert.ok(harness.reportActivity, "reportActivity 必须接进子执行请求");

      t.mock.timers.tick(600);
      assert.equal((await harness.port.getTask(output.agentId))?.status, "running");

      // 一条子会话事件到达 → 计时从 t=600 重新起算。
      harness.reportActivity?.();
      t.mock.timers.tick(900);
      assert.equal(
        (await harness.port.getTask(output.agentId))?.status,
        "running",
        "距上次活动 900ms < 1000ms，不应超时",
      );

      t.mock.timers.tick(200);
      const task = await within(harness.port.waitForTask(output.agentId), "活动停止后落到终态");
      assert.equal(task?.status, "failed");
      assert.match(String(task?.error), /Subagent was inactive for 1000ms/);
    } finally {
      t.mock.timers.reset();
      await cleanup(harness);
    }
  },
);
