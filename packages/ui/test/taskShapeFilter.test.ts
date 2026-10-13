import { describe, expect, it } from "vitest";
import type { ZCodeAutomation } from "@zcode/shared";
import {
  applyAutomationShapeFilter,
  isGoalShapeAutomation,
  resolveAutomationShapeFilter,
  type AutomationShapeFilter,
} from "@/settings/taskShapeFilter.js";

function makeAutomation(overrides: Partial<ZCodeAutomation> = {}): ZCodeAutomation {
  return {
    automationId: "automation-1",
    title: "task",
    cronExpr: "",
    prompt: "run",
    workspaceKey: "/tmp/ws",
    workspacePath: "/tmp/ws",
    locationKind: "local",
    recurring: true,
    runCount: 0,
    enabled: true,
    lifecycleStatus: "active",
    dispatchStatus: "idle",
    dispatchAttempts: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe("task shape filter", () => {
  it("classifies the four shapes: scheduled / goal / template and combined dual-label", () => {
    // 纯模板：无开始调度，仅手动运行。
    expect(resolveAutomationShapeFilter(makeAutomation())).toEqual(["template"]);
    // 仅定时：有 cron，无目标配置。
    expect(resolveAutomationShapeFilter(makeAutomation({ cronExpr: "0 9 * * *" }))).toEqual([
      "scheduled",
    ]);
    // 仅目标：无 cron 但有 objective 或 deadline → 无周期调度，同时命中 goal 与 template 两个标签。
    expect(resolveAutomationShapeFilter(makeAutomation({ objective: "持续改进" }))).toEqual([
      "goal",
      "template",
    ]);
    expect(resolveAutomationShapeFilter(makeAutomation({ deadlineMs: 1_893_456_000_000 }))).toEqual(
      ["goal", "template"],
    );
    // 组合（定时+目标）：同时命中 scheduled 与 goal，两个筛选项都会出现。
    expect(
      resolveAutomationShapeFilter(
        makeAutomation({ cronExpr: "0 9 * * *", objective: "持续改进" }),
      ),
    ).toEqual(["scheduled", "goal"]);
  });

  it("filters automation lists by shape, keeping combined tasks under both labels", () => {
    const template = makeAutomation();
    const scheduled = makeAutomation({ cronExpr: "0 9 * * *" });
    const goal = makeAutomation({ objective: "持续改进" });
    const combined = makeAutomation({ cronExpr: "0 9 * * *", deadlineMs: 1_893_456_000_000 });
    const list = [template, scheduled, goal, combined];

    const byShape = (shape: AutomationShapeFilter) =>
      applyAutomationShapeFilter(list, shape).map((automation) => automation.automationId);

    expect(byShape("all")).toEqual([
      "automation-1",
      "automation-1",
      "automation-1",
      "automation-1",
    ]);
    // scheduled：仅定时 + 组合；goal：仅目标 + 组合；template：模板 + 仅目标（二者都无 cron）。
    expect(byShape("scheduled")).toEqual(["automation-1", "automation-1"]);
    expect(byShape("goal")).toEqual(["automation-1", "automation-1"]);
    expect(byShape("template")).toEqual(["automation-1", "automation-1"]);
    // 空列表与 all 过滤器保持稳定。
    expect(applyAutomationShapeFilter([], "all")).toEqual([]);
    expect(applyAutomationShapeFilter([], "goal")).toEqual([]);
  });

  it("isGoalShapeAutomation shares the same criterion as the goal shape", () => {
    expect(isGoalShapeAutomation(makeAutomation())).toBe(false);
    expect(isGoalShapeAutomation(makeAutomation({ objective: "  " }))).toBe(false);
    expect(isGoalShapeAutomation(makeAutomation({ objective: "目标" }))).toBe(true);
    expect(isGoalShapeAutomation(makeAutomation({ deadlineMs: 1 }))).toBe(true);
    expect(
      isGoalShapeAutomation(makeAutomation({ cronExpr: "0 9 * * *", objective: "目标" })),
    ).toBe(true);
  });
});
