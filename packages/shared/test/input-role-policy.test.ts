// S2 输入准入单源表的契约测试（spec `subagent-session-as-first-class.md` S2）。
// 覆盖：键集穷尽（运行时那一半）、各角色裁决矩阵、`conversationInput` 集合。
import assert from "node:assert/strict";
import test from "node:test";
import { commandPayloadSchemas, type CommandType } from "../src/zcode-protocol-v4/command.js";
import {
  INPUT_COMMAND_ROLE_POLICY,
  isConversationInputCommand,
  resolveInputCommandAdmission,
  type InputCommandDenialReason,
  type SessionRole,
} from "../src/zcode-protocol-v4/input-role-policy.js";

const ALL_COMMANDS = Object.keys(commandPayloadSchemas) as CommandType[];

/** subagent_child 的完整拒绝集（其余一律放行）。 */
const SUBAGENT_CHILD_DENIED: Partial<Record<CommandType, InputCommandDenialReason>> = {
  createSession: "guard.subagentCannotDeriveSession",
  createSelectionSideSession: "guard.subagentCannotDeriveSession",
  forkAssistant: "guard.subagentCannotDeriveSession",
  startSavedWorkflow: "guard.subagentCannotDeriveSession",
  resumeWorkflowRun: "guard.subagentCannotDeriveSession",
  amendWorkflowRunSettings: "guard.subagentCannotDeriveSession",
  switchCollaborationMode: "guard.subagentCannotEscalatePermission",
  sendGoalCommand: "guard.subagentCannotRunGoalLoop",
  resumeGoal: "guard.subagentCannotRunGoalLoop",
  pauseGoal: "guard.subagentCannotRunGoalLoop",
};

/** selection_side_chat 的完整拒绝集（7 条，与改造前逐字一致）。 */
const SIDE_CHAT_DENIED: CommandType[] = [
  "sendGoalCommand",
  "pauseGoal",
  "resumeGoal",
  "editUserQuery",
  "retryTurn",
  "forkAssistant",
  "discardSharedContext",
];

const CONVERSATION_INPUT_COMMANDS: CommandType[] = [
  "sendText",
  "sendGoalCommand",
  "compact",
  "editUserQuery",
  "retryTurn",
];

const OTHER_ROLES: SessionRole[] = [
  "interactive",
  "fork",
  "workflow_parent",
  "workflow_child",
  "nested_workflow_child",
];

function denyMapFor(role: SessionRole): Map<CommandType, string> {
  const denied = new Map<CommandType, string>();
  for (const command of ALL_COMMANDS) {
    const verdict = resolveInputCommandAdmission({ sessionRole: role, command });
    if (!verdict.admitted) denied.set(command, verdict.reasonCode);
  }
  return denied;
}

test("策略表键集与命令全集完全相等（穷尽守卫的运行时那一半）", () => {
  assert.deepEqual(Object.keys(INPUT_COMMAND_ROLE_POLICY).sort(), ALL_COMMANDS.slice().sort());
});

test("subagent_child 的拒绝集与 reasonCode 逐条钉死，其余全部放行", () => {
  const denied = denyMapFor("subagent_child");
  assert.deepEqual(Object.fromEntries(denied), SUBAGENT_CHILD_DENIED);
  for (const command of ALL_COMMANDS) {
    if (command in SUBAGENT_CHILD_DENIED) continue;
    assert.deepEqual(resolveInputCommandAdmission({ sessionRole: "subagent_child", command }), {
      admitted: true,
    });
  }
});

test("selection_side_chat 只拒既有 7 条，其余全部放行", () => {
  const denied = denyMapFor("selection_side_chat");
  assert.deepEqual([...denied.keys()].sort(), SIDE_CHAT_DENIED.slice().sort());
  for (const reasonCode of denied.values()) {
    assert.equal(reasonCode, "guard.selectionSideChatRestrictedCommand");
  }
  for (const command of ALL_COMMANDS) {
    if (SIDE_CHAT_DENIED.includes(command)) continue;
    assert.deepEqual(
      resolveInputCommandAdmission({ sessionRole: "selection_side_chat", command }),
      {
        admitted: true,
      },
    );
  }
});

test("其余 5 类角色对全部命令放行", () => {
  for (const role of OTHER_ROLES) {
    assert.deepEqual(denyMapFor(role), new Map<CommandType, string>(), `role=${role}`);
  }
});

test("sessionRole 为 undefined 时一律放行（未知会话交下游 requireRecord 拒绝）", () => {
  for (const command of ALL_COMMANDS) {
    assert.deepEqual(resolveInputCommandAdmission({ sessionRole: undefined, command }), {
      admitted: true,
    });
  }
});

test("conversationInput 恰为 5 条输入类命令", () => {
  const marked = ALL_COMMANDS.filter((command) => isConversationInputCommand(command));
  assert.deepEqual(marked.slice().sort(), CONVERSATION_INPUT_COMMANDS.slice().sort());
});
