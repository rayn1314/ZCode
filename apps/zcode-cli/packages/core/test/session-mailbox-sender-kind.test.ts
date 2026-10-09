import assert from "node:assert/strict";
import test from "node:test";
import { HookEventName, type SessionMailboxEnvelope } from "@zcode/contracts";
import { createSessionMailboxHookRegistrations } from "../src/hooks/session-mailbox.js";

/**
 * mailbox 注入格式的身份落地（spec: core/spec/subagent-session-messaging.md D4 / 行为 5）：
 * 信封带 senderKind 时，`<session-message>` 输出 `sender_kind` 属性；旧信封无该字段则不输出，
 * 注入文本保持向后兼容。drain 时机与语义不变。
 */

async function inject(envelope: SessionMailboxEnvelope): Promise<string> {
  const [registration] = createSessionMailboxHookRegistrations({
    mailbox: {
      drainUnread: async () => [envelope],
      deliver: async () => {},
      consume: async () => false,
      restoreToUnread: async () => {},
    },
    sessionId: "sess_target",
  });
  const result = await registration.callback(
    {
      hookEventName: HookEventName.UserPromptSubmit,
      sessionId: "sess_target",
      traceId: "trace_1",
      turnId: "turn_1",
    } as never,
    { hookIndex: 0 } as never,
  );
  const context = (result as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput
    .additionalContext;
  return context;
}

function envelope(overrides: Partial<SessionMailboxEnvelope> = {}): SessionMailboxEnvelope {
  return {
    version: 1,
    messageId: "msg_1",
    fromSessionId: "sess_subagent_abc" as SessionMailboxEnvelope["fromSessionId"],
    toSessionId: "sess_target" as SessionMailboxEnvelope["toSessionId"],
    content: "hello",
    createdAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

test("信封带 senderKind：注入文本输出 sender_kind 属性", async () => {
  const context = await inject(envelope({ senderKind: "subagent" }));

  assert.match(context, /<session-message source="mailbox" message_id="msg_1" from_session="sess_subagent_abc" sender_kind="subagent" created_at="2026-10-03T00:00:00.000Z">/);
});

test("旧信封无 senderKind：不输出该属性", async () => {
  const context = await inject(envelope());

  assert.match(context, /from_session="sess_subagent_abc" created_at=/);
  assert.doesNotMatch(context, /sender_kind=/);
});
