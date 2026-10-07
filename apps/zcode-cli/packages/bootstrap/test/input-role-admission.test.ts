// S2 准入缝（`resolveRoleCommandAdmission`）的契约测试：角色来源（活 record / store 回落）
// 与裁决结果。spec `subagent-session-as-first-class.md` S2。
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { resolveRoleCommandAdmission } from "../src/zcode-protocol/v4-bridge.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function envelope(type: CommandEnvelope["type"], sessionId: string | null): CommandEnvelope {
  return {
    clientId: "cli",
    commandId: "cmd-1",
    issuedAt: "2026-01-01T00:00:00Z",
    payload: {},
    sessionId,
    type,
  } as unknown as CommandEnvelope;
}

interface Harness {
  context: ZCodeProtocolAgentServerContext;
  sessions: Map<string, unknown>;
  storeLookups: string[];
}

function createHarness(input: {
  live?: { sessionId: string; taskType: string };
  stored?: { sessionId: string; taskType: string };
}): Harness {
  const sessions = new Map<string, unknown>();
  if (input.live) sessions.set(input.live.sessionId, { taskType: input.live.taskType });
  const storeLookups: string[] = [];
  const context = {
    deps: {
      sessionStore: {
        getSession: async (id: string) => {
          storeLookups.push(id);
          return input.stored && input.stored.sessionId === id
            ? { taskType: input.stored.taskType }
            : undefined;
        },
      },
    },
    sessions,
  } as unknown as ZCodeProtocolAgentServerContext;
  return { context, sessions, storeLookups };
}

test("活 record 判角色：subagent_child 的分叉/权限/输入三类裁决", async () => {
  const { context } = createHarness({
    live: { sessionId: "s_child", taskType: "subagent_child" },
  });

  assert.deepEqual(
    await resolveRoleCommandAdmission(context, envelope("forkAssistant", "s_child")),
    {
      admitted: false,
      reasonCode: "guard.subagentCannotDeriveSession",
    },
  );
  assert.deepEqual(await resolveRoleCommandAdmission(context, envelope("sendText", "s_child")), {
    admitted: true,
  });
  assert.deepEqual(
    await resolveRoleCommandAdmission(context, envelope("switchCollaborationMode", "s_child")),
    { admitted: false, reasonCode: "guard.subagentCannotEscalatePermission" },
  );
});

test("活 record 缺席时用 store 元数据判定，不激活第二个 runtime", async () => {
  const { context, sessions, storeLookups } = createHarness({
    stored: { sessionId: "s_detached", taskType: "subagent_child" },
  });

  assert.deepEqual(
    await resolveRoleCommandAdmission(context, envelope("forkAssistant", "s_detached")),
    { admitted: false, reasonCode: "guard.subagentCannotDeriveSession" },
  );
  // 只查元数据：store 被查了一次，注册表里没有新增活 record。
  assert.deepEqual(storeLookups, ["s_detached"]);
  assert.equal(sessions.size, 0);
  assert.equal(sessions.get("s_detached"), undefined);
});

test("interactive 角色对抽样命令一律放行", async () => {
  const { context } = createHarness({
    live: { sessionId: "s_main", taskType: "interactive" },
  });

  for (const type of [
    "createSession",
    "sendText",
    "switchCollaborationMode",
    "sendGoalCommand",
    "forkAssistant",
    "discardSharedContext",
  ] as const) {
    assert.deepEqual(await resolveRoleCommandAdmission(context, envelope(type, "s_main")), {
      admitted: true,
    });
  }
});

test("信封无 sessionId 时放行，且不查 store", async () => {
  const { context, storeLookups } = createHarness({
    stored: { sessionId: "s_detached", taskType: "subagent_child" },
  });

  assert.deepEqual(await resolveRoleCommandAdmission(context, envelope("forkAssistant", null)), {
    admitted: true,
  });
  assert.deepEqual(storeLookups, []);
});
