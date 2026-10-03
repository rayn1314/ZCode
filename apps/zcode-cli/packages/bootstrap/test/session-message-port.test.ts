import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_MESSAGE_MAX_HOP,
  SessionMessageChainExceededError,
  type SessionMailboxEnvelope,
  type SessionMailboxPort,
  type SessionMessageDeliveryRequest,
} from "@zcode/contracts";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  BootstrapSessionMessagePort,
  resolveV4SendResult,
  type SessionMessageDeliveryHost,
  type SessionMessageV4SendInput,
  type SessionMessageV4SendResult,
} from "../src/zcode-protocol/session-message-port.js";
import { createBootstrapSessionMessagePort } from "../src/zcode-protocol/session-message-wiring.js";
import { inputIntentMetadata } from "../src/zcode-protocol-v4/commands/input-intent.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";
import {
  createSessionMailboxPortFromEnv,
  isMessageEnabled,
} from "../src/app/app-config-options.js";

/**
 * 契约：SessionMessagePort 三档投递（spec D3）。
 * 这些用例覆盖 reachable 判定、guide/startNow 选择、mailbox 降级与失败语义；
 * 不依赖真实协议服务器，用窄宿主替身直接验证接口行为。
 */

function createRequest(
  overrides: Partial<SessionMessageDeliveryRequest> = {},
): SessionMessageDeliveryRequest {
  return {
    toSessionId: "sess_target",
    content: "please continue",
    messageId: "msg_abc",
    fromSessionId: "sess_sender",
    senderKind: "session",
    createdAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

interface FakeHostState {
  resident: Set<string>;
  active: Set<string>;
  resumeResult: boolean | "throw";
  resumeCalls: number;
  sendResult: SessionMessageV4SendResult | "throw";
  sends: SessionMessageV4SendInput[];
  stored: SessionMailboxEnvelope[];
  mailboxError?: Error;
}

function createHost(overrides: Partial<FakeHostState> = {}): {
  host: SessionMessageDeliveryHost;
  state: FakeHostState;
} {
  const state: FakeHostState = {
    resident: new Set(["sess_target"]),
    active: new Set(),
    resumeResult: false,
    resumeCalls: 0,
    sendResult: { accepted: true },
    sends: [],
    stored: [],
    ...overrides,
  };
  const mailbox: SessionMailboxPort = {
    async drainUnread() {
      return [];
    },
    async deliver(envelope) {
      if (state.mailboxError) throw state.mailboxError;
      state.stored.push(envelope);
    },
    async consume() {
      return false;
    },
  };
  const host: SessionMessageDeliveryHost = {
    hasResidentSession: (sessionId) => state.resident.has(sessionId),
    hasActiveTurn: (sessionId) => state.active.has(sessionId),
    async ensureSessionResident(sessionId) {
      state.resumeCalls += 1;
      if (state.resumeResult === "throw") throw new Error("cold resume blew up");
      if (state.resumeResult) state.resident.add(sessionId);
      return state.resumeResult === true;
    },
    async sendViaV4(input) {
      if (state.sendResult === "throw") throw new Error("v4 blew up");
      state.sends.push(input);
      return state.sendResult;
    },
    mailbox,
  };
  return { host, state };
}

test("active turn routes a guide delivery and reports steered", async () => {
  const { host, state } = createHost({ active: new Set(["sess_target"]) });
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "steered");
  assert.equal(state.sends.length, 1);
  assert.equal(state.sends[0]?.requestedDelivery, "guide");
  assert.equal(state.stored.length, 0);
  // 来源身份写进投递内容，接收侧可读（spec D4）。
  assert.match(state.sends[0]!.text, /sender_kind="session"/);
  assert.match(state.sends[0]!.text, /from_session="sess_sender"/);
});

test("idle resident target is woken with startNow", async () => {
  const { host, state } = createHost();
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "woken");
  assert.equal(state.sends[0]?.requestedDelivery, "startNow");
  assert.equal(state.stored.length, 0);
});

test("subagent sender keeps its senderKind in the envelope", async () => {
  const { host, state } = createHost();
  await new BootstrapSessionMessagePort(host).deliver(
    createRequest({ senderKind: "subagent", fromSessionId: "sess_subagent_x" }),
  );
  assert.match(state.sends[0]!.text, /sender_kind="subagent"/);
});

test("unreachable target falls back to the mailbox as stored", async () => {
  const { host, state } = createHost({
    resident: new Set(),
    resumeResult: false,
  });
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "stored");
  assert.equal(state.sends.length, 0);
  assert.equal(state.stored.length, 1);
  assert.equal(state.stored[0]?.messageId, "msg_abc");
  assert.equal(state.stored[0]?.senderKind, "session");
});

test("cold target is resumed before delivery", async () => {
  const { host, state } = createHost({ resident: new Set(), resumeResult: true });
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "woken");
  assert.equal(state.sends.length, 1);
  assert.equal(state.stored.length, 0);
});

test("cold resume failure degrades to stored, never drops the message", async () => {
  const { host, state } = createHost({ resident: new Set(), resumeResult: "throw" });
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "stored");
  assert.equal(state.stored.length, 1);
});

