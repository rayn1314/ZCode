import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  RESPOND_TO_COORDINATOR_TOOL_NAME,
  SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
  SessionEventType,
  createRootTraceContext,
  createSessionEvent,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionId,
  type SessionStorePort,
  type TraceContext,
  type TurnId,
} from "@zcode/contracts";
import { createDefaultSubagentPort } from "../src/runtime/methods/subagent.js";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import type {
  SubagentChildLaunchBundle,
  SubagentChildSessionHost,
} from "../src/subagent/child-session-host.js";
import type { AgentRuntimeDeps } from "../src/runtime/types.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

/**
 * S1b-3 的送侧契约（spec `subagent-session-as-first-class.md` D1 / S1b）。
 *
 * 子会话不再由 core 自己 `new AgentRuntime(...)` 造：`runExploreAgent` 只把
 * 「父语境快照 + 只能由父 runtime 算出来的端口」打成 `SubagentChildLaunchBundle`，
 * 交给会话构造入口以受限模式物化并登记。这里钉住四条：
 *
 * 1. 没有移交端口时**显式失败**——宁可派发失败，也不退回「跑一个没有 record 的子会话」；
 * 2. 移交包携带的身份事实与套娃闸（taskType / parentSessionId / subagents.enabled / 工具面）；
 * 3. 父域端口、模型工厂、防环链都来自父 runtime 的**同一份实例**（不是重建的第二份）；
 * 4. 送序：落库 → 启动规格 → 模型选型 → executeTurn(inputSource=subagent)；resume 不重写规格。
 */

const PARENT = "sess_parent" as SessionId;
const PARENT_SELECTION = { providerId: "prov-a", modelId: "model-a" };
const WORKDIR = "E:\\proj";
const CHILD_MODEL = { options: { reasoningLevel: "medium" } };
const CHAIN_SNAPSHOT = { hops: 3 };

type Port = NonNullable<ReturnType<typeof createDefaultSubagentPort>>;
type RunRequest = Parameters<Port["run"]>[0];

interface Harness {
  /** 父 permissionBroker 实际收到的请求（用于断言路由身份被改写回父会话）。 */
  brokered: { origin?: { childSessionId?: SessionId }; sessionId: string }[];
  bundles: SubagentChildLaunchBundle[];
  entries: SessionEntryInfo[];
  order: string[];
  /** 父 runtime 自己的 permissionBroker 实例（派生包必须包它，而不是替换它）。 */
  permissionBrokerStub: object;
  port: Port;
  registry: InMemoryRuntimeTaskRegistry;
  request: RunRequest;
  /** 父 providerRuntimeHeadersPort 实际收到的 sessionId（应恒为父会话）。 */
  routedSessions: string[];
  sinkNotifications: { event: SessionEvent; trace: TraceContext }[];
  sinkTraceSessions: SessionId[];
}

