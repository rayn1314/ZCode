import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTRUCTION_FILE_MAX_BYTES } from "@zcode/shared";
import { afterEach, describe, expect, it } from "vitest";

import { createInstructionsService } from "./instructionsService.js";

// 契约测试用真实临时目录驱动真实实现（不 mock 文件系统）：
// 钉死的是 spec 一样的不变量——候选顺序与遮蔽、读取上限、写入 CAS 冲突。

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<{
  root: string;
  service: ReturnType<typeof createInstructionsService>;
}> {
  const root = await mkdtemp(join(tmpdir(), "instructions-contract-"));
  directories.push(root);
  // .git 让向上查找停在 root，避免临时目录之外的父目录影响断言。
  await mkdir(join(root, ".git"), { recursive: true });
  return { root, service: createInstructionsService() };
}

describe("instructions 读取语义", () => {
  it("同目录候选按 AGENTS.md 优先，被遮蔽的候选如实报出，落点存在时生效文件即落点", async () => {
    const { root, service } = await fixture();
    const target = join(root, "AGENTS.md");
    const shadowed = join(root, ".zcode", "AGENTS.md");
    await mkdir(join(root, ".zcode"), { recursive: true });
    await writeFile(target, "# 生效文件\n", "utf8");
    await writeFile(shadowed, "# 被遮蔽\n", "utf8");

    const state = await service.readInstructionFile({ workspacePath: root, scope: "workspace" });

    expect(state.targetPath).toBe(target);
    expect(state.effectivePath).toBe(target);
    expect(state.ignoredCandidates).toEqual([shadowed]);
    expect(state.exists).toBe(true);
    expect(state.content).toBe("# 生效文件\n");
    expect(state.truncated).toBe(false);
    expect(state.writable).toBe(true);
  });

  it("本目录无候选时向上查找生效文件，落点仍是本目录（新建不写上级）", async () => {
    const { root, service } = await fixture();
    await writeFile(join(root, "AGENTS.md"), "# 上级\n", "utf8");
    const nested = join(root, "packages", "app");
    await mkdir(nested, { recursive: true });

    const state = await service.readInstructionFile({ workspacePath: nested, scope: "workspace" });

    expect(state.effectivePath).toBe(join(root, "AGENTS.md"));
    expect(state.targetPath).toBe(join(nested, "AGENTS.md"));
    expect(state.exists).toBe(false);
    expect(state.mtimeMs).toBeNull();
    expect(state.content).toBe("");
  });

  it("超过 100KB 的文件标记 truncated，且只回传前 100KB", async () => {
    const { root, service } = await fixture();
    const oversize = `${"a".repeat(INSTRUCTION_FILE_MAX_BYTES)}tail`;
    await writeFile(join(root, "AGENTS.md"), oversize, "utf8");

    const state = await service.readInstructionFile({ workspacePath: root, scope: "workspace" });

    expect(state.bytes).toBe(INSTRUCTION_FILE_MAX_BYTES + 4);
    expect(state.truncated).toBe(true);
    expect(Buffer.byteLength(state.content, "utf8")).toBe(INSTRUCTION_FILE_MAX_BYTES);
  });
});

describe("instructions 写入语义", () => {
  it("基线不一致返回 conflict 且不动磁盘；基线正确才原子替换", async () => {
    const { root, service } = await fixture();
    const target = join(root, "AGENTS.md");
    await writeFile(target, "old", "utf8");
    const before = await service.readInstructionFile({ workspacePath: root, scope: "workspace" });
    const baseMtime = before.mtimeMs;
    expect(baseMtime).not.toBeNull();

    const asCreate = await service.writeInstructionFile({
      workspacePath: root,
      scope: "workspace",
      content: "overwritten",
      expectedMtimeMs: null,
    });
    expect(asCreate).toEqual({ ok: false, reason: "conflict" });

    const stale = await service.writeInstructionFile({
      workspacePath: root,
      scope: "workspace",
      content: "overwritten",
      expectedMtimeMs: (baseMtime ?? 0) - 1,
    });
    expect(stale).toEqual({ ok: false, reason: "conflict" });
    expect(await readFile(target, "utf8")).toBe("old");

    const saved = await service.writeInstructionFile({
      workspacePath: root,
      scope: "workspace",
      content: "new",
      expectedMtimeMs: baseMtime,
    });
    expect(saved).toEqual({ ok: true });
    expect(await readFile(target, "utf8")).toBe("new");
    const after = await service.readInstructionFile({ workspacePath: root, scope: "workspace" });
    expect(after.content).toBe("new");
    expect(after.mtimeMs).not.toBe(before.mtimeMs);
  });
});