test("rejected v4 delivery is stored instead of pretending success", async () => {
  const { host, state } = createHost({
    sendResult: { accepted: false, detail: "failed:fault.command.executionFailed" },
  });
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "stored");
  assert.equal(state.stored.length, 1);
  assert.match(result.detail ?? "", /not accepted/);
});

test("throwing v4 delivery is stored", async () => {
  const { host, state } = createHost({ sendResult: "throw" });
  const result = await new BootstrapSessionMessagePort(host).deliver(createRequest());

  assert.equal(result.status, "stored");
  assert.equal(state.stored.length, 1);
});

// ── 防环链（spec D7）：cap 的唯一裁决点在发送侧端口 ──

test("hop=6 放行，链透传给 v4 投递并出现在注入文本里", async () => {
  const { host, state } = createHost({ active: new Set(["sess_target"]) });
  const chain = { hop: SESSION_MESSAGE_MAX_HOP, originMessageId: "msg_root" };
  const result = await new BootstrapSessionMessagePort(host).deliver(
    createRequest({ sessionMessageChain: chain }),
  );

  assert.equal(result.status, "steered");
  assert.deepEqual(state.sends[0]?.sessionMessageChain, chain);
  // 模型自己也要看得到链深（spec 行为 7）。
  assert.match(state.sends[0]!.text, /hop="6"/);
  assert.match(state.sends[0]!.text, /origin="msg_root"/);
});

test("hop=7 是拒绝：不落盘、不冷恢复、不投递", async () => {
  const { host, state } = createHost({ resident: new Set(), resumeResult: false });
  await assert.rejects(
    () =>
      new BootstrapSessionMessagePort(host).deliver(
        createRequest({ sessionMessageChain: { hop: 7, originMessageId: "msg_root" } }),
      ),
    (error: unknown) => {
      assert.ok(error instanceof SessionMessageChainExceededError);
      assert.equal(error.hop, 7);
      assert.equal(error.originMessageId, "msg_root");
      assert.equal(error.toSessionId, "sess_target");
      assert.match(error.message, new RegExp(`max ${SESSION_MESSAGE_MAX_HOP}`));
      return true;
    },
  );
  assert.equal(state.stored.length, 0, "拒绝不得降级成 stored");
  assert.equal(state.sends.length, 0);
  assert.equal(state.resumeCalls, 0, "拒绝发生在冷恢复之前，不得唤醒或拉起目标");
});

test("不可达目标落 mailbox 时信封带上 chain，并原样上报给跨进程路由", async () => {
  const { host, state } = createHost({ resident: new Set(), resumeResult: false });
  const chain = { hop: 2, originMessageId: "msg_root" };
  const result = await new BootstrapSessionMessagePort(host).deliver(
    createRequest({ sessionMessageChain: chain }),
  );

  assert.equal(result.status, "stored");
  assert.deepEqual(state.stored[0]?.chain, chain);
});

test("input-intent：链写进 TurnInputIntentMetadata，缺席不产生该字段", () => {
  const envelope = {
    type: "sendText",
    commandId: "cmd_1",
    clientId: "cli",
  } as unknown as CommandEnvelope;

  const withChain = inputIntentMetadata(envelope, {
    text: "hi",
    requestedDelivery: "startNow",
    sessionMessageChain: { hop: 2, originMessageId: "msg_root" },
  });
  assert.deepEqual(withChain.sessionMessageChain, { hop: 2, originMessageId: "msg_root" });

  const without = inputIntentMetadata(envelope, { text: "hi", requestedDelivery: "startNow" });
  assert.equal("sessionMessageChain" in without, false);
});

test("mailbox write failure surfaces instead of claiming stored", async () => {
  const { host } = createHost({
    resident: new Set(),
    resumeResult: false,
    mailboxError: new Error("mailbox read-only"),
  });
  await assert.rejects(
    () => new BootstrapSessionMessagePort(host).deliver(createRequest()),
    /mailbox read-only/,
  );
});

test("resolveV4SendResult treats duplicate as an accepted delivery", () => {
  assert.deepEqual(
    resolveV4SendResult({
      commandId: "c1",
      status: "duplicate",
      revisionAtDecision: 0,
      result: { type: "inputAccepted", delivery: "startNow", inputId: "c1" },
    }),
    { accepted: true },
  );
  assert.deepEqual(
    resolveV4SendResult({
      commandId: "c2",
      status: "rejected",
      reasonCode: "proto.sessionNotFound",
      revisionAtDecision: 0,
    }),
    { accepted: false, detail: "rejected:proto.sessionNotFound" },
  );
});

// ── 装配层：假的 context + gateway，验证真正发给 v4 命令面的信封形状 ──

interface WiringFixture {
  context: ZCodeProtocolAgentServerContext;
  mailbox: SessionMailboxPort;
  envelopes: unknown[];
  stored: SessionMailboxEnvelope[];
  notifications: Array<{ method: string; params: unknown }>;
}

