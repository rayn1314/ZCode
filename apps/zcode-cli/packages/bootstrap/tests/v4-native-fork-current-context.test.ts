// forkCurrentContext 的 L2 契约：会话级「以当前状态分叉」。
// 与 forkAssistant 的关键差别：不带 row target，因此不经过任何锚点解析能力；
// 复制口径（当前模型可见上下文 / 最后一个 compact boundary）整体由 core 决定。
import { describe, expect, it, vi } from "vitest";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import { V4CommandExecutor } from "../src/zcode-protocol-v4/commands/executor.js";
import type {
  V4CommandCoreHost,
  V4SessionRecordView,
} from "../src/zcode-protocol-v4/commands/types.js";

function makeRecord(): V4SessionRecordView {
  return {
    app: { sessionId: "s1" } as unknown as V4SessionRecordView["app"],
    traceContext: { traceId: "trace-1", sessionId: "s1" } as never,
    workspace: { workspacePath: "/w" },
    persistence: "immediate",
  } as V4SessionRecordView;
}

function makeHost(
  record: V4SessionRecordView,
  overrides: Partial<V4CommandCoreHost> = {},
): V4CommandCoreHost {
  return {
    getRecord: (id) => (id === "s1" ? record : undefined),
    ...overrides,
  };
}

function envelope(type: string, payload: unknown): CommandEnvelope {
  return {
    type,
    payload,
    sessionId: "s1",
    commandId: "cmd-1",
    baseRevision: 0,
    baseLogEpoch: "epoch-1",
    clientId: "client-new",
  } as unknown as CommandEnvelope;
}

describe("v4 原生 forkCurrentContext", () => {
  it("无 row target：直接以当前上下文分叉并把 child 交给 UI", async () => {
    const info = vi.fn();
    const forkCurrentContext = vi.fn().mockResolvedValue({ forkedSessionId: "s-ctx-fork" });
    const host = makeHost(makeRecord(), { forkCurrentContext, logger: { info } });

    const result = await new V4CommandExecutor(host).execute(envelope("forkCurrentContext", {}));

    expect(forkCurrentContext).toHaveBeenCalledWith("s1", {
      sourceCommandId: "cmd-1",
      revisionAtDecision: 0,
    });
    expect(result).toEqual({ type: "forkCurrentContext", sessionId: "s-ctx-fork" });
    expect(info).toHaveBeenCalledWith(
      "v4 forkCurrentContext completed",
      expect.objectContaining({
        childSessionId: "s-ctx-fork",
        commandId: "cmd-1",
        event: "conversation.command.fork_current_context.completed",
        parentSessionId: "s1",
        revisionAtDecision: 0,
        sessionId: "s1",
        status: "completed",
        traceId: "trace-1",
      }),
    );
  });

  it("capability 缺失时报错，不静默成功", async () => {
    const host = makeHost(makeRecord());

    await expect(
      new V4CommandExecutor(host).execute(envelope("forkCurrentContext", {})),
    ).rejects.toThrow("forkCurrentContext");
  });
});
