import { describe, expect, it, vi } from "vitest";
import { createHostRemoteWorkspaceProxyState } from "../src/host/hostRemoteWorkspaceProxyState.js";

describe("createHostRemoteWorkspaceProxyState", () => {
  it("disposes workspace-owned proxy state and allows the workspace to subscribe again", () => {
    // 背景：workspace 级 ensureWorkspaceSubscription 已随「移除 Host 侧基于 workspace 事件的
    // 旧上报链路」删除（提交 8d4fe3b8），workspace 归属的资源现由 trackTaskReady 按 task 承接。
    // 用例保留原契约：clearWorkspace 只清理本 workspace 的订阅与 meta、跨 workspace 不受影响，
    // 且清理后同一 workspace 仍可再次订阅。
    const state = createHostRemoteWorkspaceProxyState();
    const workspaceA = {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:a",
    };
    const workspaceB = {
      workspacePath: "/work/b",
      workspaceIdentity: "remote:wsl:b",
    };
    const workspaceBDispose = vi.fn();
    const readyADispose = vi.fn();

    state.rememberTaskMeta({ taskId: "task-a", traceId: "trace-a", ...workspaceA });
    state.rememberTaskMeta({ taskId: "task-b", traceId: "trace-b", ...workspaceB });
    state.trackTaskReady("task-a", workspaceA, () => ({ dispose: readyADispose }), vi.fn());
    state.trackTaskReady("task-b", workspaceB, () => ({ dispose: workspaceBDispose }), vi.fn());

    state.clearWorkspace(workspaceA);

    expect(state.getTaskMeta("task-a")).toBeUndefined();
    expect(state.getTaskMeta("task-b")?.taskId).toBe("task-b");
    expect(readyADispose).toHaveBeenCalledOnce();
    expect(workspaceBDispose).not.toHaveBeenCalled();

    const readyAgainDispose = vi.fn();
    state.trackTaskReady("task-a", workspaceA, () => ({ dispose: readyAgainDispose }), vi.fn());
    expect(workspaceBDispose).not.toHaveBeenCalled();

    state.clearWorkspace(workspaceA);
    expect(readyAgainDispose).toHaveBeenCalledOnce();
    expect(workspaceBDispose).not.toHaveBeenCalled();
  });

  it("disposes a ready subscription when ready fires synchronously during registration", () => {
    const state = createHostRemoteWorkspaceProxyState();
    const context = {
      workspacePath: "/work/a",
      workspaceIdentity: "remote:wsl:a",
    };
    const dispose = vi.fn();
    const onReady = vi.fn();

    state.trackTaskReady(
      "task-a",
      context,
      (listener) => {
        listener();
        return { dispose };
      },
      onReady,
    );

    expect(onReady).toHaveBeenCalledOnce();
    expect(dispose).toHaveBeenCalledOnce();
    state.clearWorkspace(context);
    expect(dispose).toHaveBeenCalledOnce();
  });
});
