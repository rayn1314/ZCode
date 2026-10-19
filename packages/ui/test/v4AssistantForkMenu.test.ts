import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { TID_V4_FORK, TID_V4_FORK_BY_TURN, TID_V4_FORK_CURRENT_CONTEXT } from "@zcode/shared";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ConversationAssistantTextActions } from "@/v4/ConversationRowView.js";
import type { ConversationForkMode } from "@/v4/conversationRowContext.js";

// Radix 菜单在 SSR 只渲染触发器（Content 走 portal、打开才有），这里直接换成可断言的静态结构，
// 让「什么时候弹菜单、菜单里是哪两条、点了谁」这三件事不依赖 DOM 事件模拟。
const menuState = vi.hoisted(() => ({
  items: [] as Array<{
    testId?: string;
    disabled?: boolean;
    onSelect?: () => void;
  }>,
  /** 触发器上的悬停提示（不可点时的原因写在这里）。 */
  tooltips: [] as Array<unknown>,
}));

vi.mock("@/components/ui/dropdown-menu.js", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => createElement("div", null, children),
  DropdownMenuContent: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
  DropdownMenuItem: ({
    children,
    onSelect,
    disabled,
    "data-testid": testId,
  }: {
    children: ReactNode;
    onSelect?: () => void;
    disabled?: boolean;
    "data-testid"?: string;
  }) => {
    menuState.items.push({ testId, disabled, onSelect });
    return createElement("div", { "data-testid": testId }, children);
  },
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) =>
    createElement("div", null, children),
}));

vi.mock("@/ControlHintTooltip.js", () => ({
  ControlHintTooltip: ({ children, title }: { children: ReactNode; title: unknown }) => {
    menuState.tooltips.push(title);
    return createElement("div", null, children);
  },
}));

function renderActions(params: {
  forkCurrentContext?: boolean;
  forkDisabledReason?: string;
  onFork?: (target: { rowId: number; entityId: string }, mode: ConversationForkMode) => void;
}): string {
  menuState.items = [];
  menuState.tooltips = [];
  return renderToStaticMarkup(
    createElement(
      ZCodeIntlProvider,
      { initialLocale: "zh-CN" },
      createElement(ConversationAssistantTextActions, {
        rowId: 9,
        entityId: "assistant-entity-9",
        text: "answer",
        createdAt: 1,
        sessionId: "session-1",
        onFork: params.onFork,
        forkCurrentContext: params.forkCurrentContext ?? false,
        forkDisabledReason: params.forkDisabledReason,
      }),
    ),
  );
}

describe("v4 消息行的分叉入口", () => {
  it("没有压缩边界时保持单按钮，直接按轮回溯", () => {
    const onFork = vi.fn();
    const html = renderActions({ onFork });

    expect(menuState.items).toHaveLength(0);
    expect(html).toContain(`data-testid="${TID_V4_FORK}-9"`);
    expect(html).not.toContain(TID_V4_FORK_CURRENT_CONTEXT);
  });

  it("活动上下文起点是压缩边界时改为二级菜单，两条给出不同复制口径", () => {
    const html = renderActions({ forkCurrentContext: true, onFork: vi.fn() });

    // 触发器仍然只有行级分叉那一个按钮（同一位置、同一图标），菜单是点开之后的第二级。
    expect(html).toContain(`data-testid="${TID_V4_FORK}-9"`);
    expect(menuState.items.map((item) => item.testId)).toEqual([
      `${TID_V4_FORK_CURRENT_CONTEXT}-9`,
      `${TID_V4_FORK_BY_TURN}-9`,
    ]);
    expect(html).toContain("以当前状态分叉");
    expect(html).toContain("从这一轮完整回溯分叉");
    // 可点态把提示挂在真实触发器上；用 span 兜住 hover 只属于禁用态。
    expect(html).not.toContain("data-disabled-tooltip-trigger");
  });

  it("菜单两条各自带自己的复制口径，且都带上当前行", () => {
    const onFork = vi.fn();
    renderActions({ forkCurrentContext: true, onFork });

    for (const item of menuState.items) item.onSelect?.();

    expect(onFork.mock.calls).toEqual([
      [{ rowId: 9, entityId: "assistant-entity-9" }, "currentContext"],
      [{ rowId: 9, entityId: "assistant-entity-9" }, "row"],
    ]);
  });

  it("会话级闸门拒绝时两条都停在原地不可点（不是忽隐忽现）", () => {
    const onFork = vi.fn();
    const html = renderActions({
      forkCurrentContext: true,
      forkDisabledReason: "压缩进行中，暂不能分叉",
      onFork,
    });

    expect(menuState.items.map((item) => item.disabled)).toEqual([true, true]);
    expect(menuState.tooltips).toContain("压缩进行中，暂不能分叉");
    // disabled 的 Button 带 pointer-events-none，提示只能靠外层 span 承接 hover，
    // 否则「为什么不能分叉」永远弹不出来。
    expect(html).toContain('data-disabled-tooltip-trigger="true"');
  });

  it("只有按轮回溯这一条路时（无压缩），闸门拒绝同样禁用该按钮", () => {
    const html = renderActions({ forkDisabledReason: "压缩进行中，暂不能分叉", onFork: vi.fn() });

    expect(menuState.items).toHaveLength(0);
    expect(html).toContain(`data-testid="${TID_V4_FORK}-9"`);
    expect(html).toContain("disabled");
    expect(menuState.tooltips).toContain("压缩进行中，暂不能分叉");
    expect(html).toContain('data-disabled-tooltip-trigger="true"');
  });
});
