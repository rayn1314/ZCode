import assert from "node:assert/strict";
import test from "node:test";
import type { PermissionBrokerRequest, SessionId, ToolCallId, TraceId } from "@zcode/contracts";
import { ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV } from "@zcode/shared";
import { createProtocolInteractionBroker } from "../src/zcode-protocol/interaction-broker.js";
import { PERMISSION_AUTO_DENIED_ON_TIMEOUT_CONTENT } from "../src/permission-options.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import { V4InteractionRegistry } from "../src/zcode-protocol-v4/interaction-registry.js";

/**
 * 「没人应答的授权请求会自己收场」的协议面契约（spec: `spec/permission-request-timeout.md`）。
 *
 * 为什么这样测：这个行为的全部机制都在协议 broker + 交互登记表里——"询问发出去、没人答、
 * 到点按 deny 收口"。用**真的**登记表 + 真的 broker，只把客户端换成"永不回答"的桩，就能把
 * 整条生产路径跑一遍：不依赖 provider、不受模型随机性影响、毫秒级。
 *
 * 时钟用与 AskUserQuestion 同一个 E2E 缩放环境变量（300s / 1000 = 300ms）。
 */
const CLOCK_SCALE = "1000";
const SCALED_TIMEOUT_MS = 300_000 / 1000;
/** 断言"没有发生"时要多等一会儿——留出计时抖动余量。 */
const NO_EVENT_WAIT_MS = SCALED_TIMEOUT_MS + 700;

interface Harness {
  context: ZCodeProtocolAgentServerContext;
  registry: V4InteractionRegistry;
  warnings: Array<{ message: string; detail?: unknown }>;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
}

function createHarness(preferences: {
  permissionRequestAutoDenyEnabled?: boolean;
  askUserQuestionAutoResolutionEnabled?: boolean;
}): Harness {
  const registry = new V4InteractionRegistry();
  const warnings: Harness["warnings"] = [];
  const requests: Harness["requests"] = [];
  const context = {
    appRuntimePreferences: { ...preferences },
    deps: { env: { ZCODE_ENV: "test", [ASK_USER_QUESTION_E2E_CLOCK_SCALE_ENV]: CLOCK_SCALE } },
    logger: {
      debug: () => {},
      error: () => {},
      info: () => {},
      warn: (message: string, detail?: unknown) => warnings.push({ message, detail }),
    },
    // 永不回答的客户端。唯一必须实现的行为是"signal 中止时拒绝"：v4 应答命中（含到点自动
    // 收口）时，raceClientRequestWithV4Interaction 会 abort 内部 controller 来结束悬空的反向
    // RPC，真实 host 也是这样拒绝的。
    requestClient: (
      method: string,
      params: Record<string, unknown>,
      _schema: unknown,
      options?: { signal?: AbortSignal },
    ): Promise<never> => {
      requests.push({ method, params });
      return new Promise((_resolve, reject) => {
        const signal = options?.signal;
        const onAbort = () => reject(new Error("protocol client request aborted"));
        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });
      });
    },
    v4Interactions: registry,
  };
  return {
    context: context as unknown as ZCodeProtocolAgentServerContext,
    registry,
    warnings,
    requests,
  };
}

