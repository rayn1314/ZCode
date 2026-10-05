// 队列项引导提升契约（spec: core/spec/queue-item-guide-promotion.md）：
// - busy 排队项（投影）与 fallback 产物（内存）两条提升路径都以同 id 重发
//   TurnSteerQueued(delivery:"guide") 收口，不打断当前 turn；
// - 不可引导场景（idle / 不可 steer / 已保留 / typed intent / 附件）全部拒绝且零副作用。
import assert from "node:assert/strict";
import test from "node:test";
import type { TraceContext } from "../src/runtime/deps.js";
import { SessionEventType } from "../src/runtime/deps.js";
import type {
  PendingSteerInputInfo,
  TurnInputIntentMetadata,
} from "@zcode/contracts";
import { guidePendingInputById } from "../src/runtime/methods/steering.js";

const TRACE: TraceContext = { traceId: "tr_root" } as TraceContext;

function makeIntent(overrides: Partial<TurnInputIntentMetadata> = {}): TurnInputIntentMetadata {
  return {
    sourceCommandId: "cmd_1",
    queueItemId: "queue_cmd_1",
    clientId: "client_1",
    kind: "sendText",
    admissionSeq: 1,
    admittedAt: 0,
    requestedDelivery: "queue",
    admittedDelivery: "queue",
    ...overrides,
  };
}

function makeProjectionItem(
  overrides: Partial<PendingSteerInputInfo> = {},
): PendingSteerInputInfo {
  return {
    pendingInputId: "queue_cmd_1",
    input: "补充一条信息",
    inputPreview: "补充一条信息",
    inputSize: 18,
    queuedAt: new Date(),
    targetTurnId: "turn_old",
    traceId: "tr_old",
    ...overrides,
  };
}

function createHarness() {
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const projectionItems: PendingSteerInputInfo[] = [];
  const activeTurn = {
    goalStateChangeReminderDeferralOpen: false,
    kind: "prompt" as const,
    pendingInputs: [] as Array<Record<string, unknown>>,
    steerable: true,
    traceContext: TRACE,
    turnId: "turn_active",
  };
  const runtime = {
    sessionId: "sess_1",
    activeTurn,
    permissionFullAccessPending: false,
    pendingInputReservations: new Map<string, string>(),
    rootTraceContext: TRACE,
    appendEvent: async (event: { type: string; payload: Record<string, unknown> }) => {
      events.push(event);
    },
    rebuildProjection: async () => ({ pendingSteerInputs: projectionItems }),
  };
  return { runtime, activeTurn, events, projectionItems };
}

test("投影项（busy 排队常态）提升：同 id 注入当前 turn 的 guide 车道并重发事件", async () => {
  const h = createHarness();
  h.projectionItems.push(makeProjectionItem());

  const result = await guidePendingInputById.call(h.runtime as never, {
    pendingInputId: "queue_cmd_1",
    traceContext: TRACE,
  });

  assert.equal(result.kind, "guided");
  // 项进入 active turn，delivery 变 guide，id 保持不变。
  assert.equal(h.activeTurn.pendingInputs.length, 1);
  const promoted = h.activeTurn.pendingInputs[0]!;
  assert.equal(promoted.id, "queue_cmd_1");
  assert.equal(promoted.delivery, "guide");
  assert.equal(promoted.turnId, "turn_active");
  // 重发同 id TurnSteerQueued：v4 reducer 以 queueItemId 为 key 原地改流（保位）。
  assert.equal(h.events.length, 1);
  const event = h.events[0]!;
  assert.equal(event.type, SessionEventType.TurnSteerQueued);
  assert.equal(event.payload.pendingInputId, "queue_cmd_1");
  assert.equal(event.payload.delivery, "guide");
  assert.equal(event.payload.targetTurnId, "turn_active");
});

