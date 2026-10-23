import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  TID_V4_DELETE_SESSION,
  TID_V4_FORK_CURRENT_CONTEXT,
  TID_V4_PANE_WORKSPACE_BADGE,
  TID_V4_SPLIT_CLOSE,
  TID_V4_SPLIT_DOWN,
  TID_V4_SPLIT_OPEN,
} from "@zcode/shared/test-ids";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationHeader } from "@/v4/ConversationHeader.js";

function renderHeader(overrides: Record<string, unknown> = {}): string {
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationHeader, {
        title: "这是个啥项目",
        onClosePane: vi.fn(),
        workspaceBadge: {
          label: "workspace",
          workspacePath: "/tmp/workspace",
          remote: false,
        },
        ...overrides,
      }),
    ),
  );
}

describe("ConversationHeader pane chrome", () => {
  it("renders no split controls while keeping the other floating pane actions", () => {
    const html = renderHeader();

    expect(html).toContain('data-v4-pane-actions="floating"');
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_OPEN}"`);
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_DOWN}"`);
    expect(html).toContain(`data-testid="${TID_V4_SPLIT_CLOSE}"`);
    expect(html).toContain(`data-testid="${TID_V4_PANE_WORKSPACE_BADGE}"`);
  });

  it("does not render an empty floating action group without pane actions", () => {
    const html = renderHeader({ workspaceBadge: undefined, onClosePane: undefined });

    expect(html).not.toContain('data-v4-pane-actions="floating"');
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_OPEN}"`);
    expect(html).not.toContain(`data-testid="${TID_V4_SPLIT_DOWN}"`);
  });
});

describe("ConversationHeader 不再承载分叉入口", () => {
  it("pane chrome 里没有分叉按钮（入口已并入消息行 hover 工具栏）", () => {
    // 传入旧的分叉 props 也不该再渲染出任何入口：pane chrome 只留 workspace 徽标与关闭。
    const html = renderHeader({
      onForkCurrentContext: vi.fn(),
      forkCurrentContextDisabled: true,
      forkCurrentContextDisabledReason: "压缩进行中，暂不能以当前状态分叉",
    });

    expect(html).not.toContain(`data-testid="${TID_V4_FORK_CURRENT_CONTEXT}"`);
    expect(html).not.toContain("以当前状态分叉");
  });
});
