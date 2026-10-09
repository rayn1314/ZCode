import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import type {
  SessionMessageMailboxEnvelope,
  SessionMessageMailboxPort,
  SessionMessageSendRequested,
} from "../src/session/sessionMailbox.js";
import type { ZCodeAgentSessionMessageSendRequested } from "../src/zcode-agent/zcodeAgent.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

/**
 * 契约：跨进程会话消息的目标侧投递（spec 阶段 3）。
 * 覆盖实时投递（永不使用会抢占回合的 startNow）、不可达落 mailbox、实时命中后的 mailbox 去重，
 * 以及回执投回源会话。用窄替身直接驱动 adapter，不启动真实 Agent。
 */

const TARGET_SESSION = "sess_target";
const SOURCE_SESSION = "sess_source";
const WORKSPACE = "/example/workspace";

interface FixtureState {
  sendStatus: "accepted" | "rejected";
  mailboxEnabled: boolean;
  mailboxError?: Error;
  remembered: string[];
}

interface Fixture {
  service: ReturnType<typeof createZCodeTaskServiceAdapter>;
  state: FixtureState;
  envelopes: CommandEnvelope[];
  delivered: SessionMessageMailboxEnvelope[];
  consumed: Array<{ sessionId: string; messageId: string }>;
  forwarded: SessionMessageSendRequested[];
  emitSessionMessageRequest(event: ZCodeAgentSessionMessageSendRequested): void;
  payloadOf(index: number): { requestedDelivery?: string; text: string };
}

function createFixture(state?: Partial<FixtureState>): Fixture {
  const resolved: FixtureState = {
    sendStatus: "accepted",
    mailboxEnabled: true,
    remembered: [TARGET_SESSION, SOURCE_SESSION],
    ...state,
  };
  const envelopes: CommandEnvelope[] = [];
  const delivered: SessionMessageMailboxEnvelope[] = [];
  const consumed: Array<{ sessionId: string; messageId: string }> = [];
  const mailbox: SessionMessageMailboxPort = {
    async deliver(envelope) {
      if (resolved.mailboxError) throw resolved.mailboxError;
      delivered.push(envelope);
    },
    async consume(input) {
      if (resolved.mailboxError) throw resolved.mailboxError;
      consumed.push(input);
      return true;
    },
  };
  const disposable = () => ({ dispose() {} });
  const forwarded: SessionMessageSendRequested[] = [];
  let sessionMessageListener: ((event: ZCodeAgentSessionMessageSendRequested) => void) | undefined;
  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async sendConversationCommandV4(params: { envelope: CommandEnvelope }) {
        envelopes.push(params.envelope);
        return resolved.sendStatus === "accepted"
          ? { commandId: params.envelope.commandId, status: "accepted", revisionAtDecision: 0 }
          : {
              commandId: params.envelope.commandId,
              status: "rejected",
              reasonCode: "proto.sessionNotFound",
              revisionAtDecision: 0,
            };
      },
      disposeAll() {},
      onDynamicSessionEvent() {
        return () => disposable();
      },
      onDynamicSessionMessageSendRequested() {
        return (listener: (event: ZCodeAgentSessionMessageSendRequested) => void) => {
          sessionMessageListener = listener;
          return disposable();
        };
      },
    },
    taskIndexRepo: {},
    taskIndexSyncer: {
      ensureSessionSubscription() {},
      onSessionTerminalEvent: () => disposable(),
      onSessionReadyEvent: () => disposable(),
      disposeAll() {},
    },
    forwardSessionMessageSendRequested(request: SessionMessageSendRequested) {
      forwarded.push(request);
    },
    ...(resolved.mailboxEnabled ? { sessionMessageMailbox: mailbox } : {}),
  } as unknown as Parameters<typeof createZCodeTaskServiceAdapter>[0]);

  for (const taskId of resolved.remembered) {
    // 订阅入口顺带 rememberTaskTarget，等价于 Host 侧"该会话已加载"。
    service.onDynamicTaskEvent({ taskId, workspacePath: WORKSPACE, deliveryKind: "continuous" })(
      () => {},
    );
  }

  return {
    service,
    state: resolved,
    envelopes,
    delivered,
    consumed,
    forwarded,
    emitSessionMessageRequest(event) {
      assert.ok(sessionMessageListener, "adapter did not subscribe to session message requests");
      sessionMessageListener(event);
    },
    payloadOf(index: number) {
      return envelopes[index]!.payload as {
        requestedDelivery?: string;
        text: string;
        sessionMessageChain?: { hop: number; originMessageId: string };
      };
    },
  };
}

