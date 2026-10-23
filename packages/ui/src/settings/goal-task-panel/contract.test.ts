import type { ZCodeAutomation, ZCodeSessionGoal } from "@zcode/shared";
import { describe, expect, it } from "vitest";

import {
  applyAutomationShapeFilter,
  canPauseGoal,
  canResumeGoal,
  goalResumeNeedsNewDeadline,
  matchesGoalFilter,
  resolveAutomationShapeFilter,
  resolveGoalDisplayStatus,
} from "./contract.js";

// 契约测试断言的是面板的派生口径与形态语义（spec: apps/zcode-cli/packages/core/spec/
// goal-task-panel-and-deadline.md 的 D5 与「任务纳入自动化体系」一节），不锁死渲染细节。

const NOW = Date.UTC(2026, 9, 23, 12, 0, 0);

function goal(overrides: Partial<ZCodeSessionGoal> = {}): ZCodeSessionGoal {
  return {
    sessionId: "s1",
    targetId: "t1",
    objective: "objective",
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
    ...overrides,
  };
}

function automation(overrides: Partial<ZCodeAutomation> = {}): ZCodeAutomation {
  return {
    automationId: "a1",
    title: "task",
    prompt: "prompt",
    cronExpr: "",
    workspaceKey: "E:/ws",
    workspacePath: "E:/ws",
    locationKind: "local",
    recurring: false,
    runCount: 0,
    enabled: true,
    lifecycleStatus: "active",
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: 1_000,
    updatedAt: 1_000,
    ...overrides,
  };
}

describe("goal-task-panel 派生显示态", () => {
  it("active 过一个已到的截止时间分成收尾中 / 待结算两档，权威值仍是 active", () => {
    const passed = NOW - 60_000;
    expect(resolveGoalDisplayStatus(goal({ endAtMs: passed }), NOW)).toBe("deadlineReached");
    expect(resolveGoalDisplayStatus(goal({ endAtMs: passed, deadlineGraceUsed: true }), NOW)).toBe(
      "deadlinePending",
    );
    expect(resolveGoalDisplayStatus(goal({ endAtMs: NOW + 60_000 }), NOW)).toBe("active");
  });

  it("未启动是 paused 的特例，自动停止的两态都显示已停止", () => {
    expect(resolveGoalDisplayStatus(goal({ status: "paused" }), NOW)).toBe("notStarted");
    expect(resolveGoalDisplayStatus(goal({ status: "paused", tokensUsed: 5 }), NOW)).toBe("paused");
    expect(resolveGoalDisplayStatus(goal({ status: "deadline_reached" }), NOW)).toBe("stopped");
    expect(resolveGoalDisplayStatus(goal({ status: "budget_limited" }), NOW)).toBe("stopped");
    expect(resolveGoalDisplayStatus(goal({ status: "complete" }), NOW)).toBe("complete");
  });

  it("筛选把派生收尾态归入进行中，把未启动归入已暂停", () => {
    expect(matchesGoalFilter("deadlineReached", "active")).toBe(true);
    expect(matchesGoalFilter("deadlinePending", "active")).toBe(true);
    expect(matchesGoalFilter("notStarted", "paused")).toBe(true);
    expect(matchesGoalFilter("stopped", "active")).toBe(false);
    expect(matchesGoalFilter("complete", "stopped")).toBe(false);
    expect(matchesGoalFilter("complete", "all")).toBe(true);
  });
});

describe("goal-task-panel 行内操作可用性", () => {
  it("只有 active 能暂停；自动停止与暂停都能恢复", () => {
    expect(canPauseGoal(goal())).toBe(true);
    expect(canPauseGoal(goal({ status: "paused" }))).toBe(false);
    expect(canResumeGoal(goal({ status: "paused" }))).toBe(true);
    expect(canResumeGoal(goal({ status: "deadline_reached" }))).toBe(true);
    expect(canResumeGoal(goal({ status: "budget_limited" }))).toBe(true);
    expect(canResumeGoal(goal({ status: "complete" }))).toBe(false);
    // active 是运行中，主操作是暂停而不是恢复。
    expect(canResumeGoal(goal())).toBe(false);
  });

  it("恢复已截止或截止已过的目标必须先重新设定截止时间", () => {
    expect(goalResumeNeedsNewDeadline(goal({ status: "deadline_reached" }), NOW)).toBe(true);
    expect(goalResumeNeedsNewDeadline(goal({ status: "paused", endAtMs: NOW - 1 }), NOW)).toBe(
      true,
    );
    expect(goalResumeNeedsNewDeadline(goal({ status: "paused", endAtMs: NOW + 1 }), NOW)).toBe(
      false,
    );
    expect(goalResumeNeedsNewDeadline(goal({ status: "paused" }), NOW)).toBe(false);
  });
});

describe("goal-task-panel 任务形态语义", () => {
  it("定时与目标互不排斥，组合任务同时命中两档；无 cron 即模板", () => {
    const combined = automation({
      cronExpr: "0 9 * * *",
      objective: "improve",
      deadlineMs: NOW + 3_600_000,
    });
    expect(resolveAutomationShapeFilter(combined).sort()).toEqual(["goal", "scheduled"]);

    const template = automation({ cronExpr: "   " });
    expect(resolveAutomationShapeFilter(template)).toEqual(["template"]);

    const scheduledOnly = automation({ cronExpr: "0 9 * * *" });
    expect(resolveAutomationShapeFilter(scheduledOnly)).toEqual(["scheduled"]);

    expect(applyAutomationShapeFilter([combined, template], "goal")).toEqual([combined]);
    expect(applyAutomationShapeFilter([combined, template], "all")).toHaveLength(2);
  });
});
