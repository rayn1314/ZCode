// 会话消息信封：解析/展示投影/编辑回写 round-trip。
// spec: packages/ui/spec/session-message-envelope-rendering.md
import assert from "node:assert/strict";
import test from "node:test";
import { buildPromptWithConversationSelections } from "../src/lib/conversationSelectionReference.js";
import {
  buildPromptWithSessionMessageEnvelopes,
  parseSessionMessageEnvelopes,
} from "../src/lib/sessionMessageEnvelope.js";
import {
  parseComposerPromptContexts,
  serializeComposerPromptContexts,
} from "../src/v4/composer/composerPromptContexts.js";

const LIVE_ENVELOPE = [
  '<session-message source="session-message" message_id="msg_90b897b3-9a30-42a6-a5b3-931486746b93" from_session="sess_dd623838-39d8-4185-a94d-9ffc8eba93c8" sender_kind="session" hop="1" origin="msg_90b897b3-9a30-42a6-a5b3-931486746b93" created_at="2026-10-04T16:31:42.370Z">',
  "测试消息：这是来自另一个会话的跨会话唤醒测试。如果你能收到这条消息，请回复确认。",
  "</session-message>",
].join("\n");

const MAILBOX_ENVELOPE = [
  '<session-message source="mailbox" message_id="msg_x" from_session="sess_y" sender_kind="subagent" created_at="2026-10-03T00:00:00.000Z">',
  "For reference only. Verify against raw source before acting.",
  "",
  "message body here",
  "</session-message>",
].join("\n");

const DELIVERY_RESULT_ENVELOPE = [
  '<session-message source="delivery-result" message_id="msg_x" request_id="req_z">',
  "Delivery of message msg_x to another session delivered (or stored in the target mailbox).",
  "For reference only. No action is required.",
  "</session-message>",
].join("\n");

test("整条实时信封：可见正文为空，hop/origin/fromSessionId 解析到位", () => {
  const parsed = parseSessionMessageEnvelopes(LIVE_ENVELOPE);
  assert.equal(parsed.visibleContent, "");
  assert.equal(parsed.messages.length, 1);
  const [message] = parsed.messages;
  assert.equal(message?.source, "session-message");
  assert.equal(message?.messageId, "msg_90b897b3-9a30-42a6-a5b3-931486746b93");
  assert.equal(message?.fromSessionId, "sess_dd623838-39d8-4185-a94d-9ffc8eba93c8");
  assert.equal(message?.senderKind, "session");
  assert.equal(message?.hop, "1");
  assert.equal(message?.origin, "msg_90b897b3-9a30-42a6-a5b3-931486746b93");
  assert.equal(message?.createdAt, "2026-10-04T16:31:42.370Z");
  assert.equal(
    message?.body,
    "测试消息：这是来自另一个会话的跨会话唤醒测试。如果你能收到这条消息，请回复确认。",
  );
  assert.equal(message?.raw, LIVE_ENVELOPE);
});

test("mailbox 信封：英文样板句从 body 剔除，raw 保留原句", () => {
  const parsed = parseSessionMessageEnvelopes(MAILBOX_ENVELOPE);
  assert.equal(parsed.visibleContent, "");
  const [message] = parsed.messages;
  assert.equal(message?.body, "message body here");
  assert.ok(message?.raw.includes("For reference only. Verify against raw source before acting."));
});

test("可见正文与信封混排：正文保留、剥离处空白归整", () => {
  const trailing = parseSessionMessageEnvelopes(`请帮我看看这段代码\n\n${LIVE_ENVELOPE}`);
  assert.equal(trailing.visibleContent, "请帮我看看这段代码");
  assert.equal(trailing.messages.length, 1);

  const between = parseSessionMessageEnvelopes(`前半段\n\n${LIVE_ENVELOPE}\n\n后半段`);
  assert.equal(between.visibleContent, "前半段\n\n后半段");
  assert.equal(between.messages.length, 1);

  const leading = parseSessionMessageEnvelopes(`${LIVE_ENVELOPE}\n\n后半段`);
  assert.equal(leading.visibleContent, "后半段");
});

test("一条消息多个信封：全部解析且顺序稳定", () => {
  const second = MAILBOX_ENVELOPE.replace('message_id="msg_x"', 'message_id="msg_second"');
  const parsed = parseSessionMessageEnvelopes(`${LIVE_ENVELOPE}\n\n${second}`);
  assert.equal(parsed.visibleContent, "");
  assert.deepEqual(
    parsed.messages.map((message) => message.messageId),
    ["msg_90b897b3-9a30-42a6-a5b3-931486746b93", "msg_second"],
  );
});

test("投递回执：识别为 delivery-result 且 requestId 到位，body 无样板句残留", () => {
  const parsed = parseSessionMessageEnvelopes(DELIVERY_RESULT_ENVELOPE);
  const [message] = parsed.messages;
  assert.equal(message?.source, "delivery-result");
  assert.equal(message?.requestId, "req_z");
  assert.equal(message?.body, "");
});

