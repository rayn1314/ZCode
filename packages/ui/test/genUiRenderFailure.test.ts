import { describe, expect, it } from "vitest";
import { GEN_UI_FRAGMENT_REQUIRED_MESSAGE } from "@zcode/shared/gen-ui";
import {
  buildGenUiRenderFailureDetail,
  buildGenUiRenderFailureKey,
  classifyGenUiRenderFailure,
} from "../src/gen-ui/domain/renderFailure.js";

describe("classifyGenUiRenderFailure", () => {
  it("files.ts 越界文案归为 outside_root", () => {
    expect(classifyGenUiRenderFailure("Gen UI file is outside the host output directory")).toBe(
      "outside_root",
    );
    expect(classifyGenUiRenderFailure("Gen UI file escaped the output directory")).toBe(
      "outside_root",
    );
    expect(classifyGenUiRenderFailure("Gen UI does not read symbolic links")).toBe("outside_root");
  });

  it("非绝对路径形态归为 invalid_path", () => {
    expect(classifyGenUiRenderFailure("Invalid executor path")).toBe("invalid_path");
  });

  it("sandbox mismatch 归为 sandbox_mismatch", () => {
    expect(classifyGenUiRenderFailure("sandbox mismatch: hash differs")).toBe("sandbox_mismatch");
  });

  it("文件不存在归为 not_found", () => {
    expect(classifyGenUiRenderFailure("ENOENT: no such file or directory, open '/x.html'")).toBe(
      "not_found",
    );
  });

  it("完整 HTML 文档归为 invalid_fragment", () => {
    expect(
      classifyGenUiRenderFailure(
        `${GEN_UI_FRAGMENT_REQUIRED_MESSAGE}: it is a full HTML document (34 bytes, content sha256:0f1e2d3c4b5a6978)`,
      ),
    ).toBe("invalid_fragment");
  });

  it("未知错误归为 other", () => {
    expect(classifyGenUiRenderFailure("boom")).toBe("other");
    expect(classifyGenUiRenderFailure("")).toBe("other");
  });

  it("详情折成一行并按上限截断，空文本不上报", () => {
    expect(buildGenUiRenderFailureDetail("a\n\tb   c")).toBe("a b c");
    expect(buildGenUiRenderFailureDetail("   ")).toBeUndefined();
    expect(buildGenUiRenderFailureDetail("\u0000")).toBeUndefined();
    const long = buildGenUiRenderFailureDetail("x".repeat(1000));
    expect(long).toHaveLength(400);
    expect(long?.endsWith("…")).toBe(true);
  });

  it("去重键以 sessionId+path+errorKind+detail 构成，详情变化即视为新失败", () => {
    const a = buildGenUiRenderFailureKey({
      sessionId: "sess_1",
      path: "/x/y.html",
      errorKind: "outside_root",
    });
    const b = buildGenUiRenderFailureKey({
      sessionId: "sess_1",
      path: "/x/y.html",
      errorKind: "invalid_path",
    });
    expect(a).not.toBe(b);
    expect(
      buildGenUiRenderFailureKey({
        sessionId: "sess_2",
        path: "/x/y.html",
        errorKind: "outside_root",
      }),
    ).not.toBe(a);
    // 同一份内容（详情相同）维持去重；模型改写文件后指纹变 → 允许再报一次。
    const content = `${GEN_UI_FRAGMENT_REQUIRED_MESSAGE}: it is a full HTML document (10 bytes, content sha256:aaaa)`;
    const rewritten = `${GEN_UI_FRAGMENT_REQUIRED_MESSAGE}: it is a full HTML document (12 bytes, content sha256:bbbb)`;
    const same = (detail: string) =>
      buildGenUiRenderFailureKey({
        sessionId: "sess_1",
        path: "/x/y.html",
        errorKind: "invalid_fragment",
        detail,
      });
    expect(same(content)).toBe(same(content));
    expect(same(rewritten)).not.toBe(same(content));
  });
});
