# goal-task-panel

## 意图

把「会话目标（goal / `session_target`）」做成用户可管理的**任务面板**（状态、截止时间、承载会话、
暂停/恢复/清除），并承载「任务纳入自动化体系」后的统一语义：一个任务 = 三组互不排斥的配置
（开始调度 cron / 截止时间 `deadlineMs` / 会话目标 `objective`），四种形态（仅定时、仅截止、
纯模板、组合）。

规格：`apps/zcode-cli/packages/core/spec/goal-task-panel-and-deadline.md`（行为、状态机、事件顺序、
UI 规格与 A1–A19 验收场景都在那里，不在此复制）。

## 不变量

- **权威状态只认 DB**：`session_target` 表是唯一所有者，唯一写者是服务端的
  `setTarget / setTargetStatus / clearTarget`；面板 store 只做投影 + 命令下发，没有乐观状态机，
  action 的返回值只表示「命令是否被接受」，列表状态由随后的重载决定。
- **派生显示不落库**：`deadlineReached`（过点待收尾）/ `deadlinePending`（收尾轮已发等待结算）/
  `notStarted`（paused 且没消耗过 token/时长）都由 `resolveGoalDisplayStatus` 在面板本地推出；
  预警只读服务端置位的 `deadlineWarningSent`，UI 不自算阈值（阈值在 contracts）。
- **收尾只给一次，硬停必达**：到点由 contracts 的 `decideGoalDeadline` 唯一裁决——先放行一轮收尾，
  `deadlineGraceUsed` 落库后才结算 `deadline_reached`；`deadline_reached` 与 `budget_limited`
  都是自动停止（预算与截止同时满足时预算优先判定）。
- **恢复必须显式给截止**：恢复 `deadline_reached`（或截止已过）的目标时服务端要求带新 `endAtMs`，
  或显式传 `null` 表示不再设截止；UI 用 `goalResumeNeedsNewDeadline` 决定先弹小表单。
- **保存 ≠ 运行**：`start: false` 新建落 `paused`、编辑保持原状态，不触发续跑、未配供应商也能保存；
  只有 `start: true` 或恢复才进入续跑候选。
- **跨项目列表**：面板进入即 `scope: "all"` + `includeArchived: true` 一次取全量，归档开关在客户端过滤
  （切换零延迟、不发新查询）；写命令的目标 workspace 优先取行自带的身份，缺失才回退列表 workspace。
- **形态互斥但可叠加**：`cronExpr` 非空 = 定时，`objective`/`deadlineMs` 有值 = 目标，无 cron = 模板；
  组合任务（定时+目标）同时命中两个筛选项。

## 与其它模块的交集（hook 点）

- **命令通道**：面板所有读写经 `IZCodeAgentService`（`listSessionGoals` / `goalSession`），
  不新增 v4 命令；`start: false` 的 set/replace 在服务层走只读客户端。
- **协议与投影**：`session/goal` 的 `endAtMs` / `tokenBudget` / `start` 参数与 `session/goalList` 的
  `scope` 定义在 `packages/shared`；`deadline_reached` 枚举的每个副本（contracts / shared /
  bootstrap 投影 / CLI 命令中心 / services 适配器 / ui 投影）必须同改，漏一处会被 zod 拒绝。
- **到点提醒与预警**：文案与阈值常量在 CLI contracts，core 在「读到 active 且结算为 deadline_reached」
  的那次跃迁发出一次提醒；UI 只消费标志位。
- **自动化定义侧**：`packages/services/src/session/automationTaskShape.ts` 的形态判定与互斥校验、
  `automationErrors.ts` 的可展示错误类、`tasksDatabase/task-goal-merge-v4.ts` 的 0004 补列，
  是同一「任务定义」语义在 services 侧的实现（由 automationService 内联调用）；
  UI 侧只对应 `taskShapeFilter.ts` 的同口径筛选。
