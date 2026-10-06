import assert from "node:assert/strict";
import test from "node:test";
import {
  COMPACT_HOOK_TRIGGERS,
  CompactPhase,
  CompactReason,
  CompactTrigger,
  compactBoundaryPayloadSchema,
  compactTimelinePayloadSchema,
  isCompactHookTrigger,
} from "@zcode/contracts";

/**
 * 压缩契约扩展（spec: core/spec/context-compaction-controls.md §2 D10、§4 I5）：
 * 新增的 trigger/phase 必须同时被 timeline 与 boundary 两个 schema 接受，
 * 否则真实压缩事件会在落库/投影层被拒绝；Partial / SessionMemory 不得进入 hook 触发面。
 */

function timelinePayload(trigger: string, phase: string): Record<string, unknown> {
  return {
    operationId: "cmp_test",
    messageId: "msg_test",
    phase,
    status: "started",
    trigger,
  };
}

function boundaryPayload(trigger: string, phase: string): Record<string, unknown> {
  return {
    boundaryId: "bnd_test",
    phase,
    preCompactTokenCount: 1_000,
    summarizedMessageCount: 4,
    summaryMessageIds: [],
    traceId: "trace_test",
    trigger,
  };
}

test("compactTimelinePayload 接受 post_turn / model_downshift 与 post_turn phase", () => {
  const postTurn = compactTimelinePayloadSchema.parse(
    timelinePayload(CompactTrigger.PostTurn, CompactPhase.PostTurn),
  );
  assert.equal(postTurn.trigger, CompactTrigger.PostTurn);
  assert.equal(postTurn.phase, CompactPhase.PostTurn);

  const downshift = compactTimelinePayloadSchema.parse(
    timelinePayload(CompactTrigger.ModelDownshift, CompactPhase.PreRequest),
  );
  assert.equal(downshift.trigger, CompactTrigger.ModelDownshift);
  assert.equal(downshift.phase, CompactPhase.PreRequest);
});

test("compactBoundaryPayload 接受 post_turn / model_downshift 与对应 reason", () => {
  const postTurn = compactBoundaryPayloadSchema.parse({
    ...boundaryPayload(CompactTrigger.PostTurn, CompactPhase.PostTurn),
    compactReason: CompactReason.ContextLimit,
  });
  assert.equal(postTurn.trigger, CompactTrigger.PostTurn);

  const downshift = compactBoundaryPayloadSchema.parse({
    ...boundaryPayload(CompactTrigger.ModelDownshift, CompactPhase.PreRequest),
    compactReason: CompactReason.ModelDownshift,
  });
  assert.equal(downshift.trigger, CompactTrigger.ModelDownshift);
});

test("未知 trigger 仍被 schema 拒绝（枚举是有意加宽而非放开）", () => {
  assert.equal(compactTimelinePayloadSchema.safeParse(timelinePayload("whatever", "pre_request")).success, false);
  assert.equal(
    compactBoundaryPayloadSchema.safeParse(boundaryPayload("whatever", "pre_request")).success,
    false,
  );
});

test("hook 触发面包含五个触发器，且排除 partial / session_memory", () => {
  assert.deepEqual([...COMPACT_HOOK_TRIGGERS], [
    CompactTrigger.Manual,
    CompactTrigger.Auto,
    CompactTrigger.Reactive,
    CompactTrigger.PostTurn,
    CompactTrigger.ModelDownshift,
  ]);
  assert.equal(isCompactHookTrigger(CompactTrigger.PostTurn), true);
  assert.equal(isCompactHookTrigger(CompactTrigger.ModelDownshift), true);
  assert.equal(isCompactHookTrigger(CompactTrigger.Partial), false);
  assert.equal(isCompactHookTrigger(CompactTrigger.SessionMemory), false);
});