function createWiringFixture(options: {
  resident: boolean;
  active: boolean;
  gatewayAbsent?: boolean;
}): WiringFixture {
  const envelopes: unknown[] = [];
  const stored: SessionMailboxEnvelope[] = [];
  const notifications: Array<{ method: string; params: unknown }> = [];
  const sessions = new Map<string, { app: { runtime: { getActiveTurnInfo(): unknown } } }>();
  if (options.resident) {
    sessions.set("sess_target", {
      app: {
        runtime: { getActiveTurnInfo: () => (options.active ? { turnId: "t1" } : undefined) },
      },
    });
  }
  const gateway = options.gatewayAbsent
    ? undefined
    : {
        async handleCommand(raw: unknown) {
          envelopes.push(raw);
          return {
            commandId: "x",
            status: "accepted",
            revisionAtDecision: 0,
            result: { type: "inputAccepted", delivery: "guide", inputId: "x" },
          };
        },
      };
  const mailbox: SessionMailboxPort = {
    async drainUnread() {
      return [];
    },
    async deliver(envelope) {
      stored.push(envelope);
    },
    async consume() {
      return false;
    },
  };
  const context = {
    sessions,
    v4Gateway: gateway,
    notify: (notification: { method: string; params: unknown }) => {
      notifications.push(notification);
    },
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, mailbox, envelopes, stored, notifications };
}

test("wiring builds a sendText command envelope for a resident target", async () => {
  const fixture = createWiringFixture({ resident: true, active: true });
  const port = createBootstrapSessionMessagePort(fixture.context, fixture.mailbox);
  const result = await port.deliver(createRequest());

  assert.equal(result.status, "steered");
  assert.equal(fixture.envelopes.length, 1);
  const envelope = fixture.envelopes[0] as {
    clientId: string;
    commandId: string;
    issuedAt: string;
    payload: { requestedDelivery: string; text: string };
    sessionId: string;
    type: string;
  };
  assert.equal(envelope.type, "sendText");
  assert.equal(envelope.clientId, "session-message-port");
  assert.equal(envelope.commandId, "session-message:msg_abc");
  assert.equal(envelope.sessionId, "sess_target");
  assert.equal(envelope.payload.requestedDelivery, "guide");
  assert.match(envelope.payload.text, /<session-message /);
  assert.equal(fixture.stored.length, 0);
});

test("wiring：链必须显式进 sendText payload（zod object 会静默剥离未知键）", async () => {
  const fixture = createWiringFixture({ resident: true, active: false });
  const port = createBootstrapSessionMessagePort(fixture.context, fixture.mailbox);
  await port.deliver(createRequest({ sessionMessageChain: { hop: 3, originMessageId: "msg_root" } }));

  const envelope = fixture.envelopes[0] as {
    payload: { sessionMessageChain?: unknown };
  };
  assert.deepEqual(envelope.payload.sessionMessageChain, { hop: 3, originMessageId: "msg_root" });
});

test("wiring degrades to mailbox when the v4 gateway is absent", async () => {
  const fixture = createWiringFixture({ resident: true, active: false, gatewayAbsent: true });
  const port = createBootstrapSessionMessagePort(fixture.context, fixture.mailbox);
  const result = await port.deliver(createRequest());

  assert.equal(result.status, "stored");
  assert.equal(fixture.stored.length, 1);
  // 持久副本已落盘，必须上报跨进程实时路由（CLI 触达不到 services 事件发射器）。
  assert.equal(fixture.notifications.length, 1);
  const notification = fixture.notifications[0]!;
  assert.equal(notification.method, "v4/session/message-send-requested");
  assert.deepEqual((notification.params as { request: unknown }).request, {
    content: "please continue",
    createdAt: "2026-10-03T00:00:00.000Z",
    fromSessionId: "sess_sender",
    messageId: "msg_abc",
    requestId: "session-message:msg_abc",
    toSessionId: "sess_target",
    senderKind: "session",
  });
});

test("resident targets do not emit the cross-process signal", async () => {
  const fixture = createWiringFixture({ resident: true, active: false });
  const port = createBootstrapSessionMessagePort(fixture.context, fixture.mailbox);
  await port.deliver(createRequest());
  assert.deepEqual(fixture.notifications, []);
});

// ── 开关默认开启（spec 阶段 3）：只有显式 0/false 才关闭 ──

test("message capability defaults on and only explicit 0/false disables it", () => {
  assert.equal(isMessageEnabled({}), true);
  assert.equal(isMessageEnabled({ ZCODE_MESSAGE_ENABLED: "1" }), true);
  assert.equal(isMessageEnabled({ ZCODE_MESSAGE_ENABLED: "true" }), true);
  assert.equal(isMessageEnabled({ ZCODE_MESSAGE_ENABLED: "0" }), false);
  assert.equal(isMessageEnabled({ ZCODE_MESSAGE_ENABLED: "false" }), false);
  assert.equal(isMessageEnabled({ ZCODE_MESSAGE_ENABLED: "  FALSE " }), false);
});

test("mailbox port is assembled by default and absent when disabled", () => {
  assert.notEqual(createSessionMailboxPortFromEnv({}), undefined);
  assert.equal(createSessionMailboxPortFromEnv({ ZCODE_MESSAGE_ENABLED: "0" }), undefined);
});
