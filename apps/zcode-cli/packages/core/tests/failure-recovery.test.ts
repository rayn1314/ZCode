import { CoreErrorType, createCoreError, ModelFailureReason } from "@zcode/contracts";
import { describe, expect, it } from "vitest";
import {
  classifySubagentFailure,
  formatSubagentFailureGuidance,
} from "../src/subagent/failure-recovery.js";

/**
 * 这些用例钉住的是「父代理能不能自己判断要不要续跑」：分类必须来自 adapter 写在错误链
 * 里的既有事实（reason / retryable / statusCode），不能靠猜（spec
 * `core/spec/subagent-continuation-copy.md` D3/D4）。
 */
function modelFailure(context: Record<string, unknown>, message = "Model request failed.") {
  return createCoreError(CoreErrorType.ModelError, message, { context, recoverable: true });
}

describe("classifySubagentFailure", () => {
  it("treats adapter-retryable failures as transient regardless of reason name", () => {
    expect(
      classifySubagentFailure(
        modelFailure({ reason: ModelFailureReason.ServerError, retryable: true, statusCode: 503 }),
      ),
    ).toEqual({ kind: "transient", reason: "server_error", retryable: true, statusCode: 503 });
    expect(
      classifySubagentFailure(
        modelFailure({ reason: ModelFailureReason.RateLimited, retryable: true }),
      ).kind,
    ).toBe("transient");
    // 未知 reason 但 adapter 说可重试：按瞬时故障处理，不让父代理自己猜。
    expect(
      classifySubagentFailure(modelFailure({ reason: "vendor_specific_thing", retryable: true }))
        .kind,
    ).toBe("transient");
  });

  it("separates configuration failures that a resume cannot heal", () => {
    for (const reason of [
      ModelFailureReason.AuthFailed,
      ModelFailureReason.ProviderNotConfigured,
      ModelFailureReason.InvalidRequest,
      ModelFailureReason.ContextExceeded,
      ModelFailureReason.TlsError,
    ]) {
      expect(classifySubagentFailure(modelFailure({ reason, retryable: false })).kind).toBe(
        "configuration",
      );
    }
  });

  it("keeps cancellation distinct from failure", () => {
    expect(
      classifySubagentFailure(modelFailure({ reason: ModelFailureReason.Cancelled })).kind,
    ).toBe("cancelled");
  });

  it("falls back to unknown instead of inventing a cause", () => {
    expect(classifySubagentFailure(modelFailure({})).kind).toBe("unknown");
    expect(classifySubagentFailure(new Error("boom")).kind).toBe("unknown");
  });

  it("reads the classification through a wrapper cause chain", () => {
    // 子代理前台失败会被包一层生命周期 wrapper，真实分类在 cause 上——这是运行时
    // 的实际形态，不是测试虚构。
    const root = modelFailure({ reason: ModelFailureReason.ServerError, retryable: true });
    const wrapper = createCoreError(CoreErrorType.ToolExecutionFailed, "Explore subagent failed", {
      cause: root,
      context: { code: "CHILD_RUNTIME_FAILED" },
      recoverable: true,
    });
    expect(classifySubagentFailure(wrapper)).toMatchObject({
      kind: "transient",
      reason: "server_error",
      retryable: true,
    });
  });
});

describe("formatSubagentFailureGuidance", () => {
  it("names the failure kind, states the work is preserved, and gives the agentId to resume", () => {
    const text = formatSubagentFailureGuidance(
      { kind: "transient", reason: "server_error", retryable: true, statusCode: 503 },
      "agent_abc",
    );
    expect(text).toContain(
      "Failure kind: transient provider error (server_error, retryable, HTTP 503)",
    );
    expect(text).toContain("did not fail");
    expect(text).toContain("preserved");
    expect(text).toContain("SendMessage with to: 'agent_abc'");
    expect(text).toContain("instead of dispatching a new agent");
  });

  it("tells the parent not to resume a configuration failure", () => {
    const text = formatSubagentFailureGuidance(
      { kind: "configuration", reason: "auth_failed", retryable: false },
      "agent_abc",
    );
    expect(text).toContain("Failure kind: configuration error");
    expect(text).toContain("will hit the same error");
    expect(text).toContain("Do not dispatch a new agent");
  });

  it("does not push a resume when the agent was cancelled", () => {
    const text = formatSubagentFailureGuidance(
      { kind: "cancelled", reason: "cancelled" },
      "agent_abc",
    );
    expect(text).toContain("Failure kind: cancelled");
    expect(text).toContain("resume it with SendMessage with to: 'agent_abc'");
  });

  it("admits when it cannot classify", () => {
    const text = formatSubagentFailureGuidance({ kind: "unknown" }, "agent_abc");
    expect(text).toContain("Failure kind: unclassified");
    expect(text).toContain("If this looks like it interrupted work");
  });
});
