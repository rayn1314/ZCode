// 任务面板 store 契约：列表落库、失败保留旧列表、resume 透传截止时间、
// createGoal 先建会话再设定目标、start/scope 参数透传、deadlineWarningSent 原样落库。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { useGoalManagementStore } from "../src/store/goalManagementStore.js";

const WORKSPACE_PATH = "E:/ws";
const SELECTED_PROJECT_PATH = "E:/other";

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
      deadlineWarningSent: false,
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
  start?: boolean;
}

interface CreateFakeServiceOptions {
  goals?: ZCodeSessionGoalListEntry[];
  failList?: boolean;
}

function createFakeService(options: CreateFakeServiceOptions = {}) {
  const calls = {
    list: [] as Array<{
      workspacePath: string;
      scope?: "workspace" | "all";
      includeArchived?: boolean;
    }>,
    goal: [] as GoalCall[],
    create: [] as Array<{ workspacePath: string }>,
  };
  const state = {
    goals: options.goals ?? [],
    failList: options.failList ?? false,
  };

  const service = {
    async listSessionGoals(params: {
      workspacePath: string;
      scope?: "workspace" | "all";
      includeArchived?: boolean;
    }) {
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

test("initialize 按 scope all + includeArchived 全量拉取，goal 字段原样落库", async () => {
  resetStore();
  const { service, calls } = createFakeService({
    goals: [entry("s1", { goal: { deadlineWarningSent: true } })],
  });

  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  const state = useGoalManagementStore.getState();
  assert.equal(state.workspacePath, WORKSPACE_PATH);
  assert.equal(state.goals.length, 1);
  assert.equal(state.goals[0].sessionId, "s1");
  // 跨项目全局列表：deadlineWarningSent 是只读标志，store 原样投影给面板徽标。
  assert.equal(state.goals[0].goal.deadlineWarningSent, true);
  assert.equal(state.loading, false);
  assert.equal(state.error, null);
  // 归档开关是客户端过滤，查询必须一次性带回归档会话的目标；scope all 一次列出全部项目。
  assert.equal(calls.list.length, 1);
  assert.equal(calls.list[0].scope, "all");
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

test("createGoal 按所选项目建会话再 set，start:false 透传", async () => {
  resetStore();
  const { service, calls } = createFakeService();
  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  const sessionId = await useGoalManagementStore.getState().createGoal(
    {
      workspacePath: SELECTED_PROJECT_PATH,
      objective: "keep improving",
      endAtMs: 1_700_000_000_000,
      tokenBudget: null,
      start: false,
    },
    service,
  );

  assert.equal(sessionId, "new-session");
  // 承载会话与 set 请求都落在表单选择的项目上（可能不是列表所在工作区）。
  assert.equal(calls.create.length, 1);
  assert.equal(calls.create[0].workspacePath, SELECTED_PROJECT_PATH);
  const goalCall = calls.goal[0];
  assert.equal(goalCall.workspacePath, SELECTED_PROJECT_PATH);
  assert.equal(goalCall.action, "set");
  assert.equal(goalCall.sessionId, "new-session");
  assert.equal(goalCall.objective, "keep improving");
  assert.equal(goalCall.endAtMs, 1_700_000_000_000);
  assert.equal(goalCall.tokenBudget, null);
  // 「保存」必须显式 start:false（服务端缺省是 true=保存并运行）。
  assert.equal(goalCall.start, false);
});

test("createGoal 传 sessionId 时不再新建会话；updateGoal 的 replace 透传 start:true", async () => {
  resetStore();
  const { service, calls } = createFakeService({ goals: [entry("s1")] });
  await useGoalManagementStore
    .getState()
    .initialize({ workspacePath: WORKSPACE_PATH, agentService: service });

  const sessionId = await useGoalManagementStore.getState().createGoal(
    {
      workspacePath: WORKSPACE_PATH,
      objective: "reuse",
      endAtMs: null,
      tokenBudget: 1000,
      start: true,
      sessionId: "s9",
    },
    service,
  );

  assert.equal(sessionId, "s9");
  assert.equal(calls.create.length, 0);
  assert.equal(calls.goal[0].sessionId, "s9");
  assert.equal(calls.goal[0].tokenBudget, 1000);
  assert.equal(calls.goal[0].start, true);

  const ok = await useGoalManagementStore.getState().updateGoal(
    {
      sessionId: "s1",
      objective: "revised",
      endAtMs: null,
      tokenBudget: null,
      start: true,
    },
    service,
  );
  assert.equal(ok, true);
  const replaced = calls.goal.at(-1) as GoalCall;
  assert.equal(replaced.action, "replace");
  assert.equal(replaced.sessionId, "s1");
  assert.equal(replaced.objective, "revised");
  assert.equal(replaced.start, true);
});