function createRequest(overrides: Partial<SessionMessageSendRequested> = {}) {
  return {
    content: "please continue",
    createdAt: "2026-10-03T00:00:00.000Z",
    fromSessionId: SOURCE_SESSION,
    messageId: "msg_1",
    requestId: "req_1",
    toSessionId: TARGET_SESSION,
    senderKind: "subagent" as const,
    ...overrides,
  };
}

test("空闲目标也用 guide 投递（不用会抢占回合的 startNow），并在命中后消费掉持久副本", async () => {
  const fixture = createFixture();
  const result = await fixture.service.deliverSessionMessage(createRequest());

  assert.deepEqual(result, {
    messageId: "msg_1",
    requestId: "req_1",
    sessionId: SOURCE_SESSION,
    status: "success",
  });
  assert.equal(fixture.envelopes.length, 1);
  const envelope = fixture.envelopes[0]!;
  assert.equal(envelope.type, "sendText");
  assert.equal(envelope.sessionId, TARGET_SESSION);
  // 幂等键与 CLI 直投同源（审计修复 #3）：由 messageId 派生而非 requestId，
  // 两键共享 CommandInbox 去重，ACK 丢失重投不会二次注入。
  assert.equal(envelope.commandId, "session-message:msg_1");
  // 提交端标记为会话消息机器（审计修复 #4）：接收侧据此不清防环链。
  assert.equal(envelope.clientId, "session-message-port");
  const payload = fixture.payloadOf(0);
  // 跨进程只能拿到滞后的事件投影，无法权威确认目标是否空闲；startNow 会抢占并中止运行中回合，
  // 所以实时投递一律用 guide，由目标 CLI 的 admission 自行裁决（忙则引导/排队，闲则开轮）。
  assert.equal(payload.requestedDelivery, "guide");
  assert.match(payload.text, /<session-message source="session-message"/);
  assert.match(payload.text, /from_session="sess_source"/);
  // 来源身份必须保留（spec D4），否则接收方无法区分附属子代理与正式会话。
  assert.match(payload.text, /sender_kind="subagent"/);
  // 实时命中即清持久副本，避免 live 注入 + 下次 drain 重复投递。
  assert.deepEqual(fixture.consumed, [{ sessionId: TARGET_SESSION, messageId: "msg_1" }]);
  assert.deepEqual(fixture.delivered, []);
});

test("有活动回合的目标同样用 guide 注入，投递分档不随投影变化", async () => {
  const fixture = createFixture();
  // 让目标会话进入活动回合：sendPrompt 会记录 active input。
  await fixture.service.sendPrompt({ taskId: TARGET_SESSION, traceId: "in_1", content: "seed" });
  fixture.envelopes.length = 0;

  const result = await fixture.service.deliverSessionMessage(createRequest());
  assert.equal(result.status, "success");
  assert.equal(fixture.payloadOf(0).requestedDelivery, "guide");
  assert.deepEqual(fixture.consumed, [{ sessionId: TARGET_SESSION, messageId: "msg_1" }]);
});

test("目标不在本 Host 时落 mailbox 并回 success（持久副本已存在）", async () => {
  const fixture = createFixture({ remembered: [SOURCE_SESSION] });
  const result = await fixture.service.deliverSessionMessage(createRequest());

  assert.equal(result.status, "success");
  assert.deepEqual(fixture.envelopes, []);
  assert.equal(fixture.delivered.length, 1);
  assert.deepEqual(fixture.delivered[0], {
    version: 1,
    messageId: "msg_1",
    fromSessionId: SOURCE_SESSION,
    toSessionId: TARGET_SESSION,
    content: "please continue",
    createdAt: "2026-10-03T00:00:00.000Z",
    senderKind: "subagent",
  });
  // 不可达时没有实时命中，不能消费掉待 drain 的信封。
  assert.deepEqual(fixture.consumed, []);
});

test("v4 投递被拒退回 mailbox，不假装投递成功", async () => {
  const fixture = createFixture({ sendStatus: "rejected" });
  const result = await fixture.service.deliverSessionMessage(createRequest());

  assert.equal(result.status, "success");
  assert.equal(fixture.envelopes.length, 1);
  assert.equal(fixture.delivered.length, 1);
  assert.deepEqual(fixture.consumed, []);
});

