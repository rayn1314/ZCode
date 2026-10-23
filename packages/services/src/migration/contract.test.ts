import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import {
  _checkDataMigrationContract,
  createMigrationService,
  type MigrationServiceDeps,
} from "./contract.js";

// 迁移只碰临时 home 下的两个假身份根；settingService 全程故意抛错，
// 因为本文件只跑 hooks 域——若实现改成顺手读/写目标设置，用例会立刻报错而不是静默通过。
function createDeps(input: { homeDir: string; dataRootDir: string }): MigrationServiceDeps {
  const unused = (action: string) => async (): Promise<never> => {
    throw new Error(`本契约测试不应调用 settingService.${action}`);
  };
  return {
    homeDir: input.homeDir,
    env: {},
    dataRootDir: input.dataRootDir,
    settingService: {
      get: unused("get"),
      update: unused("update"),
      updateDataBaseDir: unused("updateDataBaseDir"),
    },
    credentialService: {
      load: async () => null,
      save: async () => {},
      delete: async () => {},
    },
    cipher: { encrypt: (value) => value, decrypt: (value) => value },
  };
}

function hookMatcher(matcher: string, command: string) {
  return { matcher, hooks: [{ type: "command", command }] };
}

async function createFixture() {
  const home = await mkdtemp(join(tmpdir(), "zcode-migration-"));
  const sourceRoot = join(home, ".zcode");
  const targetRoot = join(home, ".zcode-rayn");
  const sourceConfigPath = join(sourceRoot, "cli", "config.json");
  const targetConfigPath = join(targetRoot, "cli", "config.json");

  // 来源：一条 hook 声明（与目标同名 matcher，用于验证「目标已有不覆盖」）。
  await mkdir(dirname(sourceConfigPath), { recursive: true });
  await writeFile(
    sourceConfigPath,
    JSON.stringify({ hooks: { events: { PreToolUse: [hookMatcher("Bash", "echo src")] } } }),
  );
  // 目标（当前身份）：同名 matcher 已存在，另有必须被保留的其它字段。
  await mkdir(dirname(targetConfigPath), { recursive: true });
  await writeFile(
    targetConfigPath,
    JSON.stringify({
      plugins: { demo: true },
      hooks: { enabled: false, events: { PreToolUse: [hookMatcher("Bash", "echo dst")] } },
    }),
  );

  return {
    home,
    sourceRoot,
    targetRoot,
    sourceConfigPath,
    targetConfigPath,
    deps: createDeps({ homeDir: home, dataRootDir: targetRoot }),
    cleanup: () => rm(home, { recursive: true, force: true }),
  };
}

it("契约与真实服务接口一致（编译期断言的运行时读数）", () => {
  expect(_checkDataMigrationContract).toBe(true);
});

it("只接受探测到的来源根，当前身份不出现在来源列表里", async () => {
  const fixture = await createFixture();
  try {
    const service = createMigrationService(fixture.deps);
    // 目标根带着 cli/ 数据，若无「排除当前身份」就会把自己列成来源。
    expect((await service.discoverSources()).map((source) => source.rootPath)).toEqual([
      fixture.sourceRoot,
    ]);
    // 调用方自己拼一个路径要被拒绝，而不是照它去读盘。
    await expect(
      service.scanSource({ sourceRootPath: join(fixture.home, ".zcode-else") }),
    ).rejects.toThrow("不在本机探测结果内");
  } finally {
    await fixture.cleanup();
  }
});

it("域顺序与默认勾选固定，不迁移的内容单独说明", async () => {
  const fixture = await createFixture();
  try {
    const service = createMigrationService(fixture.deps);
    const scan = await service.scanSource({ sourceRootPath: fixture.sourceRoot });

    expect(scan.domains.map((domain) => domain.id)).toEqual([
      "appSettings",
      "providerConfig",
      "credentials",
      "sessions",
      "workflows",
      "hookDeclarations",
    ]);
    // 凭据与会话历史默认不勾（账号安全面 / 体量最大），其余默认勾。
    expect(
      scan.domains.filter((domain) => domain.defaultSelected).map((domain) => domain.id),
    ).toEqual(["appSettings", "providerConfig", "workflows", "hookDeclarations"]);
    // 只搬声明：来源 1 条 matcher，其中同名的一条与目标冲突。
    const hooks = scan.domains.find((domain) => domain.id === "hookDeclarations");
    expect(hooks).toMatchObject({
      available: true,
      itemCount: 1,
      conflictCount: 1,
      defaultSelected: true,
    });
    // 来源没有设置文件 → 域不可用但不是错误，且给出原因。
    expect(scan.domains.find((domain) => domain.id === "appSettings")).toMatchObject({
      available: false,
      itemCount: 0,
    });
    expect(scan.notMigratable.map((item) => item.id)).toEqual([
      "hookTrust",
      "sharedAssets",
      "artifacts",
      "diagnostics",
    ]);
  } finally {
    await fixture.cleanup();
  }
});

it("目标已有同名 hooks 不覆盖且不写文件，来源新条目才合并进目标", async () => {
  const fixture = await createFixture();
  try {
    const service = createMigrationService(fixture.deps);
    const request = { sourceRootPath: fixture.sourceRoot, domain: "hookDeclarations" as const };
    const before = await readFile(fixture.targetConfigPath, "utf8");

    // 第一条来源 matcher 与目标同名 → 全部跳过，目标文件字节不变。
    expect(await service.migrateDomain(request)).toMatchObject({
      id: "hookDeclarations",
      status: "done",
      imported: 0,
      skipped: 1,
    });
    expect(await readFile(fixture.targetConfigPath, "utf8")).toBe(before);

    // 来源追加一个不同 matcher：只补这条，目标原有条目与其它字段都保留。
    await writeFile(
      fixture.sourceConfigPath,
      JSON.stringify({
        hooks: {
          events: {
            PreToolUse: [hookMatcher("Bash", "echo src"), hookMatcher("Write", "echo new")],
          },
        },
      }),
    );
    expect(await service.migrateDomain(request)).toMatchObject({
      status: "done",
      imported: 1,
      skipped: 1,
    });

    const merged = JSON.parse(await readFile(fixture.targetConfigPath, "utf8"));
    expect(merged.plugins).toEqual({ demo: true });
    expect(merged.hooks.enabled).toBe(false);
    expect(
      merged.hooks.events.PreToolUse.map((entry: { matcher: string }) => entry.matcher),
    ).toEqual(["Bash", "Write"]);

    // 重跑：已存在的照旧跳过，文件不再变化（重复执行安全，但不可逆）。
    const afterMerge = await readFile(fixture.targetConfigPath, "utf8");
    expect(await service.migrateDomain(request)).toMatchObject({ imported: 0, skipped: 2 });
    expect(await readFile(fixture.targetConfigPath, "utf8")).toBe(afterMerge);
  } finally {
    await fixture.cleanup();
  }
});
