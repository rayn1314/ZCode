import assert from "node:assert/strict";
import test from "node:test";
import { zcodeSessionEventSchema } from "@zcode/shared";
import type { ZCodeAgentServiceEvent } from "../src/zcode-agent/zcodeAgent.js";
import { createZCodeTaskServiceAdapter } from "../src/zcode-agent/zcodeTaskServiceAdapter.js";

/**
 * 契约：task_complete 落库行状态按 stopReason 分派（审计修复 #5）。
 *
 * 上游 turn.completed 的 resultType 词表（contracts TurnResultType）是
 * success / cancelled / error_*；投影侧把 error_* 派生为 phase "error"，
 * syncer 再把它落成 status "error"。task_complete 若无条件写 "completed"，
 * 会在"轮以 error_* 收口"的场景把行状态写成完成，与投影/syncer 打架。
 * 本测试驱动 adapter 的真实事件链（session.event → mapSessionEvent → applyAgentPatch）。
 */

const TARGET = "sess_target";
const WORKSPACE = "/example/workspace";
const AGENT_ID = "agent_00000000-0000-0000-0000-000000000001";

interface PatchRecord {
  patch: {
    status?: string;
    lastError?: unknown;
    updatedAt?: number;
    [key: string]: unknown;
  };
}

interface Fixture {
  patches: PatchRecord[];
  emitTurnCompleted(resultType: string): Promise<void>;
}

function createFixture(): Fixture {
  const patches: PatchRecord[] = [];
  let sessionListener: ((event: ZCodeAgentServiceEvent) => void) | undefined;

  const service = createZCodeTaskServiceAdapter({
    zcodeAgentService: {
      async sendConversationCommandV4() {
        throw new Error("task_complete status 测试不应触发 v4 投递");
      },
      disposeAll() {},
      onDynamicSessionEvent() {
        return (listener: (event: ZCodeAgentServiceEvent) => void) => {
          sessionListener = listener;
          return { dispose() {} };
        };
      },
      onDynamicSessionMessageSendRequested() {
        return () => ({ dispose() {} });
      },
    },
    taskIndexRepo: {
      async applyAgentPatch(params: { patch: PatchRecord["patch"] }) {
        patches.push({ patch: params.patch });
        return undefined;
      },
    },
    taskIndexSyncer: {
      ensureSessionSubscription() {},
      onSessionTerminalEvent: () => ({ dispose() {} }),
      onSessionReadyEvent: () => ({ dispose() {} }),
      disposeAll() {},
    },
  } as unknown as Parameters<typeof createZCodeTaskServiceAdapter>[0]);

  // 订阅入口顺带 rememberTaskTarget，等价于"该会话已加载"。
  service.onDynamicTaskEvent({
    taskId: TARGET,
    workspacePath: WORKSPACE,
    deliveryKind: "continuous",
  })(() => {});
  assert.ok(sessionListener, "adapter did not subscribe to session events");

  return {
    patches,
    async emitTurnCompleted(resultType) {
      const event = zcodeSessionEventSchema.parse({
        eventId: "evt_complete_1",
        sessionId: TARGET,
        turnId: "turn_1",
        seq: 1,
        traceId: "trace_1",
        timestamp: Date.now(),
        type: "turn.completed",
        payload: {
          response: "done",
          tokenCount: 1,
          toolCallCount: 0,
          duration: 10,
          inputId: `input_${AGENT_ID}`,
          resultType,
        },
      });
      sessionListener!({ type: "session.event", event });
      // applyAgentPatch 是 fire-and-forget 的 promise，让微任务队列跑完再断言。
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test("cancelled 的 turn.completed → 行状态 completed（对齐 completedInterrupted）", async () => {
  const fixture = createFixture();
  await fixture.emitTurnCompleted("cancelled");

  assert.equal(fixture.patches.length, 1);
  const patch = fixture.patches[0]!.patch;
  assert.equal(patch.status, "completed");
  // completed 沿旧语义清空 lastError（与 syncer 的 completed 分支一致）。
  assert.ok("lastError" in patch);
  assert.equal(patch.lastError, undefined);
});

test("success 的 turn.completed → 行状态 completed", async () => {
  const fixture = createFixture();
  await fixture.emitTurnCompleted("success");

  assert.equal(fixture.patches.length, 1);
  assert.equal(fixture.patches[0]!.patch.status, "completed");
});

test("error_* 的 turn.completed → 行状态 error，且不清 lastError（对齐投影/syncer）", async () => {
  const fixture = createFixture();
  await fixture.emitTurnCompleted("error_during_execution");

  assert.equal(fixture.patches.length, 1);
  const patch = fixture.patches[0]!.patch;
  assert.equal(
    patch.status,
    "error",
    "投影侧 error_* → phase error → syncer 落 status error，task_complete 不得写裸 completed",
  );
  // 错误正文不在 TurnComplete payload 里；syncer 的 error 分支同样保留 lastError 现值，
  // 交给随后的回源 snapshot 写权威值——这里不能顺手清空。
  assert.equal("lastError" in patch, false);
});
