/**
 * SessionPane 的能力面：把「这个 pane 能做什么」从散落的布尔抑制收敛成四个命名形态的一张表。
 *
 * 背景（spec: apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md 的 S4）：
 * 原来 `readOnly` / `selectionSideChat` 两个布尔以黑名单方式逐个关能力。子代理子会话要的是
 * 第三种组合（保留 composer 与 edit/retry，去掉 fork / goal / 权限模式），再叠一个布尔就会
 * 互相打架。形态一旦命名，能力判定只有一个真相源，也给得起逐格单测。
 *
 * 纯函数模块：不 import React，也不走 `@/` 别名，node:test 能直接跑。
 */

export type SessionPaneShape = "interactive" | "observe" | "selectionSideChat" | "subagentChild";

/**
 * 文件撤销不是布尔能力：`observe` 形态要保留「仍看 `allowWorkspaceFileRewind` 这个显式例外」，
 * 压成一个布尔就把这条语义丢了。
 */
type WorkspaceFileRewindCapability = "always" | "withAllowFlagOnly";

export interface SessionPaneCapabilities {
  shape: SessionPaneShape;
  /** `observe` 的既有布尔口径；下游把 readOnly 透传给子组件 / hook 的入参继续复用它。 */
  readOnly: boolean;
  /** 是否创建 composer（输入区）。 */
  composer: boolean;
  /** 是否接受文件拖放（拖进来会变成附件 / 引用）。 */
  dropTarget: boolean;
  /** 行内 `editUserQuery` / `retryTurn`。 */
  editRetry: boolean;
  /** 行内 fork（把一轮分叉成新会话）。 */
  fork: boolean;
  /** goal 命令：pause / resume 与 goal 斜杠命令。 */
  goalCommands: boolean;
  /**
   * goal 区块的**展示**，与 `goalCommands` 是两项能力（真值表在 `observe` 这一格上不同）。
   * 只读视图本来就看得到 goal 进度、只是没有控制入口；把展示一起关掉是信息量退化，
   * 不是"统一语义"。
   */
  goalPanel: boolean;
  /** composer 的权限模式选择器（含 Plan 勾选项与 Ctrl+Shift+M 循环，它们同属一个菜单一条命令）。 */
  permissionModeSelector: boolean;
  /** 后台任务卡的「取消」。 */
  cancelBackgroundWork: boolean;
  /** 划词动作（加到当前任务 / 在辅助对话里提问）。 */
  selectionActions: boolean;
  /** 注册「选中即开辅助对话」的 opener（含 `/side` 应用层命令）。 */
  selectionSideChatOpener: boolean;
  /** workspace 文件撤销。 */
  workspaceFileRewind: WorkspaceFileRewindCapability;
  /** 工作流 run journal 查询：按键是**父会话**，嵌套会话发这条查询会造出幽灵 runtime。 */
  runJournalQuery: boolean;
}

// spec 的 4×12 矩阵。逐格改动都要同步 packages/ui/test/sessionPaneCapabilities.test.ts。
const CAPABILITIES: Record<SessionPaneShape, SessionPaneCapabilities> = {
  interactive: {
    shape: "interactive",
    readOnly: false,
    composer: true,
    dropTarget: true,
    editRetry: true,
    fork: true,
    goalCommands: true,
    goalPanel: true,
    permissionModeSelector: true,
    cancelBackgroundWork: true,
    selectionActions: true,
    selectionSideChatOpener: true,
    workspaceFileRewind: "always",
    runJournalQuery: true,
  },
  observe: {
    shape: "observe",
    readOnly: true,
    composer: false,
    dropTarget: false,
    editRetry: false,
    fork: false,
    goalCommands: false,
    // 展示保留：这是 observe 形态改造前的既有行为（只有 pause/resume 被 readOnly 挡住）。
    goalPanel: true,
    permissionModeSelector: false,
    cancelBackgroundWork: false,
    selectionActions: false,
    selectionSideChatOpener: false,
    workspaceFileRewind: "withAllowFlagOnly",
    runJournalQuery: false,
  },
  selectionSideChat: {
    shape: "selectionSideChat",
    readOnly: false,
    composer: true,
    dropTarget: true,
    editRetry: false,
    fork: false,
    goalCommands: false,
    goalPanel: false,
    permissionModeSelector: true,
    cancelBackgroundWork: true,
    selectionActions: false,
    selectionSideChatOpener: false,
    workspaceFileRewind: "always",
    runJournalQuery: true,
  },
  subagentChild: {
    shape: "subagentChild",
    readOnly: false,
    composer: true,
    dropTarget: true,
    editRetry: true,
    fork: false,
    goalCommands: false,
    goalPanel: false,
    permissionModeSelector: false,
    cancelBackgroundWork: true,
    selectionActions: false,
    selectionSideChatOpener: false,
    workspaceFileRewind: "always",
    runJournalQuery: true,
  },
};

export function resolveSessionPaneCapabilities(shape: SessionPaneShape): SessionPaneCapabilities {
  return CAPABILITIES[shape];
}
