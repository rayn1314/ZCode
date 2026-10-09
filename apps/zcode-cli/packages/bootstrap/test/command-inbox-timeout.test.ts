// Command execute deadline 契约（spec `spec/command-inbox-timeout.md`）：
// 1) execute 永不 resolve → deadline 到点强制 failed 终态，session/@global FIFO gate 必须释放；
// 2) 迟到的正常 settle 不改写终态、不二次释放 gate；
// 3) commands/query 不跟随 execute 挂死，单 key 在 conversationQueryTimeoutMs 内收口。
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommandAck,
  CommandEnvelope,
  CommandResult,
  ConversationInputIntent,
} from "@zcode/shared/zcode-protocol-v4";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";

const SESSION = "sess_inbox_timeout";
/** 测试注入值：真实默认值 60s/10s 见 PROTOCOL_V4_LIMITS（注释里写明了依据）。 */
const EXECUTE_TIMEOUT_MS = 80;
const QUERY_TIMEOUT_MS = 40;
/** 外层看门狗：远小于它才说明「没在等 60s/10s 的真实上限」，又足够宽不误报慢 CI。 */
const GUARD_MS = 2_000;

function never<T>(): Promise<T> {
  return new Promise<T>(() => {});
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), GUARD_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function stopEnvelope(sessionId: string, commandId: string): CommandEnvelope {
  return {
    commandId,
    clientId: "test-client",
    sessionId,
    type: "stop",
    payload: {},
    issuedAt: Date.now(),
  };
}

function createSessionEnvelope(commandId: string): CommandEnvelope {
  return {
    commandId,
    clientId: "test-client",
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: "ws_timeout_test" },
    issuedAt: Date.now(),
  };
}

interface HarnessOptions {
  commandExecuteTimeoutMs?: number;
  conversationQueryTimeoutMs?: number;
  lookupTranscriptCommand?: V4GatewayHost["lookupTranscriptCommand"];
  admitCommandInput?: V4GatewayHost["admitCommandInput"];
  cancelCommandInput?: V4GatewayHost["cancelCommandInput"];
}

function createHarness(options: HarnessOptions = {}) {
  const errors: Array<{ scope: string; error: unknown }> = [];
  let execute: (envelope: CommandEnvelope) => Promise<CommandResult | undefined> = () =>
    Promise.resolve(undefined);
  const host: V4GatewayHost = {
    sessionExists: () => true,
    emitWireFrame: () => {},
    executeCommand: (envelope) => execute(envelope),
    lookupTranscriptCommand: options.lookupTranscriptCommand,
    admitCommandInput: options.admitCommandInput,
    cancelCommandInput: options.cancelCommandInput,
    onError: (scope, error) => {
      errors.push({ scope, error });
    },
  };
  const gateway = new ConversationV4Gateway(host, {
    commandExecuteTimeoutMs: options.commandExecuteTimeoutMs ?? EXECUTE_TIMEOUT_MS,
    conversationQueryTimeoutMs: options.conversationQueryTimeoutMs ?? QUERY_TIMEOUT_MS,
  });
  return {
    gateway,
    errors,
    setExecute(fn: (envelope: CommandEnvelope) => Promise<CommandResult | undefined>): void {
      execute = fn;
    },
    dispose: () => gateway.dispose(),
  };
}

async function queryOne(
  gateway: ConversationV4Gateway,
  sessionId: string | null,
  commandId: string,
): Promise<CommandAck | "unknown"> {
  const result = await gateway.queryCommands({ commands: [{ sessionId, commandId }] });
  const [item] = result.results;
  assert.ok(item, `queryCommands 必须返回 ${commandId} 的结果`);
  return item.result;
}

test("execute 永不 resolve：deadline 到点 failed 收口，同会话后续命令不被 gate 卡死", async () => {
  const harness = createHarness();
  let releaseHang!: () => void;
  const hang = new Promise<void>((resolve) => {
    releaseHang = resolve;
  });
  harness.setExecute((envelope) =>
    envelope.commandId === "cmd_hang" ? hang.then(() => undefined) : Promise.resolve(undefined),
  );

  const hangAck = await withTimeout(
    harness.gateway.handleCommand(stopEnvelope(SESSION, "cmd_hang")),
    "deadline 到点后 handleCommand 必须返回 ACK（不能永久挂起）",
  );
  assert.equal(hangAck.status, "failed");
  assert.equal(hangAck.reasonCode, "fault.command.executeTimeout");
  assert.match(hangAck.message ?? "", /命令执行超时/);
  assert.ok(
    harness.errors.some((entry) => entry.scope === "v4.command.execute.timeout"),
    "超时必须打 error 日志",
  );

  // session FIFO gate 已释放：同会话下一条命令能完整走完 admission + execute。
  const okAck = await withTimeout(
    harness.gateway.handleCommand(stopEnvelope(SESSION, "cmd_ok")),
    "超时后同会话后续命令必须能完成（gate 不得泄漏）",
  );
  assert.equal(okAck.status, "accepted");
  assert.doesNotThrow(
    () => harness.gateway.assertSessionRuntimeDeactivatable(SESSION),
    "超时后 inbox 不得残留 pinned 状态",
  );

  // 迟到 settle 无副作用：挂死的 execute 事后完成，不改写终态、不破坏后续 gate。
  releaseHang();
  await delay(20);
  const late = await queryOne(harness.gateway, SESSION, "cmd_hang");
  assert.ok(late !== "unknown");
  assert.equal(late.status, "failed");
  assert.equal(late.reasonCode, "fault.command.executeTimeout");

  const laterAck = await withTimeout(
    harness.gateway.handleCommand(stopEnvelope(SESSION, "cmd_later")),
    "迟到 settle 不得破坏 session FIFO gate",
  );
  assert.equal(laterAck.status, "accepted");
  harness.dispose();
});

