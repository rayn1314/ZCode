import assert from "node:assert/strict";
import test from "node:test";
import { SESSION_MESSAGE_CLIENT_ID } from "@zcode/shared";
import {
  HookEventName,
  SessionMessageChainExceededError,
  SESSION_MESSAGE_MAX_HOP,
  type SessionMailboxEnvelope,
  type SessionMailboxPort,
  type SessionMessageChain,
  type SessionMessageDeliveryRequest,
  type SendMessageOutput,
} from "@zcode/contracts";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import {
  createSessionMailboxHookRegistrations,
  resolveDrainedSessionMessageChain,
} from "../src/hooks/session-mailbox.js";
import { inboundChainIntentAction } from "../src/runtime/methods/session-message-chain.js";
import type { ToolHandlerFailure } from "../src/tool/types.js";

/**
 * 跨会话消息防环链的核心契约（spec: core/spec/subagent-session-messaging.md D7）：
 * - 发送侧算：读会话**实时**入站链，有链则 hop+1、origin 保持，无链则本次消息即链首；
 * - reader 缺席按无链处理，不因能力缺席报错；
 * - cap 唯一裁决点在发送侧端口：超限必须是明确失败（不是 success，更不是 stored）；
 * - mailbox 通路：只有本批存在带链消息才上报一次（取最后一条的链）；空批与无链批
 *   都不上报——mailbox 来信不是人类插话，无链批不清链（审计修复 #4）。
 */

const SENDER_SESSION = "sess_parent";

function createContext(overrides: Record<string, unknown> = {}): never {
  return {
    toolCallId: "toolu_send_chain",
    sessionId: SENDER_SESSION,
    turnId: "turn_1",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...overrides,
  } as never;
}

function input(to: string): { to: string; summary: string; message: string } {
  return { to, summary: "chain test", message: "hello" };
}

function captureRequest(): {
  context: Record<string, unknown>;
  delivered: SessionMessageDeliveryRequest[];
  status: "steered" | "woken" | "stored";
} {
  const delivered: SessionMessageDeliveryRequest[] = [];
  const state = { status: "stored" as const };
  const context: Record<string, unknown> = {
    sessionMessagePort: {
      deliver: async (request: SessionMessageDeliveryRequest) => {
        delivered.push(request);
        return { toSessionId: request.toSessionId, messageId: request.messageId, status: state.status };
      },
    },
  };
  return { context, delivered, status: state.status };
}

test("无入站链：本次消息即链首（hop=1，origin=本次 messageId）", async () => {
  const captured = captureRequest();
  const output = (await sendMessageToolEntry.handler(
    input("sess_target"),
    createContext({
      ...captured.context,
      sessionMessageChainReader: { current: () => undefined },
    }),
  )) as SendMessageOutput;

  assert.equal(output.status, "success");
  assert.equal(captured.delivered.length, 1);
  const chain = captured.delivered[0]!.sessionMessageChain;
  assert.equal(chain?.hop, 1);
  assert.equal(chain?.originMessageId, captured.delivered[0]!.messageId);
});

test("有入站链：hop+1，origin 沿链保持", async () => {
  const captured = captureRequest();
  const inbound: SessionMessageChain = { hop: 2, originMessageId: "msg_root" };
  await sendMessageToolEntry.handler(
    input("sess_target"),
    createContext({
      ...captured.context,
      sessionMessageChainReader: { current: () => inbound },
    }),
  );

  assert.deepEqual(captured.delivered[0]!.sessionMessageChain, {
    hop: 3,
    originMessageId: "msg_root",
  });
});

test("reader 缺席：按无链处理，不崩", async () => {
  const captured = captureRequest();
  await sendMessageToolEntry.handler(input("sess_target"), createContext(captured.context));

  assert.equal(captured.delivered[0]!.sessionMessageChain?.hop, 1);
});

test("端口抛链深超限：失败且文案点明链首与深度，绝不是 success", async () => {
  const context = createContext({
    sessionMessageChainReader: { current: () => ({ hop: 6, originMessageId: "msg_root" }) },
    sessionMessagePort: {
      deliver: async (request: SessionMessageDeliveryRequest) =>
        Promise.reject(
          new SessionMessageChainExceededError({
            hop: request.sessionMessageChain!.hop,
            originMessageId: request.sessionMessageChain!.originMessageId,
            toSessionId: request.toSessionId,
          }),
        ),
    },
  });

  const output = (await sendMessageToolEntry.handler(input("sess_target"), context)) as
    | SendMessageOutput
    | ToolHandlerFailure;

  assert.equal((output as ToolHandlerFailure).result, false);
  assert.equal((output as ToolHandlerFailure).errorCode, 4);
  assert.match((output as ToolHandlerFailure).message, /session_message_chain_exceeded/);
  assert.match((output as ToolHandlerFailure).message, /hop 7/);
  assert.match((output as ToolHandlerFailure).message, /msg_root/);
  assert.match((output as ToolHandlerFailure).message, new RegExp(`max ${SESSION_MESSAGE_MAX_HOP}`));
  assert.equal("status" in output, false);
});

