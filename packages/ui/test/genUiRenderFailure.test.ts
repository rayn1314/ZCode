import { describe, expect, it } from "vitest";
import {
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

  it("未知错误归为 other", () => {
    expect(classifyGenUiRenderFailure("boom")).toBe("other");
    expect(classifyGenUiRenderFailure("")).toBe("other");
  });

  it("去重键以 sessionId+path+errorKind 三元组构成", () => {
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
  });
});
