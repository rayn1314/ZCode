/**
 * goal-task-panel 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：把「会话目标（goal / session_target）」渲染成用户能管理的任务面板——状态、截止时间、
 * 承载会话、暂停/恢复/清除；同时提供「任务形态」（定时 / 目标 / 模板）在自动化面板里的统一语义。
 *
 * 唯一所有者与写路径（详见 apps/zcode-cli/packages/core/spec/goal-task-panel-and-deadline.md）：
 * - 状态所有者是 `session_target` 表（`sessionStore` 端口），唯一写者是服务端的
 *   `setTarget / setTargetStatus / clearTarget`；本模块的 store 只做投影与命令下发，没有乐观状态机。
 * - 到点的唯一裁决点是 contracts 的纯函数 `decideGoalDeadline`：到点先放行一轮收尾
 *   （`deadlineGraceUsed=false → "wrap-up"`），收尾轮用掉后再结算 `deadline_reached`（`"settle"`）。
 * - 「未启动」（`paused` 且从没消耗过 token/时长）与「已到截止时间（收尾中 / 待结算）」都是
 *   **面板派生显示**，只读、不落库；UI 只读服务端置位的 `deadlineWarningSent` 标志，不自己算预警阈值。
 * - `start: false` 表示「保存但不运行」：新建落 `paused`、编辑保持原状态，不触发任何续跑，
 *   未配置模型供应商也能保存。
 *
 * 本文件同时是「重导出 + 漂移断言」两个作用：类型与派生函数只有一份实现，契约负责把它们
 * 汇总成对外可读的入口，并在编译期钉死它们与实现一致。
 */
import type { IZCodeAgentService } from "@zcode/services";
import { useGoalManagementStore } from "@/store/goalManagementStore.js";
import type { CreateGoalInput, UpdateGoalInput } from "@/store/goalManagementStore.js";

/**
 * 面板派生显示态：权威值只有 DB 的 `status`，这里额外区分三种时间处境。
 * - `deadlineReached`：已过点、收尾轮还没跑（服务端还会给一轮收尾）；
 * - `deadlinePending`：收尾轮已发出、等待结算；
 * - `notStarted`：`paused` 且从没消耗过 token/时长（新建落 paused 还没运行过）。
 */
export type { GoalDisplayStatus, GoalFilter } from "@/app-shell/goalDisplay.js";
export type { AutomationShapeFilter, AutomationTaskShape } from "@/settings/taskShapeFilter.js";
export type { GoalEditSubmit } from "@/app-shell/GoalEditView.js";
export type { GoalProjectSelection } from "@/app-shell/GoalProjectField.js";
export type { GoalHostMode } from "@/app-shell/GoalSessionField.js";
export type { GoalsPanelProps } from "@/app-shell/GoalsPanel.js";
export type { CreateGoalInput, UpdateGoalInput } from "@/store/goalManagementStore.js";

export {
  GOAL_FILTERS,
  GOAL_LIST_GRID_CLASS,
  GOAL_LIST_SCROLL_THRESHOLD,
} from "@/app-shell/goalDisplay.js";
export {
  canPauseGoal,
  canResumeGoal,
  formatRemaining,
  goalDeadlineText,
  goalResumeNeedsNewDeadline,
  goalTitle,
  isGoalApproachingDeadline,
  matchesGoalFilter,
  resolveGoalDisplayStatus,
  workspaceLabelFromPath,
} from "@/app-shell/goalDisplay.js";
export {
  AUTOMATION_SHAPE_FILTERS,
  applyAutomationShapeFilter,
  isGoalShapeAutomation,
  resolveAutomationShapeFilter,
} from "@/settings/taskShapeFilter.js";

/**
 * 面板 store 的 action 语义（`useGoalManagementStore` 的对外面）。参数里的 `agentService`
 * 由调用方注入（本模块不解析服务），`workspaceIdentity` 用于远端会话路由。
 * 每个写 action 的返回值只表示「命令是否被服务端接受」；列表状态一律由随后的重载决定，
 * 因此调用方不要在本地推导新状态。
 */
export interface GoalManagementController {
  /**
   * 进入面板：按 workspace 加载（`scope: "all"`、`includeArchived: true`，归档开关在客户端过滤）。
   * 已有同 workspace 缓存时后台刷新、保留列表避免闪烁；失败保留旧列表并把错误写进 `error`。
   */
  initialize(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    agentService: IZCodeAgentService;
  }): Promise<void>;
  /** 重新加载当前 workspace 列表；无 workspace 时为空操作。 */
  refresh(agentService: IZCodeAgentService): Promise<void>;
  /**
   * 创建目标；未传 `sessionId` 时先新建会话再设定目标（`action: "set"`）。
   * 返回承载会话 id（新建时是新会话 id），失败返回 null。
   */
  createGoal(input: CreateGoalInput, agentService: IZCodeAgentService): Promise<string | null>;
  /** 编辑已有目标（`action: "replace"`）：同 workspace 内换描述/截止/预算，不新建目标。 */
  updateGoal(input: UpdateGoalInput, agentService: IZCodeAgentService): Promise<boolean>;
  /** 暂停（仅 `active` 可暂停）；已暂停/已截止/预算受限都不受影响。 */
  pauseGoal(sessionId: string, agentService: IZCodeAgentService): Promise<boolean>;
  /**
   * 恢复：`endAtMs` 必须显式给出（`null` = 恢复后不再设截止）。
   * 服务端要求恢复 `deadline_reached` 目标时带新截止，否则拒绝——UI 用
   * `goalResumeNeedsNewDeadline` 决定是否先弹「重新设定截止时间」。
   */
  resumeGoal(
    sessionId: string,
    endAtMs: number | null,
    agentService: IZCodeAgentService,
  ): Promise<boolean>;
  /** 清除目标（`action: "clear"`）：行消失，会话本身不动。 */
  clearGoal(sessionId: string, agentService: IZCodeAgentService): Promise<boolean>;
}

type Assert<T extends true> = T;

/**
 * 编译期断言：store 的 action 面必须满足本契约（store 多出的状态字段不参与）。
 * 契约里声明了 store 没有的 action，或签名漂移，都会在这里报类型错。
 */
export type GoalManagementStoreImplementsController = Assert<
  ReturnType<typeof useGoalManagementStore.getState> extends GoalManagementController ? true : false
>;
