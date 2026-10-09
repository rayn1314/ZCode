// 准入字节测量缓存契约（spec `spec/wire-snapshot-measure-cache.md`）：
// 1) 同一投影 snapshot 版本内，重复的输入准入测量只允许一次全量序列化（命中 memo）；
// 2) snapshot 版本变更（事件推进）后必须重测，且测量值与「整份候选快照重算」逐字节一致
//   ——该值给 16MiB 逻辑帧上限判生死，测少一个字节就会放行发不出去的输入。
import assert from "node:assert/strict";
import test from "node:test";
import { SessionEventType, type SessionEvent } from "@zcode/contracts";
import {
  DELIVERY_PROFILES,
  PROTOCOL_V4_LIMITS,
  filterConversationRowsForProfile,
  utf8JsonByteLength,
  type CommandEnvelope,
  type ConversationSnapshot,
  type ConversationTopicFrame,
} from "@zcode/shared/zcode-protocol-v4";
import {
  ConversationTopicPublisher,
  buildInputAdmissionQueueItem,
} from "../src/zcode-protocol-v4/conversation-topic-publisher.js";

const SESSION_ID = "sess_measure_cache";
const LOG_EPOCH = "epoch-measure-cache";
const TOPIC = `conversation/${SESSION_ID}`;

const ADMISSION = {
  admissionSeq: 3,
  admittedAt: 1_700_000_001_000,
  queueItemId: "qi-admission-3",
};

function createEvent(
  sequenceNumber: number,
  type: SessionEvent["type"],
  payload: unknown,
): SessionEvent {
  return {
    id: `event-${sequenceNumber}`,
    sessionId: SESSION_ID,
    turnId: "turn-1",
    type,
    timestamp: new Date(1_000 + sequenceNumber),
    traceId: "trace-test",
    sequenceNumber,
    payload,
  };
}

function sendTextEnvelope(commandId: string): CommandEnvelope {
  return {
    commandId,
    clientId: "test-client",
    sessionId: SESSION_ID,
    type: "sendText",
    payload: { text: "准入测量的输入内容" },
    issuedAt: 1_700_000_000_000,
  };
}

/**
 * 整份重算对拍（独立于被测「memo 基线 + queue item 增量」路径）：按生产
 * `measureWireSnapshotBytes(getWireSnapshot(candidate))` 的口径从零构造候选帧。
 */
function referenceAdmissionBytes(
  publisher: ConversationTopicPublisher,
  envelope: CommandEnvelope,
  admission: typeof ADMISSION,
): number {
  const snapshot = publisher.getSnapshot();
  const queueItem = buildInputAdmissionQueueItem(envelope, admission, snapshot);
  assert.ok(queueItem, "sendText 必须产出准入 QueueItem");
  const candidate: ConversationSnapshot = {
    ...snapshot,
    queue: { ...snapshot.queue, items: [...snapshot.queue.items, queueItem] },
  };
  const visibleRows = filterConversationRowsForProfile(
    candidate.rows.window,
    DELIVERY_PROFILES.continuous,
  );
  const visibleSnapshot: ConversationSnapshot = {
    ...candidate,
    rows: {
      ...candidate.rows,
      window: visibleRows,
      totalCount: visibleRows.length,
      firstRowId: visibleRows[0]?.rowId ?? null,
    },
  };
  const tail = PROTOCOL_V4_LIMITS.snapshotTailWindowRows;
  const wire =
    visibleRows.length <= tail
      ? visibleSnapshot
      : { ...visibleSnapshot, rows: { ...visibleSnapshot.rows, window: visibleRows.slice(-tail) } };
  const frame: ConversationTopicFrame = {
    topic: TOPIC,
    subscriptionId: `sub-${LOG_EPOCH}-${Number.MAX_SAFE_INTEGER}`,
    fromSeq: 0,
    toSeq: wire.seq,
    sentAt: Number.MAX_SAFE_INTEGER,
    payload: { kind: "snapshot", snapshot: wire },
  };
  return utf8JsonByteLength(frame);
}

