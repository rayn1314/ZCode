import assert from "node:assert/strict";
import test from "node:test";
import { createInMemorySessionEventStore } from "@zcode/adapters/storage";
import { DEFAULT_ZCODE_COMPACTION_PREFERENCES } from "@zcode/shared";
import { type SessionId } from "@zcode/contracts";
import type { SubagentChildLaunchBundle } from "@zcode/core";
import { createSubagentChildHost } from "../src/zcode-protocol/server-operations.js";
import type { SubagentChildBorrowedPorts } from "../src/app/subagent-child-scope.js";
import type {
  ZCodeProtocolAgentServerContext,
  ZCodeProtocolSessionRecord,
} from "../src/zcode-protocol/server-types.js";

/**
 * S1b-2 的收侧契约（spec `subagent-session-as-first-class.md` D1 / S1b）：core 交出的
 * `SubagentChildLaunchBundle` 由会话构造入口**以受限模式**物化成一个与普通会话同形的 record。
 *
 * 这里钉住四件事：
 * 1. 父 record 缺席、或父 App 没借出装配事实 → **显式失败**，且不留半登记状态；
 * 2. 子 record 的身份事实（`taskType` / `parentSessionId` / 与普通会话同形的那几个字段）；
 * 3. 装配事实从父借：启动输入、event store、workspace、起始偏好（memory / 压缩 / 原生搜索 / shell）；
 * 4. 顺序：App 构造成功 → 登记 → 才 resume；且子 App 拿不到 `subagentChildHost`（结构性防套娃）。
 */

const PARENT = "sess_parent" as SessionId;
const CHILD = "sess_subagent_agent_1" as SessionId;
const WORKDIR = "E:\\proj";
const WORKSPACE = { workspaceKey: "ws-key", workspacePath: WORKDIR };
const SHELL_SELECTION = { dialect: "posix", display: { name: "bash" }, source: "auto" };
/** 非默认压缩偏好，用来验证「继承父会话起始偏好」真的传下去了。 */
const PARENT_COMPACTION = {
  ...DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  microcompactEnabled: true,
  bufferTokens: 20_000,
};

interface Harness {
  borrowed: SubagentChildBorrowedPorts;
  captured: {
    childRegisteredAtResume: boolean;
    options?: Record<string, unknown>;
    subscribedChildEvents: number;
  };
  childRuntime: object;
  context: ZCodeProtocolAgentServerContext;
  host: ReturnType<typeof createSubagentChildHost>;
  parentRecord: ZCodeProtocolSessionRecord;
}

function createHarness(
  options: { resume?: boolean; withBorrow?: boolean; withParent?: boolean } = {},
): Harness {
  const eventStore = createInMemorySessionEventStore();
  const captured: Harness["captured"] = {
    childRegisteredAtResume: false,
    subscribedChildEvents: 0,
  };
  const childRuntime = {
    subscribeEvents() {
      captured.subscribedChildEvents += 1;
      return () => {};
    },
  };
  const sessions = new Map<string, ZCodeProtocolSessionRecord>();

  const borrowed = {
    artifactStore: {},
    executionPort: {},
    fileSystemPort: {},
    httpClientPort: {},
    imageProcessorPort: {},
    pdfDocumentPort: {},
    startupInputs: { configResult: {}, pluginOutcome: { plugins: [] } },
  } as unknown as SubagentChildBorrowedPorts;

  const parentRecord = {
    app: {
      runtime: { getSessionShellSelection: () => SHELL_SELECTION },
      ...(options.withBorrow === false ? {} : { subagentChildBorrow: borrowed }),
    },
    compaction: { ...PARENT_COMPACTION },
    eventStore,
    memoryEnabled: false,
    nativeSearchEnhancementsEnabled: true,
    workspace: WORKSPACE,
  } as unknown as ZCodeProtocolSessionRecord;

  const context = {
    appRuntimePreferences: { modelIoFullRetentionEnabled: false },
    deps: {
      env: {},
      platform: "win32",
      sessionStore: {},
      version: "0.0.0-test",
      createZCodeApp: async (appOptions: Record<string, unknown>) => {
        captured.options = appOptions;
        return {
          resume: async () => {
            // 先登记再 resume：resume 回放出来的事件才能按 childSessionId 正确扇出。
            captured.childRegisteredAtResume = sessions.has(CHILD);
          },
          runtime: childRuntime,
        };
      },
    },
    sessions,
  } as unknown as ZCodeProtocolAgentServerContext;

  const host = createSubagentChildHost(context, () =>
    options.withParent === false ? undefined : parentRecord,
  );

  return { borrowed, captured, childRuntime, context, host, parentRecord };
}

function bundle(overrides: Partial<SubagentChildLaunchBundle> = {}): SubagentChildLaunchBundle {
  return {
    agentType: "general-purpose",
    background: false,
    childSessionId: CHILD,
    deps: {},
    description: "check the contract",
    parentSessionId: PARENT,
    resume: false,
    runtimeConfig: {
      agentName: "zcode-general-purpose",
      maxTurns: 4,
      parentSessionId: PARENT,
      subagents: { enabled: false },
      taskType: "subagent_child",
      toolAllowlist: ["Read", "respond_to_coordinator"],
      toolset: "main",
      workingDirectory: WORKDIR,
    },
    ...overrides,
  } as SubagentChildLaunchBundle;
}