test("实时投递把防环链放进 v4 payload，并写进注入文本（spec D7）", async () => {
  const fixture = createFixture();
  const chain = { hop: 3, originMessageId: "msg_root" };
  const result = await fixture.service.deliverSessionMessage(
    createRequest({ sessionMessageChain: chain }),
  );

  assert.equal(result.status, "success");
  assert.deepEqual(fixture.payloadOf(0).sessionMessageChain, chain);
  assert.match(fixture.payloadOf(0).text, /hop="3"/);
  assert.match(fixture.payloadOf(0).text, /origin="msg_root"/);
});

test("接收侧不做 cap 裁决：hop 超大仍投递，不因链深丢消息", async () => {
  const fixture = createFixture();
  const result = await fixture.service.deliverSessionMessage(
    createRequest({ sessionMessageChain: { hop: 99, originMessageId: "msg_root" } }),
  );

  assert.equal(result.status, "success");
  assert.equal(fixture.envelopes.length, 1, "拒绝只发生在发送侧端口，接收侧不得丢弃");
  assert.deepEqual(fixture.delivered, []);
});

test("不可达兜底落盘的信封带 chain，供目标 CLI drain 时续链", async () => {
  const fixture = createFixture({ remembered: [SOURCE_SESSION] });
  const chain = { hop: 2, originMessageId: "msg_root" };
  const result = await fixture.service.deliverSessionMessage(
    createRequest({ sessionMessageChain: chain }),
  );

  assert.equal(result.status, "success");
  assert.deepEqual(fixture.delivered[0]?.chain, chain);
});

test("mailbox 写失败时返回 failed 并带原因", async () => {
  const fixture = createFixture({
    remembered: [SOURCE_SESSION],
    mailboxError: new Error("mailbox read-only"),
  });
  const result = await fixture.service.deliverSessionMessage(createRequest());

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /mailbox read-only/);
  assert.match(result.error ?? "", /not loaded in this host/);
});

test("消息能力关闭（无 mailbox）时不可达目标是失败而非静默成功", async () => {
  const fixture = createFixture({ remembered: [SOURCE_SESSION], mailboxEnabled: false });
  const result = await fixture.service.deliverSessionMessage(createRequest());

  assert.equal(result.status, "failed");
  assert.match(result.error ?? "", /session mailbox is not configured/);
});

test("源会话空闲时不投回执：v4 admission 会让 queue/guide 开新轮，回执不得唤醒空闲会话", async () => {
  const fixture = createFixture();
  await fixture.service.sendSessionMessageDeliveryResult({
    messageId: "msg_1",
    requestId: "req_1",
    sessionId: SOURCE_SESSION,
    status: "success",
  });

  // 回执是补充通知，发送侧工具已同步拿到结果；唤醒空闲源会话得不偿失，直接跳过。
  assert.deepEqual(fixture.envelopes, []);
});

test("源会话正在跑回合时才投回执，且用不抢占的 guide", async () => {
  const fixture = createFixture();
  // 让源会话进入活动回合：sendPrompt 会记录 active input。
  await fixture.service.sendPrompt({ taskId: SOURCE_SESSION, traceId: "in_src", content: "seed" });
  fixture.envelopes.length = 0;

  await fixture.service.sendSessionMessageDeliveryResult({
    messageId: "msg_1",
    requestId: "req_1",
    sessionId: SOURCE_SESSION,
    status: "success",
  });

  assert.equal(fixture.envelopes.length, 1);
  const envelope = fixture.envelopes[0]!;
  assert.equal(envelope.type, "sendText");
  assert.equal(envelope.sessionId, SOURCE_SESSION);
  // 回执同样带会话消息提交端（审计修复 #4）：目标若恰好已空闲开新轮，
  // 这条无链输入不得被当成"人类插话"清掉防环链。
  assert.equal(envelope.clientId, "session-message-port");
  const payload = fixture.payloadOf(0);
  assert.equal(payload.requestedDelivery, "guide");
  assert.match(payload.text, /<session-message source="delivery-result"/);
  assert.match(payload.text, /For reference only/);
});

test("回执的源会话不在本 Host 时丢弃，不抛错", async () => {
  const fixture = createFixture({ remembered: [TARGET_SESSION] });
  await fixture.service.sendSessionMessageDeliveryResult({
    messageId: "msg_1",
    requestId: "req_1",
    sessionId: SOURCE_SESSION,
    status: "failed",
    error: "target session not found",
  });
  assert.deepEqual(fixture.envelopes, []);
});

test("CLI 上报的跨进程请求经 adapter 转给 forwardSessionMessageSendRequested", async () => {
  const fixture = createFixture();
  fixture.emitSessionMessageRequest({
    request: createRequest(),
    workspacePath: WORKSPACE,
  });
  assert.deepEqual(fixture.forwarded, [createRequest()]);
});