test("内存项（fallback 产物）提升：原地改投并清 fallbackReasonCode", async () => {
  const h = createHarness();
  h.activeTurn.pendingInputs.push({
    id: "queue_cmd_1",
    input: "早先被回落的引导",
    queuedAt: new Date(),
    traceId: "tr_old",
    queryId: "q_1",
    delivery: "queue",
    intent: makeIntent({ admittedDelivery: "queue", fallbackReasonCode: "guide.turnInterrupted" }),
    turnId: "turn_active",
  });

  const result = await guidePendingInputById.call(h.runtime as never, {
    pendingInputId: "queue_cmd_1",
    traceContext: TRACE,
  });

  assert.equal(result.kind, "guided");
  const promoted = h.activeTurn.pendingInputs[0]!;
  assert.equal(promoted.delivery, "guide");
  const intent = promoted.intent as TurnInputIntentMetadata;
  assert.equal(intent.admittedDelivery, "guide");
  assert.equal(intent.fallbackReasonCode, undefined);
  // 不重复入队：仍只有一个同 id 项。
  assert.equal(h.activeTurn.pendingInputs.length, 1);
  assert.equal(h.events[0]!.type, SessionEventType.TurnSteerQueued);
});

test("拒绝路径：无 active turn / 不可 steer / 已保留 均零副作用", async () => {
  // idle（held/choice 队列）。
  const idle = createHarness();
  idle.runtime.activeTurn = undefined;
  assert.equal(
    (await guidePendingInputById.call(idle.runtime as never, {
      pendingInputId: "queue_cmd_1",
      traceContext: TRACE,
    })).kind,
    "no_active_turn",
  );

  // 当前 turn 不可安全行内注入。
  const notSteerable = createHarness();
  notSteerable.activeTurn.steerable = false;
  assert.equal(
    (await guidePendingInputById.call(notSteerable.runtime as never, {
      pendingInputId: "queue_cmd_1",
      traceContext: TRACE,
    })).kind,
    "not_steerable",
  );

  // 该项已被另一提升流程保留。
  const reserved = createHarness();
  reserved.projectionItems.push(makeProjectionItem());
  reserved.runtime.pendingInputReservations.set("queue_cmd_1", "cmd_other");
  assert.equal(
    (await guidePendingInputById.call(reserved.runtime as never, {
      pendingInputId: "queue_cmd_1",
      traceContext: TRACE,
    })).kind,
    "reserved",
  );

  // 三条拒绝路径都不产生事件、不改动 pendingInputs。
  for (const h of [idle, notSteerable, reserved]) {
    assert.equal(h.events.length, 0);
    assert.equal(h.activeTurn.pendingInputs.length, 0);
  }
});

test("拒绝路径：typed intent（goal/compact）与附件项不可引导", async () => {
  // /goal 与 /compact 是 typed maintenance intent，引导会把它伪装成普通输入。
  const goal = createHarness();
  goal.projectionItems.push(
    makeProjectionItem({
      commandKind: "sendGoalCommand",
      input: "/goal ship it",
      intent: makeIntent({ kind: "sendGoalCommand" }),
    }),
  );
  assert.equal(
    (await guidePendingInputById.call(goal.runtime as never, {
      pendingInputId: "queue_cmd_1",
      traceContext: TRACE,
    })).kind,
    "unsupported_item",
  );

  // 附件项会被行内 drain 拒绝，直接拒绝提升。
  const attachments = createHarness();
  attachments.projectionItems.push(
    makeProjectionItem({ intent: makeIntent({ attachmentRefs: [{ ref: "a", fileName: "a.png", mime: "image/png", bytes: 1 }] }) }),
  );
  assert.equal(
    (await guidePendingInputById.call(attachments.runtime as never, {
      pendingInputId: "queue_cmd_1",
      traceContext: TRACE,
    })).kind,
    "unsupported_item",
  );

  // 投影未命中（已被消费/删除）。
  const missing = createHarness();
  assert.equal(
    (await guidePendingInputById.call(missing.runtime as never, {
      pendingInputId: "queue_missing",
      traceContext: TRACE,
    })).kind,
    "missing",
  );

  for (const h of [goal, attachments, missing]) {
    assert.equal(h.events.length, 0);
    assert.equal(h.activeTurn.pendingInputs.length, 0);
  }
});
