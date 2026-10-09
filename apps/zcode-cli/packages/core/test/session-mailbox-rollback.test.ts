import assert from "node:assert/strict";
import test from "node:test";
import {
  HookEventName,
  type SessionMailboxEnvelope,
  type SessionMailboxPort,
} from "@zcode/contracts";
import {
  createSessionMailboxHookRegistrations,
  SessionMailboxEnqueueRejectedError,
} from "../src/hooks/session-mailbox.js";

/**
 * 契约：drain 后 steer/入队失败的信封必须回滚到 unread（审计修复 #2）。
 *
 * drain 是"先归档到 read/ 再交出"（防双读）；旧实现里 steer 被拒只写 warn，
 * 正文已离开 unread、永不重试 = 静默丢消息。现在：
 * - steer 被拒（SessionMailboxEnqueueRejectedError）→ 回滚该条，其余继续；
 * - 意外异常 → 当前及未交出的后续一并回滚，再上抛；
 * - 单条回滚失败只留日志，不拖垮整批（与坏档隔离同思路）。
 */

const TARGET = "sess_target";

function envelope(overrides: Partial<SessionMailboxEnvelope> = {}): SessionMailboxEnvelope {
  return {
    version: 1,
    messageId: "msg_1",
    fromSessionId: "sess_sender" as SessionMailboxEnvelope["fromSessionId"],
    toSessionId: TARGET as SessionMailboxEnvelope["toSessionId"],
    content: "hello",
    createdAt: "2026-10-03T00:00:00.000Z",
    ...overrides,
  };
}

interface Fixture {
  restored: SessionMailboxEnvelope[];
  mailbox: SessionMailboxPort;
}

function createFixture(messages: SessionMailboxEnvelope[]): Fixture {
  const restored: SessionMailboxEnvelope[] = [];
  const mailbox: SessionMailboxPort = {
    async drainUnread() {
      return messages;
    },
    async deliver() {},
    async consume() {
      return false;
    },
    async restoreToUnread(input) {
      restored.push(input.envelope);
    },
  };
  return { restored, mailbox };
}

function postToolUseInput() {
  return {
    hookEventName: HookEventName.PostToolUse,
    sessionId: TARGET,
    traceId: "trace_1",
    turnId: "turn_1",
  } as never;
}

test("steer 被拒：该信封回滚 unread，同批其余信封照常投递", async () => {
  const first = envelope({ messageId: "msg_first" });
  const second = envelope({
    messageId: "msg_second",
    createdAt: "2026-10-03T00:00:01.000Z",
  });
  const third = envelope({
    messageId: "msg_third",
    createdAt: "2026-10-03T00:00:02.000Z",
  });
  const { restored, mailbox } = createFixture([first, second, third]);
  const attempted: string[] = [];

  const [registration] = createSessionMailboxHookRegistrations({
    mailbox,
    sessionId: TARGET as SessionMailboxEnvelope["toSessionId"],
    enqueuePendingInput: async (input) => {
      const messageId = /message_id="([^"]+)"/.exec(input)?.[1] ?? "";
      attempted.push(messageId);
      if (messageId === "msg_second") {
        throw new SessionMailboxEnqueueRejectedError("no_active_turn");
      }
    },
  });

  const result = await registration!.callback(postToolUseInput(), { hookIndex: 0 });
  assert.equal(result, undefined, "PostToolUse 投递路径不返回 additionalContext");
  assert.deepEqual(attempted, ["msg_first", "msg_second", "msg_third"]);
  assert.deepEqual(
    restored.map((message) => message.messageId),
    ["msg_second"],
    "只有被拒的那条回滚；已投递成功的不回滚（否则双投）",
  );
});

test("enqueue 意外抛错：当前及未交出的后续信封全部回滚，再上抛", async () => {
  const first = envelope({ messageId: "msg_first" });
  const second = envelope({
    messageId: "msg_second",
    createdAt: "2026-10-03T00:00:01.000Z",
  });
  const { restored, mailbox } = createFixture([first, second]);

  const [registration] = createSessionMailboxHookRegistrations({
    mailbox,
    sessionId: TARGET as SessionMailboxEnvelope["toSessionId"],
    enqueuePendingInput: async () => {
      throw new Error("steer blew up");
    },
  });

  await assert.rejects(
    () => registration!.callback(postToolUseInput(), { hookIndex: 0 }),
    /steer blew up/,
  );
  assert.deepEqual(
    restored.map((message) => message.messageId),
    ["msg_first", "msg_second"],
    "抛错时连后续未交出的信封也必须回滚——留在 read/ 就是静默丢失",
  );
});
