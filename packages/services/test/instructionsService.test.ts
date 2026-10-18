import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { INSTRUCTION_FILE_MAX_BYTES } from "@zcode/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInstructionsService } from "../src/instructions/instructionsService.js";

/**
 * 指令文件服务契约：候选顺序、命中即停、被忽略候选、截断、并发基线与原子写。
 * 全部用真实文件系统（服务本身就是磁盘事实的唯一 owner），不 mock fs。
 */

let root: string;
let homeDir: string;
let workspacePath: string;
const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

function service(): ReturnType<typeof createInstructionsService> {
  return createInstructionsService();
}

async function writeInstruction(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf-8");
}

/** 仓库根标记：服务与 adapters 都靠 `.git` 判定 project root。 */
async function markRepoRoot(path: string): Promise<void> {
  await mkdir(join(path, ".git"), { recursive: true });
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "zcode-instructions-service-"));
  homeDir = join(root, "home");
  workspacePath = join(root, "workspace");
  await mkdir(homeDir, { recursive: true });
  await mkdir(workspacePath, { recursive: true });
  await markRepoRoot(workspacePath);
  // 用户级路径按 HOME 解析；测试进程内固定到临时 home，避免碰到真实用户目录。
  process.env.HOME = homeDir;
  delete process.env.USERPROFILE;
});

