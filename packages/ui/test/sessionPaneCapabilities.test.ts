// SessionPane 形态能力矩阵契约。
// spec: apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md 的「UI 施工规格（S4）」。
//
// 这张表是"哪个形态能做什么"的单一真相源，所以测试逐格断言 spec 的原表而不是抽查几项：
// 少一格就说明某个能力又被某处的布尔黑名单悄悄关掉了。
import assert from "node:assert/strict";
import test from "node:test";
import { resolveInputRejectionMessageId } from "../src/v4/inputRejectionMessage.js";
import {
  resolveSessionPaneCapabilities,
  type SessionPaneCapabilities,
  type SessionPaneShape,
} from "../src/v4/sessionPaneCapabilities.js";

/** 布尔能力列（顺序与 spec 表格的 13 列一致）。 */
type BooleanCapability = Exclude<keyof SessionPaneCapabilities, "shape" | "workspaceFileRewind">;

const MATRIX: Record<SessionPaneShape, Record<BooleanCapability, boolean>> = {
  // 有 有 有 有 有 有 有 有 有 有 有（文件撤销） 有
  interactive: {
    readOnly: false,
    composer: true,
    dropTarget: true,
    editRetry: true,
    fork: true,
    assistantFeedback: true,
    goalCommands: true,
    goalPanel: true,
    permissionModeSelector: true,
    cancelBackgroundWork: true,
    selectionActions: true,
    selectionSideChatOpener: true,
    runJournalQuery: true,
  },
  // 无 无 无 无 无 无 **有**（goal 展示是只读视图的既有行为） 无 无 无 仅 allowWorkspaceFileRewind 无
  observe: {
    readOnly: true,
    composer: false,
    dropTarget: false,
    editRetry: false,
    fork: false,
    assistantFeedback: false,
    goalCommands: false,
    goalPanel: true,
    permissionModeSelector: false,
    cancelBackgroundWork: false,
    selectionActions: false,
    selectionSideChatOpener: false,
    runJournalQuery: false,
  },
  // 有 有 无 无 无 无 无 有 有 无 无 有
  selectionSideChat: {
    readOnly: false,
    composer: true,
    dropTarget: true,
    editRetry: false,
    fork: false,
    assistantFeedback: false,
    goalCommands: false,
    goalPanel: false,
    permissionModeSelector: true,
    cancelBackgroundWork: true,
    selectionActions: false,
    selectionSideChatOpener: false,
    runJournalQuery: true,
  },
  // 有 有 有 无 无 无 无 无 有 无 无 有
  subagentChild: {
    readOnly: false,
    composer: true,
    dropTarget: true,
    editRetry: true,
    fork: false,
    assistantFeedback: false,
    goalCommands: false,
    goalPanel: false,
    permissionModeSelector: false,
    cancelBackgroundWork: true,
    selectionActions: false,
    selectionSideChatOpener: false,
    runJournalQuery: true,
  },
};

const EXPECTED_FILE_REWIND: Record<
  SessionPaneShape,
  SessionPaneCapabilities["workspaceFileRewind"]
> = {
  interactive: "always",
  observe: "withAllowFlagOnly",
  selectionSideChat: "always",
  subagentChild: "always",
};

for (const shape of Object.keys(MATRIX) as SessionPaneShape[]) {
  test(`形态 ${shape} 的能力面逐格对齐 spec 矩阵`, () => {
    const capabilities = resolveSessionPaneCapabilities(shape);
    assert.equal(capabilities.shape, shape);
    for (const [capability, expected] of Object.entries(MATRIX[shape]) as [
      BooleanCapability,
      boolean,
    ][]) {
      assert.equal(capabilities[capability], expected, `${shape}.${capability}`);
    }
    assert.equal(capabilities.workspaceFileRewind, EXPECTED_FILE_REWIND[shape]);
  });
}

test("子代理子会话：保留 composer 与 edit/retry，去掉 fork / goal / 权限模式选择器", () => {
  const capabilities = resolveSessionPaneCapabilities("subagentChild");
  assert.equal(capabilities.composer, true);
  assert.equal(capabilities.editRetry, true);
  assert.equal(capabilities.fork, false);
  assert.equal(capabilities.goalCommands, false);
  assert.equal(capabilities.goalPanel, false);
  assert.equal(capabilities.permissionModeSelector, false);
});

test("框选副屏：保留 composer 与权限模式选择器，去掉 edit/retry 与 fork", () => {
  const capabilities = resolveSessionPaneCapabilities("selectionSideChat");
  assert.equal(capabilities.composer, true);
  assert.equal(capabilities.permissionModeSelector, true);
  assert.equal(capabilities.editRetry, false);
  assert.equal(capabilities.fork, false);
});

test("观察形态：文件撤销只走 allowWorkspaceFileRewind 例外，其余能力全关（goal 展示除外）", () => {
  const capabilities = resolveSessionPaneCapabilities("observe");
  assert.equal(capabilities.readOnly, true);
  assert.equal(capabilities.composer, false);
  assert.equal(capabilities.workspaceFileRewind, "withAllowFlagOnly");
  // 改造前 observe 就展示 goal 进度（只有 pause/resume 被 readOnly 挡住）；形态化不能把
  // 展示一起关掉——那是信息量退化。所以展示与命令必须是两项能力。
  assert.equal(capabilities.goalPanel, true);
  assert.equal(capabilities.goalCommands, false);
});

test("受限模式原因码映射：受限子会话有专属文案，其余落通用文案", () => {
  assert.equal(
    resolveInputRejectionMessageId("guard.subagentLimitedMode"),
    "subagents.pane.limitedMode",
  );
  assert.equal(resolveInputRejectionMessageId(undefined), "subagents.pane.inputRejected");
  // 未知码不能什么都不显示，也不能当成"暂无原因"：兜底是通用文案。
  assert.equal(
    resolveInputRejectionMessageId("guard.somethingNew"),
    "subagents.pane.inputRejected",
  );
});
