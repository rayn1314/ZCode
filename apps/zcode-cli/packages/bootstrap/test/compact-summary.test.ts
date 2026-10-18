// 压缩摘要读端契约（spec: packages/ui/spec/compact-summary-block.md）。
// 两半：授权判据 `readCompactSummaryBody`（只认 compact_summary 消息、只取 summary.body），
// 与网关 `compactionSummary`（参数校验 / 能力缺席 / notFound 归一）——后者是 UI 拿到
// 「读端不可用」与「读端无此消息」两种降级路径的判据来源，断言不能放宽。
import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "@zcode/contracts";
import { ConversationV4Gateway, type V4GatewayHost } from "../src/zcode-protocol-v4/v4-gateway.js";
import { readCompactSummaryBody } from "../src/zcode-protocol/v4-bridge.js";

const SUMMARY_BODY = "Summary:\n1. 目标\n2. 关键决策\n";

function userMessage(
  id: string,
  semantics: { kind: string } | undefined,
  summary?: { title?: string; body?: string },
): MessageWithParts {
  return {
    info: {
      id,
      sessionID: "sess_1",
      role: "user",
      time: { created: 0 },
      agent: "zcode-agent",
      ...(semantics ? { semantics } : {}),
      ...(summary ? { summary: { title: "Compact summary", diffs: [], ...summary } } : {}),
    },
    parts: [],
  } as unknown as MessageWithParts;
}

function createGateway(host: Partial<V4GatewayHost>): ConversationV4Gateway {
  return new ConversationV4Gateway(host as V4GatewayHost);
}

test("readCompactSummaryBody 只认 compact_summary 消息并取 summary.body", () => {
  const messages = [
    userMessage("msg_user", { kind: "user_prompt" }),
    userMessage("msg_summary", { kind: "compact_summary" }, { body: SUMMARY_BODY }),
    userMessage("msg_empty", { kind: "compact_summary" }),
  ];
  assert.equal(readCompactSummaryBody(messages, "msg_summary"), SUMMARY_BODY);
  // 消息在场但没有正文：合法空结果（UI 显示「摘要为空」），不是 not found。
  assert.equal(readCompactSummaryBody(messages, "msg_empty"), "");
  // 不存在的 messageId：回 undefined，宿主据此走 notFound。
  assert.equal(readCompactSummaryBody(messages, "msg_absent"), undefined);
  // 非压缩摘要的普通消息：同一个答案，这条通道不是任意消息读取。
  assert.equal(readCompactSummaryBody(messages, "msg_user"), undefined);
});

test("compactionSummary 透传摘要正文并断言入参形状", async () => {
  const calls: Array<{ sessionId: string; messageId: string }> = [];
  const gateway = createGateway({
    readCompactionSummary: async (sessionId, messageId) => {
      calls.push({ sessionId, messageId });
      return { summary: SUMMARY_BODY };
    },
  });
  try {
    assert.deepEqual(
      await gateway.compactionSummary({ sessionId: "sess_1", messageId: "msg_summary" }),
      { summary: SUMMARY_BODY },
    );
    assert.deepEqual(calls, [{ sessionId: "sess_1", messageId: "msg_summary" }]);
    // 严格 schema：多余字段不得被静默忽略。
    await assert.rejects(
      gateway.compactionSummary({
        sessionId: "sess_1",
        messageId: "msg_summary",
        extra: true,
      }),
    );
    await assert.rejects(gateway.compactionSummary({ sessionId: "sess_1" }));
    await assert.rejects(gateway.compactionSummary({ sessionId: " ", messageId: "msg_summary" }));
  } finally {
    gateway.dispose();
  }
});

test("compactionSummary 把「宿主无此消息」归一成 notFound，不泄漏成空摘要", async () => {
  const gateway = createGateway({ readCompactionSummary: async () => undefined });
  try {
    await assert.rejects(
      gateway.compactionSummary({ sessionId: "sess_1", messageId: "msg_absent" }),
      /^Error: fault\.compactionSummary\.notFound: msg_absent$/,
    );
  } finally {
    gateway.dispose();
  }
});

test("compactionSummary 在宿主没有该能力时回结构化的能力缺席错误", async () => {
  const gateway = createGateway({});
  try {
    await assert.rejects(
      gateway.compactionSummary({ sessionId: "sess_1", messageId: "msg_summary" }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.name, "V4CapabilityUnsupportedError");
        assert.match(error.message, /readCompactionSummary/);
        return true;
      },
    );
  } finally {
    gateway.dispose();
  }
});