test("父 record 缺席时显式失败，且不登记任何 session", async () => {
  const harness = createHarness({ withParent: false });

  await assert.rejects(
    harness.host.createChildSession(bundle()),
    /requires a live parent session record/,
  );
  assert.equal(harness.context.sessions.size, 0);
  assert.equal(harness.captured.options, undefined);
});

test("父 App 没借出装配事实时显式失败，不留半登记状态", async () => {
  const harness = createHarness({ withBorrow: false });

  await assert.rejects(
    harness.host.createChildSession(bundle()),
    /cannot lend subagent assembly ports/,
  );
  assert.equal(harness.context.sessions.size, 0);
});

test("子 record 与普通会话同形，身份事实指向父的 subagent_child 边", async () => {
  const harness = createHarness();
  const runtime = await harness.host.createChildSession(bundle());

  const record = harness.context.sessions.get(CHILD);
  assert.ok(record, "子会话必须在 App 构造成功后登记进 context.sessions");
  assert.equal(runtime, harness.childRuntime, "host 交回的是子 App 自己的 runtime");
  assert.equal(record.app.runtime, harness.childRuntime);

  assert.equal(record.taskType, "subagent_child");
  assert.equal(record.parentSessionId, PARENT);
  assert.equal(record.persistence, "immediate");
  assert.equal(record.workspace, WORKSPACE);
  assert.ok(record.protocolEventSequences instanceof Map);
  assert.ok(record.protocolToolInputTransmissions instanceof Map);
  assert.equal(record.stateRevision, 0);
  assert.equal(typeof record.unsubscribe, "function");
  // 沿用父 record 的 event store 实例：它按 sessionId 分区，子事件落在自己的分区里。
  assert.equal(record.eventStore, harness.parentRecord.eventStore);
  // 订阅的是**子 App** 的事件（登记时挂上）。
  assert.equal(harness.captured.subscribedChildEvents, 1);

  record.unsubscribe();
});

test("装配事实从父借：启动输入 / event store / 起始偏好，且子 App 不拿到派发端口", async () => {
  const harness = createHarness();
  const childBundle = bundle();
  await harness.host.createChildSession(childBundle);

  const options = harness.captured.options;
  assert.ok(options);

  // 覆盖包原样交给构造入口（受限模式由它以「在场」判定）。
  const scope = options.subagentChildScope as { bundle: SubagentChildLaunchBundle };
  assert.equal(scope.bundle, childBundle);
  // 启动输入复用父已解析的那一份：不重做四项磁盘解析。
  assert.equal(options.startupInputs, harness.borrowed.startupInputs);
  // 事件与 workspace 归属：父 record 的实例，不是第二份。
  assert.equal(options.eventStore, harness.parentRecord.eventStore);
  assert.equal(options.sessionId, CHILD);
  assert.equal(options.resume, false);
  // 子会话不注入 workspace hook policy / automation / off-peak / 浏览器控制。
  assert.equal(options.workspaceHookPolicy, undefined);
  assert.equal(options.automationPort, undefined);
  assert.equal(options.offPeakPort, undefined);
  assert.equal(options.browserControlPort, undefined);
  // 结构性防套娃：子 App 的选项里永远没有派发端口。
  assert.equal(options.subagentChildHost, undefined);
  // 子会话也拿进程级收件箱（S3 已开）；本夹具的 context 没有提供 mailbox 端口，
  // 因此这里断言的是「缺端口时不注入」，不再断言「按角色关闭」。
  assert.equal(options.sessionMailboxPort, undefined);
  // roster 仍按角色关闭：子会话 roster 恒空，注入等于假能力（见 workspace-model-runtime.ts）。
  assert.equal(options.subagentRosterPort, undefined);

  const runtimeConfig = options.runtimeConfig as Record<string, unknown>;
  // 覆盖包的身份事实原样保留。
  assert.equal(runtimeConfig.taskType, "subagent_child");
  assert.equal(runtimeConfig.parentSessionId, PARENT);
  assert.equal((runtimeConfig.subagents as { enabled: boolean }).enabled, false);
  assert.equal(runtimeConfig.agentName, "zcode-general-purpose");
  // 起始偏好（inherit）覆盖覆盖包里的默认值。
  assert.equal(runtimeConfig.nativeSearchEnhancementsEnabled, true);
  assert.deepEqual(runtimeConfig.memory, { enabled: false });
  assert.equal((runtimeConfig.compact as { bufferTokens?: number }).bufferTokens, 20_000);
  // 协议入口补的 workspace 事实照旧。
  assert.equal(runtimeConfig.workspacePath, WORKDIR);
  assert.equal(runtimeConfig.modelStreaming, "on");
});

test("顺序：App 构造成功 → 登记 → 才 resume", async () => {
  const harness = createHarness({ resume: true });
  await harness.host.createChildSession(bundle({ resume: true }));

  assert.equal((harness.captured.options as { resume?: boolean }).resume, true);
  assert.equal(
    harness.captured.childRegisteredAtResume,
    true,
    "resume 回放事件前，子 record 必须已经在 context.sessions 里",
  );
});
