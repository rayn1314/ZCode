// @vitest-environment jsdom
// 回归（spec gen-ui-cross-host-render.md 问题二补记）：渲染失败报告必须打到**承载会话的
// 运行时**（远端会话 = 执行端 zcode-agent）。走本机 base services 时，本机 CLI 里没有该
// 会话，报告被判 session_not_found 静默丢弃——实测本机库有 37 条注入、WSL 库 0 条。
//
// 用 createElement 而不是 JSX：根 vitest 的 include 只收 `packages/*/test/**/*.test.ts`，
// `.test.tsx` 不进默认门禁（同目录既有 tsx 用例是手动定向跑的）。
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GEN_UI_FRAGMENT_REQUIRED_MESSAGE } from "@zcode/shared/gen-ui";
import { GenUiCard } from "../src/gen-ui/components/GenUiCard.js";

const fixture = vi.hoisted(() => {
  const failureText = `Gen UI requires an HTML fragment: it is a full HTML document (34 bytes, content sha256:0f1e2d3c4b5a6978)`;
  // getSnapshot 必须返回稳定引用，否则 useSyncExternalStore 判定快照恒变（React #185）。
  const snapshot = {
    phase: "error" as const,
    height: 240,
    error: failureText,
    tweak: null,
    groups: [],
    tweakValues: {},
    previewOriginal: false,
    hovered: false,
    escapeSequence: 0,
  };
  return {
    failureText,
    page: {
      subscribe: () => () => {},
      getSnapshot: () => snapshot,
      bind: () => () => {},
      preview: () => {},
      focus: () => {},
      copyImage: async () => {},
      setTweaks: () => {},
      previewTweaks: () => {},
      submitTweaks: async () => {},
      isBusy: () => false,
      dispose: async () => {},
    },
    reportRenderFailure: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("@/i18n/IntlProvider.js", () => ({
  useZCodeIntl: () => ({ intl: { formatMessage: ({ id }: { id: string }) => id } }),
}));

vi.mock("@/hooks/useGenUi.js", () => ({
  useGenUi: () => ({
    page: fixture.page,
    error: undefined,
    supported: true,
    online: true,
    report: {
      agentService: { genUiReportRenderFailure: fixture.reportRenderFailure },
      remoteSessionId: "sess_remote-1",
      workspaceIdentity: "wsl:Ubuntu:rayn",
    },
  }),
}));

const reference = { path: "/home/rayn/data/v2/visualizations/hash/chart.html" };

describe("GenUiCard render failure report", () => {
  beforeEach(() => {
    cleanup();
    fixture.reportRenderFailure.mockClear();
  });
  afterEach(() => cleanup());

  it("reports through the session runtime with kind, detail and remote identity", () => {
    // fixture 里的文案是字面量（vi.hoisted 早于 import 求值），必须先确认它与读端常量一致。
    expect(fixture.failureText.startsWith(GEN_UI_FRAGMENT_REQUIRED_MESSAGE)).toBe(true);
    render(
      createElement(GenUiCard, {
        target: {
          workspacePath: "/home/rayn/project",
          workspaceIdentity: "wsl:Ubuntu:rayn",
          sessionId: "sess_1",
          remoteSessionId: "sess_remote-1",
          instanceKey: "card-1",
          path: reference.path,
        },
        reference,
      }),
    );
    expect(fixture.reportRenderFailure).toHaveBeenCalledTimes(1);
    expect(fixture.reportRenderFailure.mock.calls[0]?.[0]).toMatchObject({
      sessionId: "sess_1",
      path: reference.path,
      errorKind: "invalid_fragment",
      remoteSessionId: "sess_remote-1",
      workspaceIdentity: "wsl:Ubuntu:rayn",
      detail: fixture.failureText,
    });
  });
});
