import assert from "node:assert/strict";
import test from "node:test";
import {
  SendMessageOutputSchema,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryStatus,
  type SendMessageOutput,
} from "@zcode/contracts";
import { sendMessageToolEntry } from "../src/tool/handlers/send-message.js";
import type { ToolHandlerFailure } from "../src/tool/types.js";

/**
 * SendMessage 统一寻址的核心契约（spec: core/spec/subagent-session-messaging.md D2 / 行为 3、4）：
 * - `agent_*` 走既有子代理端口，不经跨会话端口；
 * - `sess_*` 走 SessionMessagePort.deliver，并把 steered/woken/stored 如实映射到输出；
 * - 自投递、端口缺席、非法前缀都明确失败，不静默成功；
 * - 身份由发送方 runtime 填充：正式会话 `session`，子代理 runtime（runtimeScope=subagent）`subagent`。
 */

const SENDER_SESSION = "sess_parent";

function createContext(overrides: Record<string, unknown> = {}): never {
  return {
    toolCallId: "toolu_send_1",
    sessionId: SENDER_SESSION,
    turnId: "turn_1",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    ...overrides,
  } as never;
}

function input(to: string): { to: string; summary: string; message: string } {
  return { to, summary: "route test", message: "hello" };
}

async function run(inputValue: unknown, context: unknown): Promise<unknown> {
  return sendMessageToolEntry.handler(inputValue, context as never);
}

function asFailure(output: unknown): ToolHandlerFailure {
  const candidate = output as Partial<ToolHandlerFailure>;
  assert.equal(candidate.result, false, `expected a ToolHandlerFailure, got ${JSON.stringify(output)}`);
  assert.equal(typeof candidate.message, "string");
  return candidate as ToolHandlerFailure;
}

test("agent_*：走子代理端口，不触碰跨会话端口", async () => {
  const sent: unknown[] = [];
  let sessionDeliverCalled = false;
  const context = createContext({
    subagentPort: {
      sendMessage: async (request: unknown) => {
        sent.push(request);
        return {
          status: "success",
          messageId: "msg_subagent",
          delivery: "steered",
          agentId: "agent_abc",
          message: "steered into the subagent",
        };
      },
    },
    sessionMessagePort: {
      deliver: async () => {
        sessionDeliverCalled = true;
        throw new Error("session port must not be used for agent_*");
      },
    },
  });

  const output = SendMessageOutputSchema.parse(await run(input("agent_abc"), context)) as SendMessageOutput;

  assert.equal(output.delivery, "steered");
  assert.equal(output.agentId, "agent_abc");
  assert.equal(sent.length, 1);
  assert.equal(sessionDeliverCalled, false);
});

test("agent_* 且本 runtime 无子代理注册表：明确失败（能力缺席）", async () => {
  const failure = asFailure(await run(input("agent_abc"), createContext({ subagentPort: undefined })));

  assert.equal(failure.errorCode, 2);
  assert.match(failure.message, /subagent_registry_unavailable/);
  assert.match(failure.message, /agent_abc/);
});

for (const status of ["steered", "woken", "stored"] as SessionMessageDeliveryStatus[]) {
  test(`sess_*：走跨会话端口并映射 delivery=${status}`, async () => {
    let received: SessionMessageDeliveryRequest | undefined;
    let subagentSendCalled = false;
    const context = createContext({
      subagentPort: {
        sendMessage: async () => {
          subagentSendCalled = true;
          throw new Error("subagent port must not be used for sess_*");
        },
      },
      sessionMessagePort: {
        deliver: async (request: SessionMessageDeliveryRequest) => {
          received = request;
          return { toSessionId: request.toSessionId, messageId: request.messageId, status };
        },
      },
    });

    const output = SendMessageOutputSchema.parse(
      await run(input("sess_target"), context),
    ) as SendMessageOutput;

    assert.equal(output.status, "success");
    assert.equal(output.delivery, status);
    assert.ok(received);
    assert.equal(received?.toSessionId, "sess_target");
    assert.equal(received?.fromSessionId, SENDER_SESSION);
    assert.equal(received?.senderKind, "session");
    assert.equal(received?.content, "hello");
    assert.match(received?.messageId ?? "", /^msg_/);
    assert.equal(subagentSendCalled, false);
  });
}

test("sess_*：子代理 runtime（runtimeScope=subagent）标 senderKind=subagent", async () => {
  let received: SessionMessageDeliveryRequest | undefined;
  const context = createContext({
    runtimeScope: "subagent",
    sessionMessagePort: {
      deliver: async (request: SessionMessageDeliveryRequest) => {
        received = request;
        return { toSessionId: request.toSessionId, messageId: request.messageId, status: "stored" };
      },
    },
  });

  await run(input("sess_target"), context);

  assert.equal(received?.senderKind, "subagent");
});

test("sess_*：拒绝把消息发给自己", async () => {
  let deliverCalled = false;
  const context = createContext({
    sessionMessagePort: {
      deliver: async () => {
        deliverCalled = true;
        throw new Error("self delivery must be rejected before hitting the port");
      },
    },
  });

  const failure = asFailure(await run(input(SENDER_SESSION), context));

  assert.equal(failure.errorCode, 1);
  assert.match(failure.message, /invalid_recipient/);
  assert.equal(deliverCalled, false);
});

test("sess_* 且无跨会话端口：明确失败（能力缺席）", async () => {
  const failure = asFailure(await run(input("sess_target"), createContext({ sessionMessagePort: undefined })));

  assert.equal(failure.errorCode, 3);
  assert.match(failure.message, /session_message_unavailable/);
});

test("非 agent_*/sess_* 前缀：输入校验失败", async () => {
  const failure = asFailure(await run(input("workflow_child_1"), createContext()));

  assert.equal(failure.errorCode, 1);
  assert.match(failure.message, /invalid_recipient/);
});
