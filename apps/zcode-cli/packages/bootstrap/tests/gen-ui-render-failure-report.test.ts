// Gen UI 渲染失败报告（spec gen-ui-cross-host-render.md 验收 A4/A6）：
// 防环三闸（同键终身一次 / 每会话 5 次封顶 / 注入后不再投递）与端点不可用兜底。
import { describe, expect, it, vi } from "vitest";
import {
  GEN_UI_RENDER_FAILURE_MAX_INJECTIONS,
  reportGenUiRenderFailure,
} from "../src/zcode-protocol/server-operations.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

function setup() {
  const enqueue = vi.fn();
  const sessions = new Map<string, unknown>([
    [
      "sess-1",
      {
        traceContext: { traceId: "trace-1" },
        app: { runtime: { enqueueBackgroundTaskNotification: enqueue } },
      },
    ],
  ]);
  const context = { sessions } as unknown as ZCodeProtocolAgentServerContext;
  return { context, enqueue };
}

const params = (path: string, errorKind: string, sessionId = "sess-1") => ({
  sessionId,
  path,
  errorKind,
});

describe("gen-ui render failure report", () => {
  it("injects one model-only notification for a fresh failure", async () => {
    const { context, enqueue } = setup();
    const result = await reportGenUiRenderFailure(context, params("/home/rayn/x.html", "outside_root"));
    expect(result).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledExactlyOnceWith({
      text: expect.stringContaining("/home/rayn/x.html"),
      traceContext: { traceId: "trace-1" },
    });
    expect(enqueue.mock.calls[0][0].text).toContain("可视化渲染失败");
  });

  it("rejects a session that is not resident", async () => {
    const { context, enqueue } = setup();
    const result = await reportGenUiRenderFailure(
      context,
      params("/gone.html", "outside_root", "sess-missing"),
    );
    expect(result).toEqual({ ok: false, reason: "session_not_found" });
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("deduplicates the same session+path+errorKind for the lifetime of the process", async () => {
    const { context, enqueue } = setup();
    const first = await reportGenUiRenderFailure(context, params("/x.html", "outside_root"));
    const second = await reportGenUiRenderFailure(context, params("/x.html", "outside_root"));
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "duplicate" });
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it("treats a different errorKind for the same path as a new key", async () => {
    const { context, enqueue } = setup();
    await reportGenUiRenderFailure(context, params("/x.html", "outside_root"));
    const result = await reportGenUiRenderFailure(context, params("/x.html", "invalid_path"));
    expect(result).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it(`caps injections at ${GEN_UI_RENDER_FAILURE_MAX_INJECTIONS} per session`, async () => {
    const { context, enqueue } = setup();
    const kinds = ["outside_root", "invalid_path", "not_found", "sandbox_mismatch", "other"];
    for (let i = 0; i < kinds.length; i += 1) {
      const result = await reportGenUiRenderFailure(context, params(`/f${i}.html`, kinds[i]!));
      expect(result).toEqual({ ok: true });
    }
    const capped = await reportGenUiRenderFailure(context, params("/f5.html", "outside_root"));
    expect(capped).toEqual({ ok: false, reason: "injection_cap_reached" });
    expect(enqueue).toHaveBeenCalledTimes(GEN_UI_RENDER_FAILURE_MAX_INJECTIONS);
  });
});
