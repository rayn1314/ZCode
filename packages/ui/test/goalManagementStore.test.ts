// 任务面板 store 契约：列表落库、失败保留旧列表、resume 透传截止时间、createGoal 先建会话再设定目标。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { useGoalManagementStore } from "../src/store/goalManagementStore.js";

const WORKSPACE_PATH = "E:/ws";

function entry(
  sessionId: string,
  overrides: Partial<ZCodeSessionGoalListEntry> = {},
): ZCodeSessionGoalListEntry {
  return {
    sessionId,
    sessionTitle: `session ${sessionId}`,
    workspacePath: WORKSPACE_PATH,
    archived: false,
    goal: {
      sessionId,
      targetId: `target-${sessionId}`,
      objective: `objective ${sessionId}`,
      summaryTitle: null,
      status: "active",
      tokenBudget: null,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      endAtMs: null,
      deadlineGraceUsed: false,
      createdAt: 1_000,
      updatedAt: 1_000,
      ...overrides.goal,
    },
    ...overrides,
  };
}

interface GoalCall {
  workspacePath: string;
  workspaceIdentity?: string;
  sessionId: string;
  action: string;
  objective?: string;
  endAtMs?: number | null;
  tokenBudget?: number | null;
}

interface CreateFakeServiceOptions {
  goals?: ZCodeSessionGoalListEntry[];
  failList?: boolean;
}

function createFakeService(options: CreateFakeServiceOptions = {}) {
  const calls = {
    list: [] as Array<{ workspacePath: string; includeArchived?: boolean }>,
    goal: [] as GoalCall[],
    create: [] as Array<{ workspacePath: string }>,
  };
  const state = {
    goals: options.goals ?? [],
    failList: options.failList ?? false,
  };

  const service = {
    async listSessionGoals(params: { workspacePath: string; includeArchived?: boolean }) {
      calls.list.push(params);
      if (state.failList) {
        throw new Error("list failed");
      }
      return { goals: state.goals };
    },
    async goalSession(params: GoalCall) {
      calls.goal.push(params);
      return {
        response: "",
        snapshot: { session: { sessionId: params.sessionId } } as never,
      };
    },
    async createSession(params: { workspacePath: string }) {
      calls.create.push(params);
      return { session: { sessionId: "new-session" } } as never;
    },
  };

  return { service: service as unknown as IZCodeAgentService, calls, state };
}

function resetStore() {
  useGoalManagementStore.setState({
    workspacePath: null,
    workspaceIdentity: null,
    goals: [],
    loading: false,
    error: null,
    operationId: null,
  });
}

test("initialize 把列表写入 state，并按 includeArchived 全量拉取", async () => {
  resetStore();
  const { service, calls } = createFakeService({ goals: [entry("s1")] });

  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  const state = useGoalManagementStore.getState();
  assert.equal(state.workspacePath, WORKSPACE_PATH);
  assert.equal(state.goals.length, 1);
  assert.equal(state.goals[0].sessionId, "s1");
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  // 归档开关是客户端过滤，查询必须一次性带回归档会话的目标。
  assert.equal(calls.list.length, 1);
  assert.equal(calls.list[0].includeArchived, true);
});

test("列表加载失败时保留旧列表并置 error", async () => {
  resetStore();
  const { service, state } = createFakeService({ goals: [entry("s1")] });
  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });
  assert.equal(useGoalManagementStore.getState().goals.length, 1);

  state.failList = true;
  await useGoalManagementStore.getState().refresh(service);

  const afterFailure = useGoalManagementStore.getState();
  assert.equal(afterFailure.goals.length, 1, "失败不清空列表");
  assert.equal(afterFailure.error, "list failed");
  assert.equal(afterFailure.loading, false);
});

test("resumeGoal 原样透传 endAtMs（含显式 null）", async () => {
  resetStore();
  const { service, calls } = createFakeService({ goals: [entry("s1")] });
  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  await useGoalManagementStore.getState().resumeGoal("s1", null, service);
  const cleared = calls.goal.at(-1) as GoalCall;
  assert.equal(cleared.action, "resume");
  assert.ok("endAtMs" in cleared, "显式 null 必须出现在参数里，不能被省略");
  assert.equal(cleared.endAtMs, null);

  await useGoalManagementStore.getState().resumeGoal("s1", 1_700_000_000_000, service);
  const rescheduled = calls.goal.at(-1) as GoalCall;
  assert.equal(rescheduled.action, "resume");
  assert.equal(rescheduled.endAtMs, 1_700_000_000_000);
});

test("createGoal 不传 sessionId 时先建会话再 set，并返回新 sessionId", async () => {
  resetStore();
  const { service, calls } = createFakeService();
  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  const sessionId = await useGoalManagementStore
    .getState()
    .createGoal(
      { objective: "keep improving", endAtMs: 1_700_000_000_000, tokenBudget: null },
      service,
    );

  assert.equal(sessionId, "new-session");
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].workspacePath, WORKSPACE_PATH);
  const goalCall = calls.goal[0];
  assert.equal(goalCall.action, "set");
  assert.equal(goalCall.sessionId, "new-session");
  assert.equal(goalCall.objective, "keep improving");
  assert.equal(goalCall.endAtMs, 1_700_000_000_000);
  assert.equal(goalCall.tokenBudget, null);
});

test("createGoal 传 sessionId 时不再新建会话", async () => {
  resetStore();
  const { service, calls } = createFakeService();
  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  const sessionId = await useGoalManagementStore
    .getState()
    .createGoal({ objective: "reuse", endAtMs: null, tokenBudget: 1000, sessionId: "s9" }, service);

  assert.equal(sessionId, "s9");
  assert.equal(calls.create.length, 0);
  assert.equal(calls.goal[0].sessionId, "s9");
  assert.equal(calls.goal[0].tokenBudget, 1000);
});
