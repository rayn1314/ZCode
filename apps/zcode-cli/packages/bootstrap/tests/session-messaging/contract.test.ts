// session-messaging 契约测试：投递端口的三档落地语义、拒绝语义与防环链三态。
// 只 import 本模块自己的文件（契约 + 实现）。
import { describe, expect, it } from "vitest";
import {
  BootstrapSessionMessagePort,
  SESSION_MESSAGE_CLIENT_ID,
  SESSION_MESSAGE_MAX_HOP,
  SessionMessageChainExceededError,
  SessionMessageUndeliverableError,
  resolveV4SendResult,
  sessionMessageV4CommandId,
  type SessionMessageDeliveryHost,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  type SessionMessageV4SendInput,
} from "../../src/session-messaging/contract.js";
import { inboundChainIntentAction } from "../../../core/src/runtime/methods/session-message-chain.js";

type MailboxEnvelope = Parameters<SessionMessageDeliveryHost["mailbox"]["deliver"]>[0];
type CommandAck = Parameters<typeof resolveV4SendResult>[0];

/** 投递 host 的最小真实实现：三档可达性的开关 + 记录投递层实际收到的输入。 */
function createHost(overrides: {
  resident?: boolean;
  active?: boolean;
  exists?: boolean;
  resume?: boolean;
  sendResult?: { accepted: boolean; detail?: string } | Error;
}) {
  const sent: SessionMessageV4SendInput[] = [];
  const stored: MailboxEnvelope[] = [];
  const notifications: { method: string; params: unknown }[] = [];
  const host: SessionMessageDeliveryHost = {
    hasResidentSession: () => overrides.resident ?? true,
    hasActiveTurn: () => overrides.active ?? false,
    ensureSessionResident: async () => overrides.resume ?? true,
    sessionExists: async () => overrides.exists ?? true,
    sendViaV4: async (input) => {
      sent.push(input);
      const result = overrides.sendResult ?? { accepted: true };
      if (result instanceof Error) throw result;
      return result;
    },
    mailbox: {
      drainUnread: async () => [],
      deliver: async (envelope) => {
        stored.push(envelope);
      },
      consume: async () => false,
      restoreToUnread: async () => {},
    },
    notify: (notification) => {
      notifications.push(notification);
    },
  };
  return { host, sent, stored, notifications };
}

