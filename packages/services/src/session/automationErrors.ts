// 定时任务领域的可展示错误类型，集中一处便于审查与复用（AutomationService 只做 re-export）。
// 错误面是 UI/调用方判断失败原因的依据，故独立成文件，避免 service 主文件行数持续膨胀。

/** 无效 cron 表达式错误（供管理层向 UI 返回可展示信息）。 */
export class InvalidCronExprError extends Error {
  constructor(cronExpr: string) {
    super(`非法的 cron 表达式：${cronExpr}`);
    this.name = "InvalidCronExprError";
  }
}

/** 非法的有限次数更新错误；用于阻止矛盾状态写入并误结束仍在运行的任务。 */
export class InvalidAutomationMaxRunsUpdateError extends Error {
  constructor(message = "清空 maxRuns 时必须在同一次更新中设置 recurring=true") {
    super(message);
    this.name = "InvalidAutomationMaxRunsUpdateError";
  }
}

/** 非法自定义调度规则；规则必须先通过领域校验才能写入内部任务库。 */
export class InvalidAutomationScheduleRuleError extends Error {
  constructor(message: string) {
    super(`非法的定时任务调度规则：${message}`);
    this.name = "InvalidAutomationScheduleRuleError";
  }
}

/** 执行截止时间必须在未来（墙钟 deadline 语义，与现有 endAt 日末边界不同）。 */
export class InvalidAutomationDeadlineError extends Error {
  constructor() {
    super("执行截止时间必须在未来");
    this.name = "InvalidAutomationDeadlineError";
  }
}

/** 相对延迟只用于一次性任务，并由服务端真实时钟生成调度规则。 */
export class InvalidAutomationRelativeDelayError extends Error {
  constructor(message: string) {
    super(`非法的相对时间定时任务：${message}`);
    this.name = "InvalidAutomationRelativeDelayError";
  }
}