test("createSession（@global 桶）execute 挂死同样被收口，不阻塞后续 createSession", async () => {
  const harness = createHarness();
  harness.setExecute((envelope) =>
    envelope.commandId === "cmd_create_hang"
      ? never<CommandResult | undefined>()
      : Promise.resolve(undefined),
  );

  const ack = await withTimeout(
    harness.gateway.handleCommand(createSessionEnvelope("cmd_create_hang")),
    "createSession 挂死必须在 deadline 内返回 ACK",
  );
  assert.equal(ack.status, "failed");
  assert.equal(ack.reasonCode, "fault.command.executeTimeout");

  const next = await withTimeout(
    harness.gateway.handleCommand(createSessionEnvelope("cmd_create_ok")),
    "@global 桶必须被超时释放（后续 createSession 不得永久等待）",
  );
  assert.equal(next.status, "accepted");
  harness.dispose();
});

test("commands/query 不跟随 execute 挂死：在途命令在查询上限内回 admission ACK", async () => {
  const harness = createHarness({
    commandExecuteTimeoutMs: 10_000,
    conversationQueryTimeoutMs: QUERY_TIMEOUT_MS,
  });
  harness.setExecute(() => never<CommandResult | undefined>());
  const rejections: unknown[] = [];
  void harness.gateway
    .handleCommand(stopEnvelope(SESSION, "cmd_inflight"))
    .catch((error) => rejections.push(error));

  const startedAt = Date.now();
  // 外层看门狗同时保证测试进程在等待期间有 ref 计时器（查询定时器是 unref 的）。
  const result = await withTimeout(
    queryOne(harness.gateway, SESSION, "cmd_inflight"),
    "query 必须在查询上限内返回（不得跟随 execute 挂死到 10s 上限）",
  );
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 1_000, `query 必须在查询上限内返回，实际 ${elapsed}ms`);
  assert.ok(result !== "unknown");
  // 在途事实的诚实答案：还没定论，客户端稍后重查即可拿到终态。
  assert.equal(result.status, "accepted");
  assert.deepEqual(rejections, []);
  harness.dispose();
});

test("commands/query 撞上挂起的宿主 lookup：查询上限内回 queryUnavailable，且不占住 key gate", async () => {
  let firstLookup = true;
  const harness = createHarness({
    conversationQueryTimeoutMs: QUERY_TIMEOUT_MS,
    lookupTranscriptCommand: (key) => {
      if (key.commandId === "cmd_lookup_hang" && firstLookup) {
        firstLookup = false;
        return never<CommandAck | null>();
      }
      return null;
    },
  });

  const result = await withTimeout(
    queryOne(harness.gateway, SESSION, "cmd_lookup_hang"),
    "query 必须在查询上限内返回（不得跟随宿主 lookup 挂死）",
  );
  assert.ok(result !== "unknown");
  assert.equal(result.status, "failed");
  assert.equal(result.reasonCode, "fault.command.queryUnavailable");

  // key gate 已随超时提前释放：同 key 的 handle 不再被卡住的 lookup 拖住。
  harness.setExecute(() => Promise.resolve(undefined));
  const ack = await withTimeout(
    harness.gateway.handleCommand(stopEnvelope(SESSION, "cmd_lookup_hang")),
    "query 超时后同 key handle 必须能完成（key gate 不得泄漏）",
  );
  assert.equal(ack.status, "accepted");
  harness.dispose();
});

test("超时后迟到的 admission：只回收它自己的 pin 与 durable input，不改写 failed 终态", async () => {
  const canceledReasons: string[] = [];
  let admitIntent!: (intent: ConversationInputIntent) => void;
  const admission = new Promise<ConversationInputIntent>((resolve) => {
    admitIntent = resolve;
  });
  const harness = createHarness({
    admitCommandInput: () => admission,
    cancelCommandInput: (_envelope, _queueItemId, reason) => {
      canceledReasons.push(reason);
      return Promise.resolve();
    },
  });
  harness.setExecute(() => never<CommandResult | undefined>());

  const ack = await withTimeout(
    harness.gateway.handleCommand(stopEnvelope(SESSION, "cmd_late_admit")),
    "admission 挂起也必须在 deadline 内返回 ACK",
  );
  assert.equal(ack.status, "failed");
  assert.equal(ack.reasonCode, "fault.command.executeTimeout");

  // admission 在超时之后才落定：它建立的 live pin 随后必须被回收，
  // durable input 也必须按超时原因取消——但终态保持超时 failed。
  admitIntent({
    sourceCommandId: "cmd_late_admit",
    queueItemId: "queue_cmd_late_admit",
    clientId: "test-client",
    // pin/release 只读 sourceCommandId，其余字段不参与本契约。
  } as unknown as ConversationInputIntent);
  await delay(20);

  assert.deepEqual(canceledReasons, ["fault.command.executeTimeout"]);
  assert.doesNotThrow(
    () => harness.gateway.assertSessionRuntimeDeactivatable(SESSION),
    "迟到 admission 回收后不得残留 pinned 状态",
  );
  const settled = await queryOne(harness.gateway, SESSION, "cmd_late_admit");
  assert.ok(settled !== "unknown");
  assert.equal(settled.status, "failed");
  assert.equal(settled.reasonCode, "fault.command.executeTimeout");
  harness.dispose();
});