function createHarness(options: { withHost?: boolean } = {}): Harness {
  const trace = createRootTraceContext({ sessionId: PARENT });
  const order: string[] = [];
  const bundles: SubagentChildLaunchBundle[] = [];
  const entries: SessionEntryInfo[] = [];
  const sinkNotifications: { event: SessionEvent; trace: TraceContext }[] = [];
  const sinkTraceSessions: SessionId[] = [];
  const routedSessions: string[] = [];
  const brokered: Harness["brokered"] = [];
  const registry = new InMemoryRuntimeTaskRegistry();

  class Store {
    async saveSessionEntry(entry: SessionEntryInfo): Promise<void> {
      order.push(`entry:${entry.type}`);
      if (entry.type === SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC) entries.push(entry);
    }
  }

  const childRuntime = {
    async cancelRunningRuntimeBackgroundTasks(): Promise<void> {},
    async emitModelSelected(): Promise<void> {
      order.push("modelSelected");
    },
    async ensureSessionPersistedForExternalActivity(): Promise<void> {
      order.push("persist");
    },
    async executeTurn(
      _prompt: string,
      _silent: unknown,
      turnOptions?: { inputSource?: string },
    ): Promise<unknown> {
      order.push(`executeTurn:${turnOptions?.inputSource ?? "?"}`);
      return { events: [], response: "child done", traceId: trace.traceId };
    },
    recordPendingModelChange(): void {
      order.push("pendingModel");
    },
    sealBackgroundTaskNotifications(): void {
      order.push("seal");
    },
  };

  const parentPermissionBroker = {
    async requestPermission(request: {
      origin?: { childSessionId?: SessionId };
      sessionId: string;
    }) {
      brokered.push({ origin: request.origin, sessionId: request.sessionId });
      return { decision: "allow" };
    },
  };
  const parentHeadersPort = {
    refreshBeforeModelRequest(input: { sessionId: string }) {
      routedSessions.push(input.sessionId);
    },
    shouldRefreshBeforeModelRequest() {
      return true;
    },
  };

  const envInfo = {
    cwd: WORKDIR,
    nodeVersion: "v22",
    osVersion: "10",
    platform: "win32",
    shell: "bash",
  };
  const runtime = {
    agentTelemetry: { captureCausation: () => undefined, port: {} },
    appendEvent: async () => {},
    branchGeneration: 0,
    config: {
      dynamicWorkflowEnabled: false,
      embeddedSearchBackend: "ripgrep",
      envInfo,
      mcp: { enabled: true, servers: {} },
      midConversationSystem: false,
      mode: "build",
      modelStreaming: true,
      nativeSearchEnhancementsEnabled: false,
      // 把 runner 的元数据/输出文件收在本测试自己的临时目录里，不写进真实 agent 输出根。
      subagents: { enabled: true, outputRootDir: join(tmpdir(), "zcode-core-subagent-test") },
    },
    contextSourceSnapshot: { currentDate: "2026-10-07", envInfo, userInstructions: "AGENTS" },
    enqueueBackgroundTaskNotification: () => undefined,
    enqueueSubagentMessage: () => undefined,
    getPlanEnabled: () => false,
    getSessionModelSelection: () => ({ ...PARENT_SELECTION }),
    getTools: () => [
      { name: "Read", permission: { permission: "allow" } },
      { name: "Grep", permission: { permission: "allow" } },
      // 派发工具必须在子会话工具面里被摘掉（套娃闸的第二道）。
      { name: "Agent", permission: { permission: "allow" } },
    ],
    logger: undefined,
    modelFactory: () => CHILD_MODEL,
    notifyEventSinks: async (event: SessionEvent, traceContext: TraceContext) => {
      sinkNotifications.push({ event, trace: traceContext });
      sinkTraceSessions.push(traceContext.sessionId);
    },
    permissionBroker: parentPermissionBroker,
    permissionService: {},
    providerRuntimeHeadersPort: parentHeadersPort,
    runtimeTaskRegistry: registry,
    sessionId: PARENT,
    sessionMessageChainReader: { current: () => CHAIN_SNAPSHOT },
  } as unknown as AgentRuntimeInternal;

  const host: SubagentChildSessionHost = {
    async createChildSession(bundle: SubagentChildLaunchBundle) {
      bundles.push(bundle);
      return childRuntime as never;
    },
  };

  const deps = {
    modelFactory: runtime.modelFactory,
    sessionStore: new Store() as unknown as SessionStorePort,
    ...(options.withHost === false ? {} : { subagentChildHost: host }),
  } as unknown as AgentRuntimeDeps;

  const port = createDefaultSubagentPort.call(runtime, deps);
  assert.ok(port, "子代理端口应由 subagents.enabled 打开");

  return {
    brokered,
    bundles,
    entries,
    order,
    permissionBrokerStub: parentPermissionBroker,
    port,
    registry,
    request: {
      agentType: "general-purpose",
      description: "check the contract",
      parentToolCallId: "tool_1",
      prompt: "go",
      sessionId: PARENT,
      trace,
      turnId: "turn_1" as TurnId,
      workingDirectory: WORKDIR,
      workspaceRoot: WORKDIR,
    },
    routedSessions,
    sinkNotifications,
    sinkTraceSessions,
  };
}

test("缺移交端口时显式失败，不退化跑没有 record 的子会话", async () => {
  const harness = createHarness({ withHost: false });

  await assert.rejects(harness.port.run(harness.request), /child session construction host/);
  assert.equal(harness.bundles.length, 0);
  assert.ok(!harness.order.some((step) => step.startsWith("executeTurn")));
});

test("移交包携带子会话身份与套娃闸；工具面已冻结且摘掉派发工具", async () => {
  const harness = createHarness();
  const output = await harness.port.run(harness.request);

  assert.equal(output.status, "completed");
  assert.equal(harness.bundles.length, 1);

  const bundle = harness.bundles[0];
  assert.ok(bundle);
  assert.equal(bundle.parentSessionId, PARENT);
  assert.equal(bundle.agentType, "general-purpose");
  assert.equal(bundle.description, "check the contract");
  assert.equal(bundle.background, false);
  assert.equal(bundle.resume, false);
  assert.match(bundle.childSessionId, /^sess_subagent_agent_/);

  const config = bundle.runtimeConfig;
  assert.equal(config.taskType, "subagent_child");
  assert.equal(config.parentSessionId, PARENT);
  assert.equal(config.subagents?.enabled, false);
  assert.equal(config.agentName, "zcode-general-purpose");
  assert.equal(config.toolset, "main");
  assert.equal(config.maxTurns, 4);
  assert.equal(config.workingDirectory, WORKDIR);
  // 旧 plan 枚举不含基础权限：planEnabled 与 mode 一起下传，避免构造侧回退成 build。
  assert.equal(config.mode, "build");
  assert.equal(config.planEnabled, false);
  assert.deepEqual(config.modelSelection, PARENT_SELECTION);
  assert.equal(config.dynamicWorkflowEnabled, false);
  assert.equal(config.mcp, undefined);
  assert.ok(config.subagentContext?.agentPrompt);
  assert.equal(config.subagentContext?.userInstructions, "AGENTS");

  assert.ok(config.toolAllowlist?.includes("Read"));
  assert.ok(config.toolAllowlist?.includes("Grep"));
  assert.ok(config.toolAllowlist?.includes(RESPOND_TO_COORDINATOR_TOOL_NAME));
  assert.ok(!config.toolAllowlist?.includes("Agent"));
});