test("round-trip：整条信封字节等价，混排解析后重建仍是同一信封", () => {
  const whole = parseSessionMessageEnvelopes(LIVE_ENVELOPE);
  assert.equal(
    buildPromptWithSessionMessageEnvelopes(whole.visibleContent, whole.messages),
    LIVE_ENVELOPE,
  );

  const mixedSource = `用户正文\n\n${MAILBOX_ENVELOPE}\n\n还有更多正文`;
  const mixed = parseSessionMessageEnvelopes(mixedSource);
  const rebuilt = buildPromptWithSessionMessageEnvelopes(mixed.visibleContent, mixed.messages);
  assert.equal(rebuilt, `用户正文\n\n还有更多正文\n\n${MAILBOX_ENVELOPE}`);
  const reparsed = parseSessionMessageEnvelopes(rebuilt);
  assert.equal(reparsed.visibleContent, mixed.visibleContent);
  assert.deepEqual(reparsed.messages, mixed.messages);
  // 幂等：再回写一次结果不变，避免编辑多次后信封被重复堆叠。
  assert.equal(
    buildPromptWithSessionMessageEnvelopes(reparsed.visibleContent, reparsed.messages),
    rebuilt,
  );
});

test("纯用户文本 / 半截信封 / 缺 message_id：原样保留且不产生引用", () => {
  const plain = "普通用户文本\n\n第二段\n";
  assert.deepEqual(parseSessionMessageEnvelopes(plain), {
    visibleContent: plain,
    messages: [],
  });

  const unclosed = `<session-message source="session-message" message_id="msg_a">\n没有闭合标签`;
  assert.deepEqual(parseSessionMessageEnvelopes(unclosed), {
    visibleContent: unclosed,
    messages: [],
  });

  const noMessageId = `<session-message source="mailbox" from_session="sess_y">\n用户自己写的内容\n</session-message>`;
  assert.deepEqual(parseSessionMessageEnvelopes(noMessageId), {
    visibleContent: noMessageId,
    messages: [],
  });

  // 用户手打的伪标签不能吞掉它后面真正的信封。
  const afterInvalid = parseSessionMessageEnvelopes(`${noMessageId}\n\n${LIVE_ENVELOPE}`);
  assert.equal(afterInvalid.messages.length, 1);
  assert.equal(afterInvalid.visibleContent, noMessageId);
});

test("属性扫描宽松：单引号值与未知属性不影响识别，未知属性被忽略", () => {
  const parsed = parseSessionMessageEnvelopes(
    `<session-message source='mailbox' message_id='msg_loose' unknown_attr="zzz">\nbody\n</session-message>`,
  );
  assert.equal(parsed.messages.length, 1);
  assert.equal(parsed.messages[0]?.messageId, "msg_loose");
  assert.equal(parsed.messages[0]?.source, "mailbox");
  assert.equal(parsed.messages[0]?.body, "body");
});

test("与既有四类上下文共存：可见正文与各类引用数量正确", () => {
  const userSelectBlock = buildPromptWithConversationSelections("", [{ text: "被引用的对话片段" }]);
  const workspace = { workspacePath: "/workspace/demo" };
  const prompt = `用户正文\n\n${userSelectBlock}\n\n${LIVE_ENVELOPE}`;
  const parsed = parseComposerPromptContexts(prompt, workspace);
  assert.equal(parsed.visibleContent, "用户正文");
  assert.equal(parsed.conversationSelections.length, 1);
  assert.equal(parsed.sessionMessages.length, 1);
  assert.equal(parsed.sessionMessages[0]?.raw, LIVE_ENVELOPE);
  assert.deepEqual(parsed.codeComments, []);
  assert.deepEqual(parsed.webElements, []);
  assert.deepEqual(parsed.pptxElements, []);
});

test("编辑回写路径：serialize 重拼后信封仍在，正文改动生效", () => {
  const workspace = { workspacePath: "/workspace/demo" };
  const parsed = parseComposerPromptContexts(`用户正文\n\n${LIVE_ENVELOPE}`, workspace);
  const submitted = serializeComposerPromptContexts(parsed.visibleContent, {
    codeComments: parsed.codeComments,
    conversationSelections: parsed.conversationSelections,
    webElements: parsed.webElements,
    pptxElements: parsed.pptxElements,
    sessionMessages: parsed.sessionMessages,
  });
  assert.equal(submitted, `用户正文\n\n${LIVE_ENVELOPE}`);

  // 模拟用户改写正文后再提交（handleSubmitEdit 的路径）。
  const reparsed = parseComposerPromptContexts(submitted, workspace);
  const edited = serializeComposerPromptContexts("改过的正文", {
    codeComments: reparsed.codeComments,
    conversationSelections: reparsed.conversationSelections,
    webElements: reparsed.webElements,
    pptxElements: reparsed.pptxElements,
    sessionMessages: reparsed.sessionMessages,
  });
  assert.equal(edited, `改过的正文\n\n${LIVE_ENVELOPE}`);
});