function isSnapshotFrame(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const payload = (value as { payload?: { kind?: unknown } | null }).payload;
  return payload !== null && typeof payload === "object" && payload.kind === "snapshot";
}

/** 统计「整份 snapshot 帧」的 JSON.stringify 次数——即全量测量发生的次数。 */
function trackSnapshotFrameEncodings() {
  const original = JSON.stringify;
  let frames = 0;
  JSON.stringify = function (this: unknown, value?: unknown, ...rest: unknown[]) {
    if (isSnapshotFrame(value)) frames += 1;
    return (original as (v: unknown, ...r: unknown[]) => string | undefined).call(
      JSON,
      value,
      ...rest,
    );
  } as typeof JSON.stringify;
  return {
    get frames() {
      return frames;
    },
    restore() {
      JSON.stringify = original;
    },
  };
}

test("同一 snapshot 版本的准入测量只全量序列化一次（命中 memo）", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  const envelope = sendTextEnvelope("cmd-1");
  // 非输入命令不进测量路径（重构把守卫抽进 buildInputAdmissionQueueItem，钉住旧行为）。
  assert.equal(
    publisher.measureInputAdmissionProjectionBytes(
      { ...envelope, commandId: "cmd-stop", type: "stop", payload: {} },
      ADMISSION,
    ),
    null,
  );

  const spy = trackSnapshotFrameEncodings();
  try {
    const afterConstruction = spy.frames;
    const first = publisher.measureInputAdmissionProjectionBytes(envelope, ADMISSION);
    assert.equal(typeof first, "number");
    assert.equal(spy.frames, afterConstruction, "首次准入测量应命中构造期已测好的同一版本");
    const second = publisher.measureInputAdmissionProjectionBytes(envelope, ADMISSION);
    assert.equal(spy.frames, afterConstruction, "同版本第二次准入测量不得再次全量序列化");
    assert.equal(second, first, "同版本重复测量结果必须稳定");
    assert.equal(
      first,
      referenceAdmissionBytes(publisher, envelope, ADMISSION),
      "缓存路径与整份重算必须逐字节一致",
    );
  } finally {
    spy.restore();
  }
});

test("snapshot 版本变更后必须重测，且重测值与整份重算一致", () => {
  const publisher = new ConversationTopicPublisher(SESSION_ID, LOG_EPOCH);
  const envelope = sendTextEnvelope("cmd-1");
  const before = publisher.measureInputAdmissionProjectionBytes(envelope, ADMISSION);
  assert.equal(typeof before, "number");

  const spy = trackSnapshotFrameEncodings();
  try {
    const framesBeforeMutation = spy.frames;
    // TurnSteerQueued 入队一条消息：snapshot 换代（事件推进），且 queue.items 从空变非空，
    // 顺带覆盖增量里「原数组非空要补 1 个逗号」的分支。
    publisher.ingest(
      createEvent(1, SessionEventType.TurnSteerQueued, {
        pendingInputId: "qi-queued-1",
        input: "排队的第二条输入",
        inputPreview: "排队的第二条输入",
        inputSize: 7,
        targetTurnId: "turn-1",
        queueLength: 1,
      }),
    );
    const after = publisher.measureInputAdmissionProjectionBytes(envelope, ADMISSION);
    assert.ok(spy.frames > framesBeforeMutation, "版本变更后必须发生全量重测");
    assert.equal(typeof after, "number");
    assert.ok(
      (after as number) > (before as number),
      "入队一条消息后候选快照必须变大（测量值不是旧值）",
    );
    assert.equal(
      after,
      referenceAdmissionBytes(publisher, envelope, ADMISSION),
      "重测值与整份重算必须逐字节一致",
    );

    // 版本不再变：下一次测量重新命中，不再全量序列化。
    const framesAfterMutation = spy.frames;
    const third = publisher.measureInputAdmissionProjectionBytes(envelope, ADMISSION);
    assert.equal(spy.frames, framesAfterMutation, "版本未变的复测必须命中 memo");
    assert.equal(third, after);
  } finally {
    spy.restore();
  }
});
