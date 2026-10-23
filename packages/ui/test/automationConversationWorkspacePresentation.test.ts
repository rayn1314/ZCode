import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../src/settings/AutomationEditView.tsx", import.meta.url),
  "utf8",
);

describe("AutomationEditView 无项目会话展示契约", () => {
  it("保留 conversation 语义并复用会话侧固定菜单项", () => {
    // 上游把项目选择收敛为 projectId/hostId 的 AutomationWorkspaceOption +
    // resolveAutomationWorkspaceSelectionKey；本 fork 的 conversation 语义随 workspacePurpose 保留。
    expect(source).toContain(
      'selectedWorkspace?.projectId === null || selectedWorkspace?.workspacePurpose === "conversation"',
    );
    expect(source).toContain("isSelectedConversationWorkspace");
    expect(source).toContain("resolveAutomationWorkspaceSelectionKey");
    expect(source).toContain('data-testid="automation-project-select"');
  });
});
