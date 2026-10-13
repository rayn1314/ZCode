// 任务形态（模板 / 调度 / 截止）的领域规则：判定与互斥校验集中一处，供 create/update 共用。
// AutomationService 只调用而不内联这些规则，避免主文件行数持续膨胀、规则散落两处漂移。

import type {
  ZCodeAutomation,
  ZCodeAutomationCreateParams,
  ZCodeAutomationUpdateParams,
} from "@zcode/shared";
import {
  InvalidAutomationDeadlineError,
  InvalidAutomationRelativeDelayError,
  InvalidAutomationScheduleRuleError,
} from "#src/session/automationErrors.js";

/** 空 cron = 无调度 = 纯任务模板（仅手动运行）。 */
export function isTemplateAutomation(cronExpr: string): boolean {
  return !cronExpr.trim();
}

/** 截止时间（墙钟）必须在未来；undefined/null 表示不设截止。 */
export function assertAutomationDeadlineInFuture(
  deadlineMs: number | null | undefined,
  now: number,
): void {
  if (deadlineMs != null && deadlineMs <= now) throw new InvalidAutomationDeadlineError();
}

/**
 * 创建期的任务形态校验：判定是否模板，并拒绝模板与相对延迟 / 周期 carrier 的矛盾组合，
 * 以及已经过去的截止时间。返回是否为模板。
 */
export function assertCreateAutomationShape(
  params: ZCodeAutomationCreateParams,
  now: number,
): boolean {
  const isTemplate = isTemplateAutomation(params.cronExpr);
  if (isTemplate && params.relativeDelayMinutes !== undefined) {
    throw new InvalidAutomationRelativeDelayError("模板任务（无 cron）不能设置相对延迟");
  }
  if (isTemplate && params.intervalUnit !== undefined) {
    throw new InvalidAutomationScheduleRuleError("模板任务（无 cron）不能设置周期 carrier");
  }
  assertAutomationDeadlineInFuture(params.deadlineMs, now);
  return isTemplate;
}

/** 模板形态的创建参数：无调度、非周期、不参与 nextRunAt 计算。 */
export function toTemplateCreateParams(
  params: ZCodeAutomationCreateParams,
): ZCodeAutomationCreateParams {
  return { ...params, recurring: false, maxRuns: undefined, scheduleRule: undefined };
}

/** 模板形态的更新：清调度与重试态、保持 active，并强制 recurring=false。 */
export function applyTemplateUpdate(
  options: {
    nextRunAt?: number | null;
    lifecycleStatus?: ZCodeAutomation["lifecycleStatus"];
    resetRetry?: boolean;
  },
  params: ZCodeAutomationUpdateParams,
): ZCodeAutomationUpdateParams {
  options.nextRunAt = null;
  options.lifecycleStatus = "active";
  options.resetRetry = true;
  return { ...params, recurring: false };
}
