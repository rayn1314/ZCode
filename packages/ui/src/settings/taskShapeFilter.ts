import type { ZCodeAutomation } from "@zcode/shared";

/**
 * 任务形态筛选（scheduled tab 内、状态筛选旁）：
 * 一个自动化可以同时具备「定时」「目标」「模板」三种形态标签，互不排斥：
 * - scheduled = cronExpr 非空（有开始调度）
 * - goal = 设置了会话目标（objective 描述或 deadlineMs 执行截止）
 * - template = cronExpr 为空（纯模板，仅手动运行）
 * 组合任务（定时+目标）同时满足 scheduled 与 goal 两个筛选项，两处都会出现。
 */
export type AutomationTaskShape = "scheduled" | "goal" | "template";
export type AutomationShapeFilter = "all" | AutomationTaskShape;

export const AUTOMATION_SHAPE_FILTERS: readonly AutomationShapeFilter[] = [
  "all",
  "scheduled",
  "goal",
  "template",
];

type ShapeFilterLike = Pick<ZCodeAutomation, "cronExpr" | "objective" | "deadlineMs">;

/** 返回一条 automation 命中的全部形态标签（组合任务命中多个）。 */
export function resolveAutomationShapeFilter(automation: ShapeFilterLike): AutomationTaskShape[] {
  const shapes: AutomationTaskShape[] = [];
  if (automation.cronExpr.trim()) shapes.push("scheduled");
  if (automation.objective?.trim() || automation.deadlineMs != null) shapes.push("goal");
  if (!automation.cronExpr.trim()) shapes.push("template");
  return shapes;
}

export function applyAutomationShapeFilter<T extends ShapeFilterLike>(
  automations: readonly T[],
  filter: AutomationShapeFilter,
): readonly T[] {
  if (filter === "all") return automations;
  return automations.filter((automation) =>
    resolveAutomationShapeFilter(automation).includes(filter),
  );
}

/** 目标形态判定：卡片目标徽标展示与「被引用的目标会话」收集共用同一口径。 */
export function isGoalShapeAutomation(automation: ShapeFilterLike): boolean {
  return Boolean(automation.objective?.trim() || automation.deadlineMs != null);
}
