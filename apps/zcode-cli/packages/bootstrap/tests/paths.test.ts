import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";
import { getModelIoDir, getProjectMemoryRoot } from "../src/app/paths.js";

describe("getProjectMemoryRoot", () => {
  it("keys memory by the canonical workspace path", () => {
    const first = getProjectMemoryRoot("/tmp/zcode-cli", "/workspace/first");
    const second = getProjectMemoryRoot("/tmp/zcode-cli", "/workspace/first");
    const other = getProjectMemoryRoot("/tmp/zcode-cli", "/workspace/second");

    // 分隔符随平台（Windows 上 resolve 会产出反斜杠），期望值用 join 拼，不能写死 posix 字面量。
    expect(first).toMatch(/[\\/]memories[\\/]projects[\\/]first-[a-f0-9]{16}[\\/]memory$/);
    expect(second).toBe(first);
    expect(other).not.toBe(first);
  });

  it("normalizes relative and absolute workspace paths", () => {
    const relativeRoot = getProjectMemoryRoot("/tmp/zcode-cli", ".");
    const absoluteRoot = getProjectMemoryRoot("/tmp/zcode-cli", resolve("."));

    expect(relativeRoot).toBe(absoluteRoot);
    expect(relativeRoot).toMatch(/[\\/]memories[\\/]projects[\\/].+[\\/]memory$/);
  });
});

describe("getModelIoDir", () => {
  it("derives debug and rollout from the configured CLI storage root", () => {
    expect(getModelIoDir("/custom/storage/cli", true)).toBe(
      join("/custom/storage/cli", "debug"),
    );
    expect(getModelIoDir("/custom/storage/cli", false)).toBe(
      join("/custom/storage/cli", "rollout"),
    );
  });
});