function createRequest(overrides: Partial<PermissionBrokerRequest> = {}): PermissionBrokerRequest {
  return {
    input: { file_path: "E:/tmp/x.txt" },
    mode: "build",
    reason: "Tool Write requires permission",
    requestId: "perm-auto-deny-1",
    requestedAt: new Date(0),
    riskLevel: "medium",
    ruleId: "mode.build.write",
    sessionId: "sess_parent" as SessionId,
    toolCallId: "call-1" as ToolCallId,
    toolName: "Write",
    traceId: "trace-1" as TraceId,
    ...overrides,
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 在 ms 内是否已结束——用来断言"没有发生"（超时没触发 / 门没开）。 */
async function settlesWithin<T>(promise: Promise<T>, ms: number): Promise<boolean> {
  let settled = false;
  const markSettled = () => {
    settled = true;
  };
  const tracked = promise.then(markSettled, markSettled);
  await Promise.race([tracked, delay(ms)]);
  return settled;
}

test("未设置开关字段 = 默认开启：到点自动拒绝，并用独立的超时文案", async () => {
  const { context, registry, warnings, requests } = createHarness({});
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest();

  const result = await broker.requestPermission(request);

  assert.equal(result.decision, "deny");
  // 与"用户拒绝"必须是不同文案：模型据此知道没人应答，而不是用户不同意。
  assert.equal(result.reason, PERMISSION_AUTO_DENIED_ON_TIMEOUT_CONTENT);
  assert.notEqual(result.reason, undefined);
  // 授权副作用必须为零：超时只是拒绝这一次，不是用户给出了任何规则。
  assert.equal(result.permissionUpdates, undefined);
  assert.equal(result.sessionPermissionUpdates, undefined);
  assert.equal(result.reasonSource, undefined);
  // 下发给客户端的确实是这一条询问（父会话 + Write）。
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.params.sessionId, "sess_parent");
  assert.equal(requests[0]?.params.toolName, "Write");
  // 事后能从日志面区分"超时收口"与"用户点了拒绝"。
  assert.equal(
    warnings.some((entry) => entry.message.includes("auto-denied on timeout")),
    true,
  );
  // 收口后登记必须被摘除，否则 UI 上会留下一个永远关不掉的等待胶囊。
  assert.equal(registry.hasPendingForSession("sess_parent"), false);
});

test("用户先应答：用用户的选择，不走超时", async () => {
  const { context, registry } = createHarness({ permissionRequestAutoDenyEnabled: true });
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest();

  const pending = broker.requestPermission(request);
  // 模拟 UI 上的应答到达（与超时走同一条投递路径）。
  await delay(20);
  assert.equal(registry.resolve(request.requestId, { optionId: "allow_once" }), true);

  const result = await pending;
  assert.equal(result.decision, "allow");
  assert.equal(result.reason, "Approved once");
});

test("用户在到点后才点：迟到应答按未命中收口，不影响已生效的拒绝", async () => {
  const { context, registry } = createHarness({ permissionRequestAutoDenyEnabled: true });
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest();

  const result = await broker.requestPermission(request);
  assert.equal(result.decision, "deny");
  // 登记已被摘除 → 迟到的 resolveInteraction 不可能再改变结果。
  assert.equal(registry.resolve(request.requestId, { optionId: "allow_once" }), false);
});

test("关掉开关：授权请求一直等（不自动拒绝）", async () => {
  const { context, registry } = createHarness({ permissionRequestAutoDenyEnabled: false });
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest();

  const pending = broker.requestPermission(request);
  assert.equal(await settlesWithin(pending, NO_EVENT_WAIT_MS), false);
  // 仍然登记着（用户随时可以点）。
  assert.equal(registry.hasPendingForSession("sess_parent"), true);
  // 清场：给它一个应答，避免留下悬空 promise。
  assert.equal(registry.resolve(request.requestId, { optionId: "deny" }), true);
  const result = await pending;
  assert.equal(result.decision, "deny");
});

test("与授权时钟无关的 AskUserQuestion 不受这个开关影响", async () => {
  const { context, registry } = createHarness({
    askUserQuestionAutoResolutionEnabled: false,
    permissionRequestAutoDenyEnabled: true,
  });
  // AskUserQuestion 的时钟是登记表自己的一份（由设置命令驱动），与授权超时开关无关。
  await registry.setAskUserQuestionAutoResolutionEnabled(false);
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest({
    input: {
      questions: [
        {
          header: "H",
          options: [
            { description: "选 A 的理由", label: "A" },
            { description: "选 B 的理由", label: "B" },
          ],
          question: "选哪个？",
        },
      ],
    },
    requestId: "ask-1",
    toolName: "AskUserQuestion",
  });

  const pending = broker.requestPermission(request);
  // 授权超时已到点（缩放后 300ms），这条问题不能因此被收口。
  assert.equal(await settlesWithin(pending, NO_EVENT_WAIT_MS), false);
  assert.equal(registry.hasPendingForSession("sess_parent"), true);
  assert.equal(registry.resolve(request.requestId, { optionId: "A" }), true);
  const result = await pending;
  assert.notEqual(result.reason, PERMISSION_AUTO_DENIED_ON_TIMEOUT_CONTENT);
});

test("退出计划模式的批准同样按同一条时限收口为拒绝", async () => {
  const { context } = createHarness({ permissionRequestAutoDenyEnabled: true });
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest({
    input: { plan: "1. 改 A\n2. 改 B" },
    requestId: "plan-1",
    toolName: "ExitPlanMode",
  });

  const result = await broker.requestPermission(request);
  assert.equal(result.decision, "deny");
  assert.equal(result.reason, PERMISSION_AUTO_DENIED_ON_TIMEOUT_CONTENT);
});

test("重发现重注册不把截止时刻往后推（否则超时永不触发）", async () => {
  const registry = new V4InteractionRegistry();
  const answers: string[] = [];
  const deadline = { afterMs: 200, answer: { optionId: "deny" } };
  const unregister = registry.register(
    "perm-reregister",
    (answer) => {
      answers.push(String(answer.optionId));
    },
    { deadline, kind: "other", sessionId: "sess_parent" },
  );

  // 模拟每秒一次的重发现：同一 interactionId 再登记一次。
  await delay(100);
  const unregisterAgain = registry.register(
    "perm-reregister",
    (answer) => {
      answers.push(String(answer.optionId));
    },
    { deadline, kind: "other", sessionId: "sess_parent" },
  );

  // 若重注册把时钟重置，这里要等到 ~300ms 才会有应答。
  await delay(180);
  assert.deepEqual(answers, ["deny"]);
  assert.equal(registry.hasPendingForSession("sess_parent"), false);
  unregister();
  unregisterAgain();
});

test("到点那一刻开关已关：不收口，转为继续等待", async () => {
  const { context, registry } = createHarness({ permissionRequestAutoDenyEnabled: true });
  const broker = createProtocolInteractionBroker(context);
  const request = createRequest();

  const pending = broker.requestPermission(request);
  // 到点之前把开关关掉：产品语义是"关闭后，当前和后续请求都一直等"。
  await delay(20);
  context.appRuntimePreferences.permissionRequestAutoDenyEnabled = false;

  assert.equal(await settlesWithin(pending, NO_EVENT_WAIT_MS), false);
  assert.equal(registry.hasPendingForSession("sess_parent"), true);
  registry.resolve(request.requestId, { optionId: "deny" });
  await pending;
});
