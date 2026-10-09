// readMessages 服务端 limit 契约（spec `spec/read-messages-limit.md`）：
// 1) limit 缺省按服务端默认值（2000）截断，超硬顶（10000）钳制；
// 2) 截断时返回**最近的 N 条**并带 total/hasMore，未截断时 hasMore=false；
// 3) 响应必须是 wire 形状（mapMessageWithParts 映射后的 info.messageId/sessionId）
//   并通过 strict 的 zcodeSessionMessagesResultSchema（新增字段已同步进 schema）。
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "@zcode/contracts";
import { zcodeSessionMessagesResultSchema } from "@zcode/shared";
import {
  SESSION_MESSAGES_DEFAULT_LIMIT,
  SESSION_MESSAGES_MAX_LIMIT,
  readMessages,
} from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const SESSION_ID = "sess_read_messages";

/** 存储形状（info.id/sessionID）：服务端出协议前必须映射成 wire 形状。 */
function createMessages(count: number): MessageWithParts[] {
  return Array.from({ length: count }, (_, index) => ({
    info: {
      id: `m-${index + 1}`,
      sessionID: SESSION_ID,
      role: "user",
      time: { created: 1_700_000_000_000 + index },
      agent: "main",
    },
    parts: [],
  })) as unknown as MessageWithParts[];
}

function createContext(messages: MessageWithParts[]): ZCodeProtocolAgentServerContext {
  const record = {
    app: { sessionId: SESSION_ID },
    eventStore: { getEvents: async () => [] },
  };
  return {
    sessions: new Map([[SESSION_ID, record]]),
    deps: {
      sessionStore: {
        messages: async () => messages,
        // 无持久 session → getPersistedSession 直接返回 null，不走路径修复。
        getSession: async () => null,
      },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("limit 缺省时按服务端默认上限返回最近的 N 条", async () => {
  const total = SESSION_MESSAGES_DEFAULT_LIMIT + 500;
  const result = await readMessages(createContext(createMessages(total)), {
    sessionId: SESSION_ID,
  });
  assert.equal(result.messages.length, SESSION_MESSAGES_DEFAULT_LIMIT);
  assert.equal(
    result.messages[0]?.info.messageId,
    `m-${total - SESSION_MESSAGES_DEFAULT_LIMIT + 1}`,
  );
  assert.equal(result.messages.at(-1)?.info.messageId, `m-${total}`);
  assert.equal(result.total, total);
  assert.equal(result.hasMore, true);
});

test("显式 limit 生效：只回最近 limit 条", async () => {
  const result = await readMessages(createContext(createMessages(50)), {
    sessionId: SESSION_ID,
    limit: 10,
  });
  assert.equal(result.messages.length, 10);
  assert.equal(result.messages[0]?.info.messageId, "m-41");
  assert.equal(result.messages.at(-1)?.info.messageId, "m-50");
  assert.equal(result.total, 50);
  assert.equal(result.hasMore, true);
});

test("超过硬顶的 limit 被钳到 10000", async () => {
  const total = SESSION_MESSAGES_MAX_LIMIT + 2_000;
  const result = await readMessages(createContext(createMessages(total)), {
    sessionId: SESSION_ID,
    limit: SESSION_MESSAGES_MAX_LIMIT + 5_000,
  });
  assert.equal(result.messages.length, SESSION_MESSAGES_MAX_LIMIT);
  assert.equal(result.messages[0]?.info.messageId, `m-${total - SESSION_MESSAGES_MAX_LIMIT + 1}`);
  assert.equal(result.total, total);
  assert.equal(result.hasMore, true);
});

test("未触发截断时 hasMore=false，响应通过 strict 协议 schema", async () => {
  const result = await readMessages(createContext(createMessages(5)), {
    sessionId: SESSION_ID,
    limit: 10,
  });
  assert.equal(result.messages.length, 5);
  assert.equal(result.total, 5);
  assert.equal(result.hasMore, false);
  const parsed = zcodeSessionMessagesResultSchema.parse(result);
  assert.equal(parsed.messages.length, 5);
  assert.equal(parsed.total, 5);
  assert.equal(parsed.hasMore, false);
});