function request(
  overrides: Partial<SessionMessageDeliveryRequest> = {},
): SessionMessageDeliveryRequest {
  return {
    toSessionId: "sess_target",
    fromSessionId: "sess_source",
    content: "请确认",
    messageId: "msg_1",
    senderKind: "session",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function notificationRequest(notification: { params: unknown } | undefined): {
  messageId: string;
  requestId: string;
} {
  const params = notification?.params as { request: { messageId: string; requestId: string } };
  return params.request;
}

describe("跨会话投递端口", () => {
  it("链深超限是拒绝：不投递、不落盘，并把链首与深度交回调用方", async () => {
    const { host, sent, stored } = createHost({});
    const port = new BootstrapSessionMessagePort(host);

    const error = await port
      .deliver(
        request({
          sessionMessageChain: { originMessageId: "msg_origin", hop: SESSION_MESSAGE_MAX_HOP + 1 },
        }),
      )
      .then(
        () => undefined,
        (thrown: unknown) => thrown,
      );

    expect(error).toBeInstanceOf(SessionMessageChainExceededError);
    expect((error as SessionMessageChainExceededError).originMessageId).toBe("msg_origin");
    expect((error as SessionMessageChainExceededError).hop).toBe(SESSION_MESSAGE_MAX_HOP + 1);
    // 拒绝不是降级：既不写 mailbox 也不经 v4 投递。
    expect(sent).toHaveLength(0);
    expect(stored).toHaveLength(0);
  });

  it("目标在 store 里不存在是硬失败：不落 mailbox（不存在的会话没有 drainer）", async () => {
    const { host, stored, sent } = createHost({ resident: false, resume: false, exists: false });
    const port = new BootstrapSessionMessagePort(host);

    await expect(port.deliver(request())).rejects.toBeInstanceOf(SessionMessageUndeliverableError);
    expect(stored).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("冷恢复不出但会话存在：落 mailbox 返回 stored，并按 messageId 派生关联键上报", async () => {
    const caller = createHost({ resident: false, resume: false, exists: true });
    const storedResult = await new BootstrapSessionMessagePort(caller.host).deliver(
      request({ requestId: "req_caller" }),
    );

    expect(storedResult).toEqual({
      toSessionId: "sess_target",
      messageId: "msg_1",
      status: "stored",
      detail: expect.stringContaining("mailbox"),
    });
    expect(caller.sent).toHaveLength(0);
    expect(caller.stored[0]?.messageId).toBe("msg_1");
    expect(caller.stored[0]?.senderKind).toBe("session");
    // 调用方给了 requestId 就原样透传（它只服务跨进程路由与结果关联）。
    expect(notificationRequest(caller.notifications[0]).requestId).toBe("req_caller");

    const anonymous = createHost({ resident: false, resume: false, exists: true });
    await new BootstrapSessionMessagePort(anonymous.host).deliver(request());
    // 缺省时由 messageId 派生，保证稳定且与 v4 幂等键同源。
    expect(notificationRequest(anonymous.notifications[0]).requestId).toBe(
      sessionMessageV4CommandId("msg_1"),
    );
  });

  it("常驻目标的投递档恒为 guide、幂等键只由 messageId 派生，落地方式按活动回合报告", async () => {
    const busy = createHost({ resident: true, active: true });
    const steered = await new BootstrapSessionMessagePort(busy.host).deliver(request());

    expect(steered.status).toBe("steered");
    expect(busy.sent[0]?.requestedDelivery).toBe("guide");
    expect(busy.sent[0]?.commandId).toBe(sessionMessageV4CommandId("msg_1"));
    expect(busy.stored).toHaveLength(0);

    const idle = createHost({ resident: true, active: false });
    const woken = await new BootstrapSessionMessagePort(idle.host).deliver(request());
    expect(woken.status).toBe("woken");
    expect(idle.sent[0]?.requestedDelivery).toBe("guide");
  });

  it("v4 投递失败降级写 mailbox，不假装成功", async () => {
    const { host, stored } = createHost({
      resident: true,
      sendResult: new Error("gateway down"),
    });

    const result: SessionMessageDeliveryResult = await new BootstrapSessionMessagePort(
      host,
    ).deliver(request());

    expect(result.status).toBe("stored");
    expect(result.detail).toContain("gateway down");
    expect(stored).toHaveLength(1);
  });

  it("duplicate ack 是幂等重放，视为已落地；rejected 才带原因码", () => {
    expect(resolveV4SendResult({ status: "duplicate" } as unknown as CommandAck)).toEqual({
      accepted: true,
    });
    expect(resolveV4SendResult({ status: "accepted" } as unknown as CommandAck)).toEqual({
      accepted: true,
    });
    expect(
      resolveV4SendResult({
        status: "rejected",
        reasonCode: "proto.invalidPayload",
      } as unknown as CommandAck),
    ).toEqual({ accepted: false, detail: "rejected:proto.invalidPayload" });
  });
});

describe("入站防环链三态", () => {
  it("带链 set、会话消息机器 keep、人类输入 clear", () => {
    const chain = { originMessageId: "msg_origin", hop: 2 };

    expect(inboundChainIntentAction({ clientId: "user", sessionMessageChain: chain })).toEqual({
      kind: "set",
      chain,
    });
    // 会话间消息无链不代表人重新开了话头：回执若清链，A↔B 循环里插一条回执就绕过 hop 计数。
    expect(inboundChainIntentAction({ clientId: SESSION_MESSAGE_CLIENT_ID })).toEqual({
      kind: "keep",
    });
    expect(inboundChainIntentAction({ clientId: "user" })).toEqual({ kind: "clear" });
  });
});