test("端口的其它异常照旧上抛，不被当成业务失败吞掉", async () => {
  await assert.rejects(
    () =>
      sendMessageToolEntry.handler(
        input("sess_target"),
        createContext({
          sessionMessagePort: {
            deliver: async () => {
              throw new Error("mailbox read-only");
            },
          },
        }),
      ),
    /mailbox read-only/,
  );
});

// ── mailbox 通路：入站链上报 ──

function envelope(overrides: Partial<SessionMailboxEnvelope> = {}): SessionMailboxEnvelope {
  return {
    version: 1,
    messageId: "msg_1",
    fromSessionId: SENDER_SESSION as SessionMailboxEnvelope["fromSessionId"],
    toSessionId: "sess_target" as SessionMailboxEnvelope["toSessionId"],
    content: "hello",
    createdAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

test("本批取最后一条带链的消息：中间的无链旧信封不影响", () => {
  const chain: SessionMessageChain = { hop: 4, originMessageId: "msg_root" };
  assert.deepEqual(
    resolveDrainedSessionMessageChain([
      envelope({ messageId: "msg_old" }),
      envelope({ messageId: "msg_new", chain }),
    ]),
    chain,
  );
});

test("整批都没有链：返回 undefined（调用方据此**不清链**，审计修复 #4）", () => {
  assert.equal(resolveDrainedSessionMessageChain([envelope(), envelope()]), undefined);
  assert.equal(resolveDrainedSessionMessageChain([]), undefined);
});

test("hook：非空 drain 上报带链消息；空批与无链批都不上报（不清链）", async () => {
  const notes: Array<SessionMessageChain | undefined> = [];
  const chain: SessionMessageChain = { hop: 2, originMessageId: "msg_root" };
  const mailbox: SessionMailboxPort = {
    async drainUnread() {
      return [];
    },
    async deliver() {},
    async consume() {
      return false;
    },
    async restoreToUnread() {},
  };
  const [registration] = createSessionMailboxHookRegistrations({
    mailbox,
    sessionId: SENDER_SESSION as SessionMailboxEnvelope["toSessionId"],
    noteInboundSessionMessageChain: (value) => notes.push(value),
  });
  assert.ok(registration);

  const hookInput = {
    hookEventName: HookEventName.PostToolUse,
    traceId: "t",
    turnId: "turn",
  } as never;

  await registration!.callback(hookInput, { hookIndex: 0 });
  assert.deepEqual(notes, [], "空 drain 不能上报（否则会误清链）");

  mailbox.drainUnread = async () => [envelope({ chain })];
  await registration!.callback(hookInput, { hookIndex: 0 });
  assert.deepEqual(notes, [chain]);

  // 审计修复 #4：mailbox 信封只可能来自会话（session/subagent），永远不是人类插话。
  // 无链批 = 旧客户端/无链信封，若按"人重新开话头"清链，A↔B 循环插一条就绕过 cap。
  mailbox.drainUnread = async () => [envelope({ messageId: "msg_plain" })];
  await registration!.callback(hookInput, { hookIndex: 0 });
  assert.deepEqual(notes, [chain], "无链批不得上报（不清链）");
});

// ── 命令面输入的清链裁决（spec D7 修订 + 审计修复 #4） ──

test("人类输入（无链）→ clear：人再说一句话即重置链深", () => {
  assert.deepEqual(
    inboundChainIntentAction({ clientId: "renderer", sessionMessageChain: undefined }),
    { kind: "clear" },
  );
});

test("会话消息输入（无链）→ keep：回执/无链投递不得清链", () => {
  assert.deepEqual(
    inboundChainIntentAction({
      clientId: SESSION_MESSAGE_CLIENT_ID,
      sessionMessageChain: undefined,
    }),
    { kind: "keep" },
  );
});

test("带链输入（不论提交端）→ set：链照常传播", () => {
  const chain: SessionMessageChain = { hop: 3, originMessageId: "msg_root" };
  assert.deepEqual(inboundChainIntentAction({ clientId: "renderer", sessionMessageChain: chain }), {
    kind: "set",
    chain,
  });
  assert.deepEqual(
    inboundChainIntentAction({
      clientId: SESSION_MESSAGE_CLIENT_ID,
      sessionMessageChain: chain,
    }),
    { kind: "set", chain },
  );
});
