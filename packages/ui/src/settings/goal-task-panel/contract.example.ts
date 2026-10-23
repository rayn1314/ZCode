/**
 * goal-task-panel 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 四段真实用法：
 * 1. 行渲染要的派生量（状态徽标、剩余时间、主操作可用性）——纯函数，不写库。
 * 2. store 的两个写路径：新建（`start` 区分「保存」/「保存并运行」）与恢复（可能要新截止）。
 * 3. 形态筛选：一条 automation 可以同时命中「定时」与「目标」。
 */
import type { IZCodeAgentService } from "@zcode/services";
import type { ZCodeAutomation, ZCodeSessionGoal } from "@zcode/shared";
import {
  GOAL_FILTERS,
  canResumeGoal,
  goalResumeNeedsNewDeadline,
  goalTitle,
  matchesGoalFilter,
  resolveAutomationShapeFilter,
  resolveGoalDisplayStatus,
  type GoalFilter,
  type GoalManagementController,
} from "./contract.js";

/** 列表行需要的全部派生量；`displayStatus` 只由 DB 权威值 + 本地时钟推出，不由 UI 落库。 */
export function goalRowPresentationExample(
  goal: ZCodeSessionGoal,
  now: number,
  filter: GoalFilter,
): {
  title: string;
  displayStatus: ReturnType<typeof resolveGoalDisplayStatus>;
  visible: boolean;
  canResume: boolean;
  needsNewDeadline: boolean;
} {
  const displayStatus = resolveGoalDisplayStatus(goal, now);
  return {
    title: goalTitle(goal),
    displayStatus,
    visible: matchesGoalFilter(displayStatus, filter),
    canResume: canResumeGoal(goal),
    needsNewDeadline: goalResumeNeedsNewDeadline(goal, now),
  };
}

/** 筛选行取值：全部 / 进行中（含两种派生收尾态）/ 已暂停（含未启动）/ 已停止 / 已完成。 */
export const GOAL_FILTER_OPTIONS = GOAL_FILTERS;

/**
 * 新建任务：`start: true` = 保存并运行（立即续跑）；`start: false` = 只保存
 * （落 paused、不消耗算力、未配模型供应商也能成功）。返回承载会话 id。
 */
export async function createGoalExample(
  controller: GoalManagementController,
  agentService: IZCodeAgentService,
): Promise<string | null> {
  return controller.createGoal(
    {
      workspacePath: "E:/ws",
      objective: "到明早 10 点前持续发现 AI 产品设计缺陷并改进",
      endAtMs: Date.now() + 3_600_000,
      tokenBudget: null,
      start: true,
    },
    agentService,
  );
}

/** 恢复：截止已过的目标必须带新截止（或显式 null 表示不再设截止），否则服务端拒绝。 */
export async function resumeGoalExample(
  controller: GoalManagementController,
  agentService: IZCodeAgentService,
  goal: ZCodeSessionGoal,
  now: number,
): Promise<boolean> {
  const endAtMs = goalResumeNeedsNewDeadline(goal, now) ? now + 3_600_000 : goal.endAtMs;
  return controller.resumeGoal(goal.sessionId, endAtMs, agentService);
}

/** 形态筛选：`cronExpr` 非空=定时、`objective/deadlineMs` 有值=目标、无 cron=模板（可同时命中）。 */
export function automationShapesExample(
  automation: Pick<ZCodeAutomation, "cronExpr" | "objective" | "deadlineMs">,
): ReturnType<typeof resolveAutomationShapeFilter> {
  return resolveAutomationShapeFilter(automation);
}
