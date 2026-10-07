// 受限模式（launch spec 读不到的 subagent_child）的输入面契约（spec S4 前置 1）：
// 投影恒拒（且排序在 compacting/phase 之前）+ 初始快照如实带上 + 准入强制面拒绝对话输入类，
// 加上左栏角标字段 `runningSubagentCount` 的派生与 conflation 判等。
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  computeInputRouting,
  createInitialConversationSnapshot,
} from "../src/zcode-protocol-v4/projection-state.js";
import { SessionsIndexProjection } from "../src/zcode-protocol-v4/sessions-index-projection.js";
import { resolveRoleCommandAdmission } from "../src/zcode-protocol/v4-bridge.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

/** `AvailabilityContext` 未导出（模块内部形状）；按函数入参取型，避免为测试扩大导出面。 */
type AvailabilityContext = Parameters<typeof computeInputRouting>[0];

function context(overrides: Partial<AvailabilityContext>): AvailabilityContext {
  return {
    phase: "draft",
    goalStatus: null,
    compacting: false,
    goalVerifying: false,
    queueLength: 0,
    autoDrain: true,
    subagentLimitedMode: false,
    ...overrides,
  };
}

const REJECTED = { mode: "reject", reasonCode: "guard.subagentLimitedMode" } as const;

test("受限模式下无论 phase / compacting / queue 状态都拒输入（排序在 compacting 之前）", () => {
  const cases: Array<{ label: string; input: Partial<AvailabilityContext> }> = [
    { label: "running", input: { phase: "running" } },
    { label: "running+compacting", input: { phase: "running", compacting: true } },
    { label: "draft", input: { phase: "draft" } },
    { label: "draft+compacting", input: { phase: "draft", compacting: true } },
    { label: "running+goalVerifying", input: { phase: "running", goalVerifying: true } },
    {
      label: "completedSuccess+heldQueue",
      input: { phase: "completedSuccess", queueLength: 3, autoDrain: false },
    },
  ];
  for (const { label, input } of cases) {
    for (const followupMode of ["queue", "guide"] as const) {
      assert.deepEqual(
        computeInputRouting(context({ ...input, subagentLimitedMode: true }), followupMode),
        REJECTED,
        `${label} / ${followupMode}`,
      );
    }
  }
});

test("非受限会话的判定不受新分支影响", () => {
  assert.deepEqual(computeInputRouting(context({ phase: "running" }), "guide"), {
    mode: "guide",
  });
  assert.deepEqual(computeInputRouting(context({ phase: "running", compacting: true }), "queue"), {
    mode: "enqueue",
    reasonCode: "compactingAcceptsFutureInput",
  });
  assert.deepEqual(computeInputRouting(context({ phase: "draft" }), "queue"), {
    mode: "startNow",
  });
});

test("初始快照带 subagentLimitedMode 时 inputRouting 就是 reject，否则是 startNow", () => {
  const limited = createInitialConversationSnapshot("s_child", "epoch-1", {
    subagentLimitedMode: true,
  });
  assert.deepEqual(limited.inputRouting, REJECTED);
  const normal = createInitialConversationSnapshot("s_main", "epoch-1");
  assert.deepEqual(normal.inputRouting, { mode: "startNow" });
  assert.deepEqual(
    createInitialConversationSnapshot("s_main", "epoch-1", { subagentLimitedMode: false })
      .inputRouting,
    { mode: "startNow" },
  );
});

// ── sessions-index：左栏角标 `runningSubagentCount` ──

function runningSubagent(childSessionId: string) {
  return {
    childSessionId,
    subagentType: "general-purpose",
    title: childSessionId,
    status: "running" as const,
  };
}

function snapshotWithSubagents(
  subagents: ConversationSnapshot["subagents"] | undefined,
): ConversationSnapshot {
  const snapshot = createInitialConversationSnapshot("s_parent", "epoch-1");
  if (subagents) snapshot.subagents = subagents;
  return snapshot;
}

function indexExtra() {
  return { createdAt: 1, lastActivityAt: 2 };
}

test("2 个在跑子代理 → runningSubagentCount = 2；只有结束的子代理 → 整键缺席", () => {
  const index = new SessionsIndexProjection("ws-1", "epoch-1");
  const withRunning = index.upsertFromConversation(
    snapshotWithSubagents({
      revision: 1,
      childSessionIds: ["c1", "c2", "c3"],
      running: [runningSubagent("c1"), runningSubagent("c2")],
      endedTotal: 1,
    }),
    indexExtra(),
  );
  const upsert = withRunning[0];
  assert.ok(upsert && upsert.op === "session.upserted");
  assert.equal(upsert.session.runningSubagentCount, 2);

  const endedIndex = new SessionsIndexProjection("ws-1", "epoch-1");
  const noRunning = endedIndex.upsertFromConversation(
    snapshotWithSubagents({
      revision: 1,
      childSessionIds: ["c1"],
      running: [],
      endedTotal: 1,
    }),
    indexExtra(),
  );
  const endedUpsert = noRunning[0];
  assert.ok(endedUpsert && endedUpsert.op === "session.upserted");
  assert.equal("runningSubagentCount" in endedUpsert.session, false);
});

test("仅 running 数变化也产出 upsert delta（conflation 不吃它）", () => {
  const index = new SessionsIndexProjection("ws-1", "epoch-1");
  const base = snapshotWithSubagents({
    revision: 1,
    childSessionIds: ["c1", "c2"],
    running: [runningSubagent("c1")],
    endedTotal: 1,
  });
  assert.equal(index.upsertFromConversation(base, indexExtra()).length, 1);

  const next = snapshotWithSubagents({
    revision: 2,
    childSessionIds: ["c1", "c2"],
    running: [runningSubagent("c1"), runningSubagent("c2")],
    endedTotal: 0,
  });
  const deltas = index.upsertFromConversation(next, indexExtra());
  const delta = deltas[0];
  assert.ok(delta && delta.op === "session.upserted");
  assert.equal(delta.session.runningSubagentCount, 2);
  // 同为 2 时判等吃掉该帧：字段参与判等，不是"永真差异"。
  assert.deepEqual(index.upsertFromConversation(next, indexExtra()), []);
});

// ── 准入强制面：只认活 record ──

function admissionContext(record: Record<string, unknown>): ZCodeProtocolAgentServerContext {
  return {
    deps: {},
    sessions: new Map<string, unknown>([["s_child", record]]),
  } as unknown as ZCodeProtocolAgentServerContext;
}

function envelope(type: string): CommandEnvelope {
  return {
    clientId: "cli",
    commandId: "cmd-1",
    issuedAt: "2026-01-01T00:00:00Z",
    payload: {},
    sessionId: "s_child",
    type,
  } as unknown as CommandEnvelope;
}

test("准入缝：受限活 record 拒 sendText，放行 deleteSession", async () => {
  const limited = admissionContext({ subagentLimitedMode: true, taskType: "subagent_child" });
  assert.deepEqual(await resolveRoleCommandAdmission(limited, envelope("sendText")), {
    admitted: false,
    reasonCode: "guard.subagentLimitedMode",
  });
  assert.deepEqual(await resolveRoleCommandAdmission(limited, envelope("deleteSession")), {
    admitted: true,
  });

  const normal = admissionContext({ taskType: "subagent_child" });
  assert.deepEqual(await resolveRoleCommandAdmission(normal, envelope("sendText")), {
    admitted: true,
  });
});
