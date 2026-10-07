// 会话角色 × 命令的输入准入**单源表**（spec `subagent-session-as-first-class.md` S2）。
//
// 为什么放在根 `shared` 而不是 CLI 的 `contracts`：表的键之一是 `CommandType`，
// 它就声明在同目录的 `command.ts`；另一个键是会话角色，根 `shared` 已有
// `zcodeSessionKindSchema`（与 CLI `contracts` 的 `SESSION_TASK_TYPES` 同集合）；
// 且 UI 也要读它（子会话 composer 据此禁用动作），而 `packages/ui` 不可能反向依赖
// `apps/zcode-cli/packages/contracts`。
//
// 三处强制点（V4 准入 / legacy `session/send` / 原生执行器）统一消费本表；判定只有一个来源。
// `satisfies Record<CommandType, InputCommandRoleRule>` 是**类型级穷尽守卫**：新增命令
// 必须在此显式裁决，否则编译失败（运行时那一半是 `test/input-role-policy.test.ts` 的键集相等断言）。
//
// `deniedFor` 是唯一的拒绝轴：缺席即放行，不设第二套"运行中/不运行"名单。
// `conversationInput` 与之正交：它只回答"该命令是否进 ledger / 三档投递"。
import type { z } from "zod";
import type { CommandType } from "./command.js";
import { zcodeSessionKindSchema } from "../zcode-protocol-legacy-types.js";

/** 会话角色 = 既有的 7 类会话种类；直接由单源 schema 推导，不另立平行联合。 */
export type SessionRole = z.infer<typeof zcodeSessionKindSchema>;

export type InputCommandDenialReason =
  | "guard.subagentCannotDeriveSession"
  | "guard.subagentCannotEscalatePermission"
  | "guard.subagentCannotRunGoalLoop"
  | "guard.selectionSideChatRestrictedCommand";

export interface InputCommandRoleRule {
  /** 本命令在这些角色下被拒（缺席 = 放行）。 */
  deniedFor?: Partial<Record<SessionRole, InputCommandDenialReason>>;
  /** 该命令是否属于"输入类"（进 ledger / 三档投递）；与准入判定是两件正交的事。 */
  conversationInput?: true;
}

export const INPUT_COMMAND_ROLE_POLICY = {
  createSession: {
    deniedFor: { subagent_child: "guard.subagentCannotDeriveSession" },
  },
  createSelectionSideSession: {
    deniedFor: { subagent_child: "guard.subagentCannotDeriveSession" },
  },
  sendText: { conversationInput: true },
  sendGoalCommand: {
    deniedFor: {
      selection_side_chat: "guard.selectionSideChatRestrictedCommand",
      subagent_child: "guard.subagentCannotRunGoalLoop",
    },
    conversationInput: true,
  },
  stop: {},
  compact: { conversationInput: true },
  forkAssistant: {
    deniedFor: {
      selection_side_chat: "guard.selectionSideChatRestrictedCommand",
      subagent_child: "guard.subagentCannotDeriveSession",
    },
  },
  applyFileRewind: {},
  editUserQuery: {
    deniedFor: { selection_side_chat: "guard.selectionSideChatRestrictedCommand" },
    conversationInput: true,
  },
  retryTurn: {
    deniedFor: { selection_side_chat: "guard.selectionSideChatRestrictedCommand" },
    conversationInput: true,
  },
  setAssistantFeedback: {},
  sendQueuedNow: {},
  guideQueueItem: {},
  editQueueItem: {},
  reorderQueueItem: {},
  deleteQueueItem: {},
  setAutoDrain: {},
  resolveInteraction: {},
  respondWorkspaceHookReview: {},
  toggleWorkspaceHookReviewItem: {},
  revokeWorkspaceHookTrust: {},
  requestWorkspaceHookReview: {},
  snoozeInteractionAutoResolution: {},
  switchModelConfig: {},
  switchCollaborationMode: {
    deniedFor: { subagent_child: "guard.subagentCannotEscalatePermission" },
  },
  setFollowupMode: {},
  pauseGoal: {
    deniedFor: {
      selection_side_chat: "guard.selectionSideChatRestrictedCommand",
      subagent_child: "guard.subagentCannotRunGoalLoop",
    },
  },
  resumeGoal: {
    deniedFor: {
      selection_side_chat: "guard.selectionSideChatRestrictedCommand",
      subagent_child: "guard.subagentCannotRunGoalLoop",
    },
  },
  cancelBackgroundWork: {},
  resumeWorkflowRun: {
    deniedFor: { subagent_child: "guard.subagentCannotDeriveSession" },
  },
  startSavedWorkflow: {
    deniedFor: { subagent_child: "guard.subagentCannotDeriveSession" },
  },
  amendWorkflowRunSettings: {
    deniedFor: { subagent_child: "guard.subagentCannotDeriveSession" },
  },
  renameSession: {},
  deleteSession: {},
  discardSharedContext: {
    deniedFor: { selection_side_chat: "guard.selectionSideChatRestrictedCommand" },
  },
} satisfies Record<CommandType, InputCommandRoleRule>;

/**
 * 角色裁决。`sessionRole` 为 `undefined`（未知会话，例如 record 尚未激活）时放行——
 * 本函数裁决不了未知会话，由下游 `requireRecord` 拒绝。
 */
export function resolveInputCommandAdmission(input: {
  sessionRole: SessionRole | undefined;
  command: CommandType;
}): { admitted: true } | { admitted: false; reasonCode: InputCommandDenialReason } {
  const { sessionRole, command } = input;
  if (sessionRole === undefined) return { admitted: true };
  const rule: InputCommandRoleRule = INPUT_COMMAND_ROLE_POLICY[command];
  const reasonCode = rule.deniedFor?.[sessionRole];
  if (reasonCode === undefined) return { admitted: true };
  return { admitted: false, reasonCode };
}

/** 该命令是否需要持久输入账本 / 三档投递（输入类命令）。 */
export function isConversationInputCommand(command: CommandType): boolean {
  const rule: InputCommandRoleRule = INPUT_COMMAND_ROLE_POLICY[command];
  return rule.conversationInput === true;
}
