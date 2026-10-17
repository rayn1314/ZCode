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

  it("carries the reader diagnosis and a concrete fix for a whole-document fragment", async () => {
    const { context, enqueue } = setup();
    const result = await reportGenUiRenderFailure(context, {
      ...params("/home/rayn/x.html", "invalid_fragment"),
      detail: "Gen UI requires an HTML fragment: it is a full HTML document (34 bytes, content sha256:aaaa)",
    });
    expect(result).toEqual({ ok: true });
    const text = enqueue.mock.calls[0][0].text;
    expect(text).toContain("HTML 片段");
    expect(text).toContain("读端诊断：Gen UI requires an HTML fragment");
    expect(text).toContain("删除 <!doctype> / <html> / <head> / <body>");
  });

  it("omits the diagnosis line when the report has no detail", async () => {
    const { context, enqueue } = setup();
    await reportGenUiRenderFailure(context, params("/x.html", "outside_root"));
    expect(enqueue.mock.calls[0][0].text).not.toContain("读端诊断");
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

  it("deduplicates the same session+path+errorKind+detail for the lifetime of the process", async () => {
    const { context, enqueue } = setup();
    const detail = "Gen UI requires an HTML fragment: it is a full HTML document (10 bytes)";
    const first = await reportGenUiRenderFailure(context, {
      ...params("/x.html", "invalid_fragment"),
      detail,
    });
    const second = await reportGenUiRenderFailure(context, {
      ...params("/x.html", "invalid_fragment"),
      detail,
    });
    expect(first).toEqual({ ok: true });
    expect(second).toEqual({ ok: false, reason: "duplicate" });
    expect(enqueue).toHaveBeenCalledTimes(1);
    // 模型改写文件后读端指纹变（详情随之变）→ 同一路径的同类失败再提醒一次。
    const rewritten = await reportGenUiRenderFailure(context, {
      ...params("/x.html", "invalid_fragment"),
      detail: "Gen UI requires an HTML fragment: it is a full HTML document (21 bytes)",
    });
    expect(rewritten).toEqual({ ok: true });
    expect(enqueue).toHaveBeenCalledTimes(2);
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
    const kinds = [
      "outside_root",
      "invalid_path",
      "invalid_fragment",
      "not_found",
      "sandbox_mismatch",
      "other",
    ];
    for (let i = 0; i < GEN_UI_RENDER_FAILURE_MAX_INJECTIONS; i += 1) {
      const result = await reportGenUiRenderFailure(context, params(`/f${i}.html`, kinds[i]!));
      expect(result).toEqual({ ok: true });
    }
    const capped = await reportGenUiRenderFailure(
      context,
      params(`/f${GEN_UI_RENDER_FAILURE_MAX_INJECTIONS}.html`, kinds[5]!),
    );
    expect(capped).toEqual({ ok: false, reason: "injection_cap_reached" });
    expect(enqueue).toHaveBeenCalledTimes(GEN_UI_RENDER_FAILURE_MAX_INJECTIONS);
  });
});