test("父域端口 / 模型工厂 / 防环链都借用父 runtime 的同一份实例", async () => {
  const harness = createHarness();
  await harness.port.run(harness.request);

  const bundle = harness.bundles[0];
  assert.ok(bundle);
  const deps = bundle.deps;

  // 前台 child 的生命周期被父 Agent Tool await：用真实父子 Span。
  assert.equal(deps.agentTelemetryCausationMode, "child");
  // 防环链只在创建时快照一次，子会话自己回不到父的当前链。
  assert.equal(deps.initialSessionMessageChain, CHAIN_SNAPSHOT);
  // 模型工厂指向父派生出的那一份实例，而不是重新解析出的第二个 model。
  assert.equal(deps.modelFactory?.({ selection: { ...PARENT_SELECTION } } as never), CHILD_MODEL);

  // provider runtime headers：子请求必须用父会话路由（桌面只订阅父 task）。
  const headers = deps.providerRuntimeHeadersPort;
  assert.ok(headers);
  assert.equal(headers.shouldRefreshBeforeModelRequest?.({} as never), true);
  headers.refreshBeforeModelRequest?.({ sessionId: bundle.childSessionId } as never);
  assert.deepEqual(harness.routedSessions, [PARENT]);

  // permission broker：包一层改写 sessionId，但 origin 保留子代理归属。
  const broker = deps.permissionBroker;
  assert.ok(broker);
  assert.notEqual(broker, harness.permissionBrokerStub);
  await broker.requestPermission({
    sessionId: bundle.childSessionId,
    toolCallId: "tool_child",
  } as never);
  assert.equal(harness.brokered.length, 1);
  assert.equal(harness.brokered[0]?.sessionId, PARENT);
  assert.equal(harness.brokered[0]?.origin?.childSessionId, bundle.childSessionId);
});

test("送序：落库 → 启动规格 → 模型选型 → executeTurn(subagent)", async () => {
  const harness = createHarness();
  await harness.port.run(harness.request);

  assert.deepEqual(harness.order, [
    "persist",
    `entry:${SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC}`,
    "pendingModel",
    "modelSelected",
    "executeTurn:subagent",
    "seal",
  ]);
  assert.equal(harness.entries.length, 1);
  assert.equal(harness.entries[0]?.sessionID, harness.bundles[0]?.childSessionId);
});

test("raw child 事件只通知父 runtime 的外部 sinks，并带上子会话 id", async () => {
  const harness = createHarness();
  await harness.port.run(harness.request);

  const bundle = harness.bundles[0];
  assert.ok(bundle);
  const eventSink = bundle.deps.eventSink;
  assert.ok(eventSink);

  const childEvent = createSessionEvent(
    SessionEventType.TurnComplete,
    bundle.childSessionId,
    {},
    {},
  );
  await eventSink.onSessionEvent(childEvent);

  assert.equal(harness.sinkNotifications.length, 1);
  assert.equal(harness.sinkNotifications[0]?.event, childEvent);
  assert.equal(harness.sinkTraceSessions[0], bundle.childSessionId);
});

test("resume 不重写启动规格、不重发模型选型，且以 resume 标记移交", async () => {
  const harness = createHarness();
  await harness.port.run(harness.request);

  const taskId = Object.keys(harness.registry.all())[0];
  assert.ok(taskId, "首次派发应留下一个 runtime task");
  harness.order.length = 0;

  const result = await harness.port.sendMessage?.({
    message: "continue",
    parentToolCallId: "tool_2",
    sessionId: PARENT,
    summary: "follow up",
    to: taskId,
    trace: createRootTraceContext({ sessionId: PARENT }),
    workingDirectory: WORKDIR,
    workspaceRoot: WORKDIR,
  });
  await harness.registry.waitForTerminal(taskId);

  assert.equal(result?.delivery, "resumed_background");
  assert.equal(harness.bundles.length, 2, "复活走同一条移交");
  const resumed = harness.bundles[1];
  assert.ok(resumed);
  assert.equal(resumed.resume, true);
  // 规格不可变（spec D2）：只在首次 spawn 写一次，resume 不覆写。
  assert.equal(harness.entries.length, 1);
  assert.deepEqual(harness.order, ["executeTurn:subagent", "seal"]);
});
