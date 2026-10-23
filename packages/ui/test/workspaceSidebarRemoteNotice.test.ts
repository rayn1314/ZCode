// @vitest-environment jsdom
// 上游 v3.16.2 把 WorkspaceSidebarItem 换成 project-sidebar/ProjectNode(+Content)。
// 旧组件里的 remote notice / SSH 别名 / runtime 释放断言随组件删除；这里保留仍存在的
// fork 行为（折叠 workspace 的聚合未读点）并在新组件上验证。
// 远程连接状态图标、重连日志 tooltip、同步 Skills/MCP 菜单已由上游新测试覆盖：
// - packages/ui/test/projectNodeRemoteIcon.test.ts
// - packages/ui/test/reconnectingRemoteWorkspaceLogs.test.ts
// - packages/ui/test/projectRemoteSync.test.ts / remoteSyncActions.test.ts
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectNode } from "@/project-sidebar/ProjectNode.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));
vi.mock("@/project-sidebar/ProjectTaskRows.js", () => ({ ProjectTaskRows: () => null }));

afterEach(cleanup);

function fixture(overrides: { expanded?: boolean; hasUnread?: boolean } = {}) {
  return {
    project: {
      id: "p",
      hostId: "local",
      name: "Project",
      roots: [{ rootPath: "/repo", position: 0, isPrimary: true }],
      deleted: false,
      pinned: false,
      nameOverridden: false,
      position: 1,
      createdAt: 1,
      updatedAt: 1,
    },
    expanded: overrides.expanded ?? false,
    onExpandedChange: vi.fn(),
    tasks: [],
    hasUnread: overrides.hasUnread ?? false,
    onCreate: vi.fn(),
    onViewFiles: vi.fn(),
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onPin: vi.fn(),
    onMove: vi.fn(),
    onSelect: vi.fn(),
    refresh: vi.fn(async () => {}),
  };
}

describe("ProjectNode 聚合未读提示", () => {
  it("workspace 收起时显示聚合未读点，展开时只保留 task 行提示", () => {
    const collapsed = render(
      createElement(
        TooltipProvider,
        null,
        createElement(ProjectNode, fixture({ expanded: false, hasUnread: true })),
      ),
    );
    expect(
      collapsed.container.querySelector('[data-workspace-unread-indicator="true"]'),
    ).not.toBeNull();
    collapsed.unmount();

    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ProjectNode, fixture({ expanded: true, hasUnread: true })),
      ),
    );
    expect(screen.queryByTestId("virtual-project-unread")).toBeNull();
  });

  it("没有未读时不渲染聚合未读点", () => {
    render(
      createElement(
        TooltipProvider,
        null,
        createElement(ProjectNode, fixture({ expanded: false, hasUnread: false })),
      ),
    );
    expect(screen.queryByTestId("virtual-project-unread")).toBeNull();
  });
});