afterEach(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
  // 注册面用例会打开 sqlite 句柄，Windows 上句柄释放有延迟，重试几次再放弃。
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe("instructionsService 读取", () => {
  it("仓库根 AGENTS.md 优先于 .zcode/AGENTS.md，命中即停并把被遮蔽候选列为 ignoredCandidates", async () => {
    await writeInstruction(join(workspacePath, "AGENTS.md"), "root instructions");
    await writeInstruction(join(workspacePath, ".zcode", "AGENTS.md"), "tool dir instructions");
    await writeInstruction(join(workspacePath, ".agents", "AGENTS.md"), "agents dir instructions");

    const state = await service().readInstructionFile({ workspacePath, scope: "workspace" });

    expect(state.targetPath).toBe(join(workspacePath, "AGENTS.md"));
    expect(state.effectivePath).toBe(join(workspacePath, "AGENTS.md"));
    expect(state.exists).toBe(true);
    expect(state.content).toBe("root instructions");
    expect(state.ignoredCandidates).toEqual([
      join(workspacePath, ".zcode", "AGENTS.md"),
      join(workspacePath, ".agents", "AGENTS.md"),
    ]);
  });

  it("只有 .zcode/AGENTS.md 时读到它，且没有被忽略候选", async () => {
    await writeInstruction(join(workspacePath, ".zcode", "AGENTS.md"), "tool dir instructions");

    const state = await service().readInstructionFile({ workspacePath, scope: "workspace" });

    expect(state.exists).toBe(false);
    expect(state.effectivePath).toBe(join(workspacePath, ".zcode", "AGENTS.md"));
    expect(state.content).toBe("");
    expect(state.ignoredCandidates).toEqual([]);
  });

  it("本级无候选时向上级目录查找，落点仍是当前工作区", async () => {
    const nested = join(workspacePath, "packages", "app");
    await mkdir(nested, { recursive: true });
    await writeInstruction(join(workspacePath, "AGENTS.md"), "parent instructions");

    const state = await service().readInstructionFile({
      workspacePath: nested,
      scope: "workspace",
    });

    expect(state.targetPath).toBe(join(nested, "AGENTS.md"));
    expect(state.exists).toBe(false);
    expect(state.effectivePath).toBe(join(workspacePath, "AGENTS.md"));
    expect(state.content).toBe("");
  });

  it("超过 100KB 时只返回前 100KB 内容并标记 truncated", async () => {
    const oversized = "a".repeat(INSTRUCTION_FILE_MAX_BYTES) + "tail";
    await writeInstruction(join(workspacePath, "AGENTS.md"), oversized);

    const state = await service().readInstructionFile({ workspacePath, scope: "workspace" });

    expect(state.bytes).toBe(Buffer.byteLength(oversized));
    expect(state.truncated).toBe(true);
    expect(Buffer.byteLength(state.content)).toBe(INSTRUCTION_FILE_MAX_BYTES);
    expect(state.content).toBe("a".repeat(INSTRUCTION_FILE_MAX_BYTES));
  });

  it("未超过上限时不截断", async () => {
    await writeInstruction(join(workspacePath, "AGENTS.md"), "small");

    const state = await service().readInstructionFile({ workspacePath, scope: "workspace" });

    expect(state.bytes).toBe(5);
    expect(state.truncated).toBe(false);
    expect(state.mtimeMs).toBeGreaterThan(0);
    expect(state.writable).toBe(true);
    expect(state.readonlyReason).toBeUndefined();
  });

  it("用户级读取固定 home 下的 .zcode/AGENTS.md", async () => {
    await writeInstruction(join(homeDir, ".zcode", "AGENTS.md"), "user instructions");

    const state = await service().readInstructionFile({ workspacePath, scope: "user" });

    expect(state.targetPath).toBe(join(homeDir, ".zcode", "AGENTS.md"));
    expect(state.effectivePath).toBe(state.targetPath);
    expect(state.content).toBe("user instructions");
    expect(state.ignoredCandidates).toEqual([]);
  });

  it("用户级文件不存在时 exists=false 且没有生效路径", async () => {
    const state = await service().readInstructionFile({ workspacePath, scope: "user" });

    expect(state.exists).toBe(false);
    expect(state.effectivePath).toBeNull();
    expect(state.bytes).toBe(0);
    expect(state.mtimeMs).toBeNull();
    expect(state.content).toBe("");
  });

  // root 用户对 0444 文件仍有写权限，权限语义在该环境下不可构造。
  it.skipIf(process.getuid?.() === 0)("只读落点报告 writable=false 与原因", async () => {
    const filePath = join(workspacePath, "AGENTS.md");
    await writeInstruction(filePath, "read only");
    await chmod(filePath, 0o444);

    try {
      const state = await service().readInstructionFile({ workspacePath, scope: "workspace" });

      expect(state.writable).toBe(false);
      expect(state.readonlyReason).toContain("无写入权限");
      expect(state.content).toBe("read only");
      await expect(
        service().writeInstructionFile({
          workspacePath,
          scope: "workspace",
          content: "mine",
          expectedMtimeMs: state.mtimeMs,
        }),
      ).resolves.toMatchObject({ ok: false, reason: "not-writable" });
    } finally {
      // Windows 上只读属性会挡住 rm，必须先恢复可写，否则 afterEach 的清理失败。
      await chmod(filePath, 0o644);
    }
  });
});

describe("instructionsService 写入", () => {
  it("按新建提交时创建落点，并原子替换已有内容", async () => {
    const serviceInstance = service();

    await expect(
      serviceInstance.writeInstructionFile({
        workspacePath,
        scope: "workspace",
        content: "created\n",
        expectedMtimeMs: null,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(readFile(join(workspacePath, "AGENTS.md"), "utf-8")).resolves.toBe("created\n");

    const before = await serviceInstance.readInstructionFile({ workspacePath, scope: "workspace" });
    await expect(
      serviceInstance.writeInstructionFile({
        workspacePath,
        scope: "workspace",
        content: "updated\n",
        expectedMtimeMs: before.mtimeMs,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(readFile(join(workspacePath, "AGENTS.md"), "utf-8")).resolves.toBe("updated\n");
  });

  it("原子写不留下临时文件与锁目录", async () => {
    await service().writeInstructionFile({
      workspacePath,
      scope: "workspace",
      content: "created\n",
      expectedMtimeMs: null,
    });

    expect((await readdir(workspacePath)).sort()).toEqual([".git", "AGENTS.md"]);
  });

  it("expectedMtimeMs 与磁盘不一致时拒绝覆盖", async () => {
    const filePath = join(workspacePath, "AGENTS.md");
    await writeInstruction(filePath, "on disk");
    const staleMtimeMs = (await stat(filePath)).mtimeMs - 1;

    await expect(
      service().writeInstructionFile({
        workspacePath,
        scope: "workspace",
        content: "mine",
        expectedMtimeMs: staleMtimeMs,
      }),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    await expect(readFile(filePath, "utf-8")).resolves.toBe("on disk");
  });

  it("expectedMtimeMs 为 null（按新建提交）但文件已存在时同样拒绝", async () => {
    const filePath = join(workspacePath, "AGENTS.md");
    await writeInstruction(filePath, "on disk");

    await expect(
      service().writeInstructionFile({
        workspacePath,
        scope: "workspace",
        content: "mine",
        expectedMtimeMs: null,
      }),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    await expect(readFile(filePath, "utf-8")).resolves.toBe("on disk");
  });

  it("基线对但写入前被并发改写时按锁内复验拒绝", async () => {
    const serviceInstance = service();
    const filePath = join(workspacePath, "AGENTS.md");
    await writeInstruction(filePath, "on disk");
    const baseline = await serviceInstance.readInstructionFile({
      workspacePath,
      scope: "workspace",
    });
    if (baseline.mtimeMs === null) {
      throw new Error("baseline must exist before the concurrent-edit scenario");
    }

    // 模拟「读取 → 提交」之间被外部改写：mtime 推到另一个可观测值，避免同一毫秒内落到相同 mtime。
    await writeFile(filePath, "external edit", "utf-8");
    const bumped = new Date(baseline.mtimeMs + 5_000);
    await utimes(filePath, bumped, bumped);

    await expect(
      serviceInstance.writeInstructionFile({
        workspacePath,
        scope: "workspace",
        content: "mine",
        expectedMtimeMs: baseline.mtimeMs,
      }),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    await expect(readFile(filePath, "utf-8")).resolves.toBe("external edit");
  });

  it("targetPath 不存在也不满足预期基线时按冲突拒绝，不创建文件", async () => {
    await expect(
      service().writeInstructionFile({
        workspacePath,
        scope: "workspace",
        content: "mine",
        expectedMtimeMs: 123,
      }),
    ).resolves.toEqual({ ok: false, reason: "conflict" });
    expect((await readdir(workspacePath)).sort()).toEqual([".git"]);
  });

  it("用户级写入会创建 .zcode 目录", async () => {
    await expect(
      service().writeInstructionFile({
        workspacePath,
        scope: "user",
        content: "user instructions\n",
        expectedMtimeMs: null,
      }),
    ).resolves.toEqual({ ok: true });
    await expect(readFile(join(homeDir, ".zcode", "AGENTS.md"), "utf-8")).resolves.toBe(
      "user instructions\n",
    );
  });
});

describe("instructionsService 注册面", () => {
  it("createLocalServices 把服务注册到 instructions 通道（renderer 据此解析到服务）", async () => {
    const [{ createLocalServices, disposeServiceResources }, { IInstructionsService }] =
      await Promise.all([import("../src/node.js"), import("../src/instructions/instructions.js")]);

    const services = createLocalServices({
      zcodeBuiltinProviderConfigFilePath: resolve(
        import.meta.dirname,
        "../../../config/provider/zcode-builtin.json",
      ),
    });

    try {
      const registered = services.get(IInstructionsService);
      expect(IInstructionsService.channelName).toBe("instructions");
      // 通过 descriptor 取到的实例必须就是能读写磁盘的那个实现（不是空对象/占位）。
      expect(typeof registered.readInstructionFile).toBe("function");
      expect(typeof registered.writeInstructionFile).toBe("function");
    } finally {
      // createLocalServices 会打开 tasks 索引等资源；不释放会让测试目录清理在 Windows 上 EBUSY。
      disposeServiceResources(services);
    }
  }, 15_000);
});
