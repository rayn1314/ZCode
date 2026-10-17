// @vitest-environment jsdom
// 回归：Gen UI 远端身份兜底的 selector 必须返回稳定引用。
// zustand v5 直接把 selector 结果当 useSyncExternalStore 的 getSnapshot，返回新对象会
// 让快照恒变、组件无限重渲染（React #185 Maximum update depth exceeded）。
import { act, cleanup, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { useGenUiRemoteIdentity } from "@/hooks/useGenUiRemoteIdentity.js";
import { TabStoreProvider, useTabStoreApi } from "@/store/TabStoreProvider.js";
import type { TabStore } from "@/store/tabStore.js";

let store: TabStore | null = null;
let renders = 0;

// testing-library 的自动 cleanup 依赖全局 afterEach，这里显式前置清理，
// 否则上一个用例的 DOM 会被 getByTestId 一起命中（Found multiple elements）。
beforeEach(() => {
  cleanup();
  store = null;
  renders = 0;
});

function StoreProbe() {
  store = useTabStoreApi();
  return null;
}

function IdentityProbe({ workspacePath }: { workspacePath: string }) {
  const identity = useGenUiRemoteIdentity({ workspacePath });
  renders += 1;
  return <span data-testid="identity">{identity?.remoteSessionId ?? "none"}</span>;
}

function setup(workspacePath = "/w") {
  store = null;
  renders = 0;
  render(
    <TabStoreProvider>
      <StoreProbe />
      <IdentityProbe workspacePath={workspacePath} />
    </TabStoreProvider>,
  );
  return store as TabStore;
}

describe("useGenUiRemoteIdentity", () => {
  it("keeps a stable selector result instead of looping on every render", () => {
    const api = setup();
    expect(renders).toBe(1);
    expect(screen.getByTestId("identity").textContent).toBe("none");
    expect(api.getState().tabs).toHaveLength(0);
  });

  it("borrows remote identity from the workspace tab with the same path", () => {
    const api = setup();
    act(() => {
      api
        .getState()
        .addTab("/w", { remoteSessionId: "sess-remote", workspaceIdentity: "ssh://host/w" });
    });
    expect(screen.getByTestId("identity").textContent).toBe("sess-remote");
    // 上限而非精确值：钉住「不无限重渲染」这一契约，不锁死 React 的批处理细节。
    expect(renders).toBeLessThanOrEqual(4);
  });

  it("does not rerender when an unrelated tab update leaves the identity equal", () => {
    const api = setup();
    act(() => {
      api.getState().addTab("/w", { remoteSessionId: "sess-remote" });
    });
    const afterIdentityChange = renders;
    act(() => {
      api.getState().toggleWorkspaceExpanded("/w");
    });
    expect(renders).toBe(afterIdentityChange);
  });

  it("prefers the target identity carried by the card itself", () => {
    store = null;
    renders = 0;
    function TargetProbe() {
      const identity = useGenUiRemoteIdentity({
        workspacePath: "/w",
        remoteSessionId: "sess-inline",
        workspaceIdentity: "ssh://host/inline",
      });
      renders += 1;
      return <span data-testid="identity">{identity?.remoteSessionId ?? "none"}</span>;
    }
    render(
      <TabStoreProvider>
        <TargetProbe />
      </TabStoreProvider>,
    );
    expect(screen.getByTestId("identity").textContent).toBe("sess-inline");
    expect(renders).toBeLessThanOrEqual(4);
  });
});
