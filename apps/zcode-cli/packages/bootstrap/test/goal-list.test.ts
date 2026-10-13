// session/goalList 契约：workspace 级只读查询，供任务面板消费。
// 钉三件事：工作区隔离（identity 优先、回退路径）、归档过滤、以及响应必须通过
// strict 的 zcodeSessionGoalListResultSchema（含新增的 endAtMs / deadlineGraceUsed）。
import assert from "node:assert/strict";
import test from "node:test";
import type { SessionGoal, SessionGoalListEntry } from "@zcode/contracts";
import { zcodeSessionGoalListResultSchema } from "@zcode/shared";
import { goalListSessions } from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

const WS_A = "E:\\workspace-a";
const WS_B = "E:\\workspace-b";
const DEADLINE = 1_900_000_000_000;

function goal(sessionID: string, overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: sessionID as SessionGoal["sessionID"],
    targetID: `target-${sessionID}`,
    objective: "keep improving the product",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 12,
    timeUsedSeconds: 34,
    endAtMs: DEADLINE,
    deadlineGraceUsed: false,
    time: { created: 1, updated: 2 },
    ...overrides,
  };
}

function entry(
  sessionID: string,
  workspacePath: string,
  overrides: Partial<SessionGoalListEntry> = {},
): SessionGoalListEntry {
  return {
    goal: goal(sessionID),
    sessionID: sessionID as SessionGoalListEntry["sessionID"],
    sessionTitle: `session ${sessionID}`,
    workspacePath,
    archived: false,
    ...overrides,
  };
}

function createContext(entries: SessionGoalListEntry[] | null): ZCodeProtocolAgentServerContext {
  return {
    sessions: new Map(),
    deps: {
      // 桩模拟 SQL 的 directory 预过滤；handler 之后还要按 workspace key 再过滤一次。
      sessionStore:
        entries === null
          ? undefined
          : {
              listTargets: async (input?: { directory?: string }) =>
                input?.directory
                  ? entries.filter((item) => item.workspacePath === input.directory)
                  : entries,
            },
    },
    logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  } as unknown as ZCodeProtocolAgentServerContext;
}

test("不带 workspace 时返回全部未归档目标，且通过 strict 协议 schema", async () => {
  const result = await goalListSessions(
    createContext([entry("s1", WS_A), entry("s2", WS_B)]),
    {},
  );
  assert.equal(result.goals.length, 2);
  const parsed = zcodeSessionGoalListResultSchema.parse(result);
  assert.equal(parsed.goals.length, 2);
  const first = parsed.goals.find((item) => item.sessionId === "s1");
  assert.ok(first);
  assert.equal(first.goal.endAtMs, DEADLINE);
  assert.equal(first.goal.deadlineGraceUsed, false);
  assert.equal(first.sessionTitle, "session s1");
  assert.equal(first.archived, false);
});

test("带 workspace 时按 identity 优先、回退 path 做隔离（与 listSessions 同判据）", async () => {
  const entries: SessionGoalListEntry[] = [
    entry("s1", WS_A, { workspaceIdentity: "remote-ws-a" }),
    entry("s2", WS_A, { workspaceIdentity: "remote-ws-b" }),
    entry("s3", WS_A),
  ];

  // 带 identity 查询：只有 identity 相同的命中，未写 identity 的行不会回退到 path 被误收。
  const byIdentity = await goalListSessions(createContext(entries), {
    workspace: {
      workspacePath: WS_A,
      workspaceIdentity: "remote-ws-a",
      workspaceKey: "remote-ws-a",
    },
  });
  assert.deepEqual(
    byIdentity.goals.map((item) => item.sessionId),
    ["s1"],
  );

  // 不带 identity 查询：只有该路径且没有 identity 的行命中。
  const byPath = await goalListSessions(createContext(entries), {
    workspace: { workspacePath: WS_A, workspaceKey: WS_A },
  });
  assert.deepEqual(
    byPath.goals.map((item) => item.sessionId),
    ["s3"],
  );
});

test("默认排除已归档会话；includeArchived 时带上", async () => {
  const entries = [entry("s1", WS_A), entry("s2", WS_A, { archived: true })];
  assert.equal((await goalListSessions(createContext(entries), {})).goals.length, 1);
  const withArchived = await goalListSessions(createContext(entries), {
    includeArchived: true,
  });
  assert.equal(withArchived.goals.length, 2);
});

test("scope: all 时忽略 workspace 过滤，返回全部未归档目标（任务面板跨项目视图）", async () => {
  const entries = [
    entry("s1", WS_A, { workspaceIdentity: "remote-ws-a" }),
    entry("s2", WS_B),
  ];
  const result = await goalListSessions(createContext(entries), {
    workspace: { workspacePath: WS_A, workspaceKey: WS_A },
    scope: "all",
  });
  assert.deepEqual(
    result.goals.map((item) => item.sessionId).sort(),
    ["s1", "s2"],
  );
});

test("store 未提供 listTargets 时返回空列表，不抛错", async () => {
  const result = await goalListSessions(createContext(null), {});
  assert.deepEqual(result, { goals: [] });
});
