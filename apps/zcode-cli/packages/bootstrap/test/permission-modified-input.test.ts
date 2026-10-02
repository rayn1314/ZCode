import assert from "node:assert/strict";
import test from "node:test";
import {
  SessionEventType,
  type SessionEvent,
  type ToolCallRow,
} from "@zcode/contracts";
import { ProductProjection } from "../src/zcode-protocol-v4/product-projection.js";

/**
 * 回归背景：AskUserQuestion 的答案经 permission 流程回填进 modifiedInput，
 * 模型侧能收到答案，但 v4 投影的 toolCallRow.input 始终是模型最初下发的参数
 * （只有 questions 没有 answers），导致 UI 折叠块只能显示“未提供回答”。
 * 契约：PermissionResolved 携带 modifiedInput 时，投影必须把它写进 toolCallRow.input。
 */

function createEvent(
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    sessionId: "sess-test",
    turnId: "turn-1",
    type,
    timestamp: new Date(1_000 + sequenceNumber),
    traceId: "trace-test",
    sequenceNumber,
    payload,
  };
}

function createAskUserQuestionEvents() {
  const question = {
    question: "选择哪个库？",
    options: [{ label: "A" }, { label: "B" }],
  };
  const baseInput = { questions: [question] };
  const events: SessionEvent[] = [
    createEvent(1, SessionEventType.TurnStarted, {
      turnNumber: 1,
      input: "请选择",
      executionKind: "agent",
      inputSource: "user",
      messageId: "msg-1",
    }),
    createEvent(2, SessionEventType.ToolCallScheduled, {
      toolCallId: "tool-1",
      assistantMessageId: "assistant-msg-1",
      toolName: "AskUserQuestion",
      input: baseInput,
      schedule: {},
    }),
    createEvent(3, SessionEventType.PermissionRequested, {
      requestId: "req-1",
      toolCallId: "tool-1",
      toolName: "AskUserQuestion",
      riskLevel: "low",
      reason: "AskUserQuestion pauses execution to collect answers from the user",
      input: baseInput,
    }),
    createEvent(4, SessionEventType.PermissionResolved, {
      requestId: "req-1",
      toolCallId: "tool-1",
      decision: "modify",
      modifiedInput: {
        ...baseInput,
        answers: { "选择哪个库？": "A" },
      },
    }),
  ];
  return events;
}

function findToolCallRow(
  projection: ProductProjection,
  toolCallId: string,
): ToolCallRow | undefined {
  return projection
    .getSnapshot()
    .rows.window.find(
      (row): row is ToolCallRow => row.kind === "toolCall" && row.toolCallId === toolCallId,
    );
}

test("PermissionResolved 的 modifiedInput 会回写进 toolCallRow.input", () => {
  const projection = new ProductProjection("sess-test", "epoch-test");
  for (const event of createAskUserQuestionEvents()) {
    projection.applyEvent(event);
  }

  const row = findToolCallRow(projection, "tool-1");
  assert.ok(row, "应存在 AskUserQuestion 的 toolCall 行");
  assert.equal(row!.status, "running", "permission 通过后工具状态应为 running");
  assert.ok(row!.input, "toolCallRow.input 不应为空");
  const input = row!.input as { answers?: Record<string, string> };
  assert.deepEqual(input.answers, { "选择哪个库？": "A" }, "input 应包含用户答案");
});

test("permission 被拒绝时不改写 toolCallRow.input", () => {
  const projection = new ProductProjection("sess-test", "epoch-test");
  const events = createAskUserQuestionEvents();
  events[3] = createEvent(4, SessionEventType.PermissionResolved, {
    requestId: "req-1",
    toolCallId: "tool-1",
    decision: "deny",
    reason: "用户拒绝",
  });
  for (const event of events) {
    projection.applyEvent(event);
  }

  const row = findToolCallRow(projection, "tool-1");
  assert.ok(row, "应存在 AskUserQuestion 的 toolCall 行");
  assert.equal(row!.status, "cancelled", "permission 拒绝后工具状态应为 cancelled");
  const input = row!.input as { answers?: unknown };
  assert.equal(input.answers, undefined, "拒绝时不得把答案写进 input");
});