import assert from "node:assert/strict";
import { existsSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createMigrationService } from "../src/migration/migrationService.js";
import type { IMigrationService } from "../src/migration/migration.js";
import { discoverMigrationSourceRoots } from "../src/data-roots/machineDataRoots.js";
import { createCredentialService } from "../src/credential/credentialService.js";
import type { ICredentialService } from "../src/credential/credential.js";
import { createCredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import type { CredentialCipherProvider } from "../src/credential/providers/credentialCipherProvider.js";
import { createSettingService } from "../src/setting/settingService.js";
import type { ISettingService } from "../src/setting/setting.js";
import { setDataRootDir } from "../src/paths.js";

// 注意：宿主可能已注入 ZCODE_DATA_ROOT，它会压过 baseDir 推导。测试一律用注入的 deps +
// setDataRootDir 覆盖（显式 _dataRootDir 优先于 env），绝不触碰真实数据根。
// node --test 每个文件独立进程，harness 的全局 setDataRootDir 不会串到其它测试文件。

const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

const CREDENTIAL_SECRET = "zcode-migration-test-secret";

interface Harness {
  home: string;
  sourceRoot: string;
  targetRoot: string;
  settingService: ISettingService;
  credentialService: ICredentialService;
  cipher: CredentialCipherProvider;
  service: IMigrationService;
  cleanup(): Promise<void>;
}

const VALID_PROVIDER_CONFIG = {
  schemaVersion: 1,
  config: {
    providerConfigRules: { providerRules: [] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
  },
};

function writeSqlite(file: string, value: number): void {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    db.exec("CREATE TABLE t (v INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(value);
  } finally {
    db.close();
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2));
}

async function writeText(file: string, content: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content);
}

async function createHarness(): Promise<Harness> {
  const home = await mkdtemp(join(tmpdir(), "zcode-migration-home-"));
  const sourceRoot = join(home, "source-root");
  const targetRoot = join(home, ".zcode-rayn");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(targetRoot, { recursive: true });

  const previousHome = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  setDataRootDir(targetRoot);

  const cipher = createCredentialCipherProvider({
    env: { ZCODE_CREDENTIAL_SECRET: CREDENTIAL_SECRET },
  });
  const settingService = createSettingService();
  const credentialService = createCredentialService({ cipherProvider: cipher });
  const service = createMigrationService({
    homeDir: home,
    env: { ZCODE_HOME: sourceRoot },
    dataRootDir: targetRoot,
    settingService,
    credentialService,
    cipher,
  });

  return {
    home,
    sourceRoot,
    targetRoot,
    settingService,
    credentialService,
    cipher,
    service,
    async cleanup() {
      setDataRootDir(null);
      if (previousHome === undefined) {
        delete process.env.ZCODE_DESKTOP_HOME_DIR;
      } else {
        process.env.ZCODE_DESKTOP_HOME_DIR = previousHome;
      }
      await rm(home, { recursive: true, force: true });
    },
  };
}

function summaryOf(scan: Awaited<ReturnType<IMigrationService["scanSource"]>>, id: string) {
  const domain = scan.domains.find((candidate) => candidate.id === id);
  assert.ok(domain, `缺少迁移域 ${id}`);
  return domain;
}

test("来源探测排除当前数据根，官方根排首位", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-migration-probe-"));
  try {
    const official = join(home, ".zcode");
    const selfBeta = join(home, ".zcode-beta");
    const currentSelf = join(home, ".zcode-mine");
    for (const root of [official, selfBeta, currentSelf]) {
      await mkdir(join(root, "v2"), { recursive: true });
    }
    const sources = await discoverMigrationSourceRoots({
      homeDir: home,
      env: {},
      currentDataRootPath: currentSelf,
    });
    assert.equal(sources[0]?.rootPath, official);
    assert.equal(sources[0]?.variant, "official");
    assert.equal(sources[0]?.label, "官方版");
    const selfSource = sources.find((source) => source.rootPath === selfBeta);
    assert.equal(selfSource?.variant, "self");
    assert.equal(selfSource?.identity, "beta");
    assert.equal(selfSource?.label, "自建版 · beta");
    // 当前身份的数据根不得出现在来源里（避免「自己迁自己」）。
    assert.equal(
      sources.some((source) => source.rootPath === currentSelf),
      false,
    );
    // 官方根排在自建根之前。
    assert.ok(
      sources.findIndex((source) => source.variant === "official") <
        sources.findIndex((source) => source.variant === "self"),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("扫描结果 available / itemCount / conflictCount 与真实文件一致", async () => {
  const harness = await createHarness();
  const { sourceRoot, targetRoot } = harness;
  try {
    // appSettings：白名单命中 3 项，dataBaseDir / recentProjects 不计入。
    await writeJson(join(sourceRoot, "v2", "setting.json"), {
      locale: "en-US",
      localePreference: "en-US",
      memoryEnabled: true,
      dataBaseDir: "/source/base",
      recentProjects: ["/source/project"],
    });
    // providerConfig：合法文件，目标缺失。
    await writeJson(join(sourceRoot, "v2", "provider_config.json"), VALID_PROVIDER_CONFIG);
    // credentials：2 个 key，目标已有 1 个。
    await writeJson(join(sourceRoot, "v2", "credentials.json"), {
      "login-a": harness.cipher.encrypt("secret-a"),
      "login-b": harness.cipher.encrypt("secret-b"),
    });
    await writeJson(join(targetRoot, "v2", "credentials.json"), {
      "login-a": harness.cipher.encrypt("existing-a"),
    });
    // sessions：2 个库 + 2 个会话快照；目标已有 tasks-index。
    writeSqlite(join(sourceRoot, "v2", "tasks-index.sqlite"), 1);
    writeSqlite(join(sourceRoot, "cli", "db", "db.sqlite"), 2);
    await writeJson(join(sourceRoot, "v2", "sessions", "hash-a", "s1.json"), { id: "s1" });
    await writeJson(join(sourceRoot, "v2", "sessions", "hash-a", "s2.json"), { id: "s2" });
    writeSqlite(join(targetRoot, "v2", "tasks-index.sqlite"), 99);
    // workflows：4 个直接子文件（含两代扩展名）；目标同名 2 个。
    for (const name of [
      "same.dwf.ts",
      "cross.dwf.ts",
      "new-dynamic.dwf.ts",
      "new-legacy.workflow.js",
    ]) {
      await writeText(join(sourceRoot, "workflows", name), `// ${name}`);
    }
    await writeText(join(targetRoot, "workflows", "same.dwf.ts"), "// target same");
    await writeText(join(targetRoot, "workflows", "cross.workflow.js"), "// target cross");
    // hookDeclarations：3 条声明；目标已有 PreToolUse/Bash。
    await writeJson(join(sourceRoot, "cli", "config.json"), {
      hooks: {
        events: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "src-bash" }] }],
          Stop: [{ hooks: [{ type: "command", command: "src-stop" }] }],
        },
      },
    });
    await writeJson(join(targetRoot, "cli", "config.json"), {
      plugins: { dirs: [] },
      hooks: {
        events: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "tgt-bash" }] }],
        },
      },
    });

    const scan = await harness.service.scanSource({ sourceRootPath: sourceRoot });

    assert.deepEqual(
      scan.domains.map((domain) => domain.id),
      ["appSettings", "providerConfig", "credentials", "sessions", "workflows", "hookDeclarations"],
    );

    const appSettings = summaryOf(scan, "appSettings");
    assert.equal(appSettings.available, true);
    assert.equal(appSettings.itemCount, 3);
    assert.equal(appSettings.conflictCount, 3);
    assert.equal(appSettings.defaultSelected, true);

    const providerConfig = summaryOf(scan, "providerConfig");
    assert.equal(providerConfig.available, true);
    assert.equal(providerConfig.itemCount, 1);
    assert.equal(providerConfig.conflictCount, 0);
    assert.ok(providerConfig.bytes > 0);

    const credentials = summaryOf(scan, "credentials");
    assert.equal(credentials.available, true);
    assert.equal(credentials.itemCount, 2);
    assert.equal(credentials.conflictCount, 1);
    assert.equal(credentials.defaultSelected, false);

    const sessions = summaryOf(scan, "sessions");
    assert.equal(sessions.available, true);
    assert.equal(sessions.itemCount, 4);
    assert.equal(sessions.conflictCount, 1);
    assert.equal(sessions.defaultSelected, false);

    const workflows = summaryOf(scan, "workflows");
    assert.equal(workflows.available, true);
    assert.equal(workflows.itemCount, 4);
    assert.equal(workflows.conflictCount, 2);

    const hookDeclarations = summaryOf(scan, "hookDeclarations");
    assert.equal(hookDeclarations.available, true);
    assert.equal(hookDeclarations.itemCount, 2);
    assert.equal(hookDeclarations.conflictCount, 1);

    assert.deepEqual(
      scan.notMigratable.map((entry) => entry.id),
      ["hookTrust", "sharedAssets", "artifacts", "diagnostics"],
    );
  } finally {
    await harness.cleanup();
  }
});

test("设置迁移只写入显式偏好白名单，目标 dataBaseDir 不被改动", async () => {
  const harness = await createHarness();
  try {
    await harness.settingService.update({ dataBaseDir: "/keep/target/base" });
    await writeJson(join(harness.sourceRoot, "v2", "setting.json"), {
      locale: "en-US",
      memoryEnabled: true,
      dataBaseDir: "/source/base",
      closeToTrayOnWindowsMigrationInitialized: false,
      recentProjects: ["/source/project"],
      providerFamilyDomain: "zai",
    });

    const result = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "appSettings",
    });
    assert.equal(result.status, "done");
    assert.equal(result.imported, 2);
    assert.equal(result.failed, 0);

    const settings = await harness.settingService.get();
    assert.equal(settings.locale, "en-US");
    assert.equal(settings.memoryEnabled, true);
    // 引导指针属于数据根本身，绝不能被来源身份带过来。
    assert.equal(settings.dataBaseDir, "/keep/target/base");
    // 迁移哨兵位与工作区状态字段不迁移。
    assert.equal(settings.closeToTrayOnWindowsMigrationInitialized, true);
    assert.deepEqual(settings.recentProjects, []);
    assert.equal(settings.providerFamilyDomain, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("凭据迁移走加解密链路：目标 load 能取回明文且密文被重新加密", async () => {
  const harness = await createHarness();
  try {
    const sourceCipher = harness.cipher.encrypt("plain-secret-value");
    await writeJson(join(harness.sourceRoot, "v2", "credentials.json"), {
      "login-token": sourceCipher,
      "plain-token": "already-plain",
    });

    const result = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "credentials",
    });
    assert.equal(result.status, "done");
    assert.equal(result.imported, 2);
    assert.equal(result.failed, 0);

    assert.equal(await harness.credentialService.load("login-token"), "plain-secret-value");
    assert.equal(await harness.credentialService.load("plain-token"), "already-plain");

    const stored = JSON.parse(
      await readFile(join(harness.targetRoot, "v2", "credentials.json"), "utf8"),
    ) as Record<string, string>;
    assert.ok(stored["login-token"].startsWith("enc:v1:"));
    // 目标侧重新加密（随机 IV）⇒ 密文与源不同；整文件复制会得到逐字节相同的值。
    assert.notEqual(stored["login-token"], sourceCipher);
  } finally {
    await harness.cleanup();
  }
});

test("工作流迁移同名（含扩展名归一）跳过、异名导入两代扩展名", async () => {
  const harness = await createHarness();
  try {
    // 来源数据根的存在判据是 v2/ 或 cli/；真实数据根必然有其一（这里 workflows 域单独造目录）。
    await mkdir(join(harness.sourceRoot, "v2"), { recursive: true });
    for (const name of [
      "same.dwf.ts",
      "cross.dwf.ts",
      "new-dynamic.dwf.ts",
      "new-legacy.workflow.js",
    ]) {
      await writeText(join(harness.sourceRoot, "workflows", name), `// ${name}`);
    }
    // 非工作流文件与非直接子目录不被收集。
    await writeText(join(harness.sourceRoot, "workflows", "notes.md"), "notes");
    await writeText(join(harness.sourceRoot, "workflows", "nested", "deep.dwf.ts"), "// deep");
    await writeText(join(harness.targetRoot, "workflows", "same.dwf.ts"), "// target same");
    await writeText(join(harness.targetRoot, "workflows", "cross.workflow.js"), "// target cross");

    const result = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "workflows",
    });
    assert.equal(result.status, "done");
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 2);

    const targetWorkflows = join(harness.targetRoot, "workflows");
    assert.equal(
      await readFile(join(targetWorkflows, "new-dynamic.dwf.ts"), "utf8"),
      "// new-dynamic.dwf.ts",
    );
    assert.equal(
      await readFile(join(targetWorkflows, "new-legacy.workflow.js"), "utf8"),
      "// new-legacy.workflow.js",
    );
    // 归一后同名：已有 cross.workflow.js 时不引入 cross.dwf.ts。
    assert.equal(existsSync(join(targetWorkflows, "cross.dwf.ts")), false);
    assert.equal(
      await readFile(join(targetWorkflows, "cross.workflow.js"), "utf8"),
      "// target cross",
    );
    assert.equal(existsSync(join(targetWorkflows, "notes.md")), false);
    assert.equal(existsSync(join(targetWorkflows, "nested")), false);
  } finally {
    await harness.cleanup();
  }
});

test("来源同时留有同名两代工作流时只收当前一代，不在目标并存", async () => {
  const harness = await createHarness();
  try {
    await mkdir(join(harness.sourceRoot, "v2"), { recursive: true });
    // 同一逻辑名 `dual` 的两代定义同时存在于来源（从 legacy 迁到动态工作流后旧文件还留着）。
    // 目标两代都没有：必须只导入一个，否则目标出现两代并存、按名查找时互相覆盖。
    await writeText(join(harness.sourceRoot, "workflows", "dual.dwf.ts"), "// dynamic");
    await writeText(join(harness.sourceRoot, "workflows", "dual.workflow.js"), "// legacy");

    const result = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "workflows",
    });
    assert.equal(result.status, "done");
    assert.equal(result.imported, 1);
    assert.equal(result.skipped, 1);

    const targetWorkflows = join(harness.targetRoot, "workflows");
    // 文件名排序让 `.dwf.ts` 先到，保留的是当前一代。
    assert.equal(await readFile(join(targetWorkflows, "dual.dwf.ts"), "utf8"), "// dynamic");
    assert.equal(existsSync(join(targetWorkflows, "dual.workflow.js")), false);
  } finally {
    await harness.cleanup();
  }
});

test("hooks 合并后目标 cli/config.json 其它字段不变", async () => {
  const harness = await createHarness();
  try {
    const targetConfig = {
      plugins: { dirs: ["/plugins"], enabled: true },
      skills: { enable: { foo: true } },
      mcp: { servers: { local: { type: "stdio", command: "x" } } },
      hooks: {
        enabled: true,
        events: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "tgt-bash" }] }],
        },
      },
    };
    await writeJson(join(harness.sourceRoot, "cli", "config.json"), {
      hooks: {
        enabled: false,
        events: {
          PreToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "src-bash" }] },
            { matcher: "Edit", hooks: [{ type: "command", command: "src-edit" }] },
          ],
          Stop: [{ hooks: [{ type: "command", command: "src-stop" }] }],
        },
      },
    });
    await writeJson(join(harness.targetRoot, "cli", "config.json"), targetConfig);

    const result = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "hookDeclarations",
    });
    assert.equal(result.status, "done");
    assert.equal(result.imported, 2);
    assert.equal(result.skipped, 1);

    const merged = JSON.parse(
      await readFile(join(harness.targetRoot, "cli", "config.json"), "utf8"),
    ) as typeof targetConfig & { hooks: { enabled: boolean; events: Record<string, unknown[]> } };
    // 目标其它字段与 hooks 本地旋钮原样保留。
    assert.deepEqual(merged.plugins, targetConfig.plugins);
    assert.deepEqual(merged.skills, targetConfig.skills);
    assert.deepEqual(merged.mcp, targetConfig.mcp);
    assert.equal(merged.hooks.enabled, true);
    assert.deepEqual(merged.hooks.events.PreToolUse, [
      { matcher: "Bash", hooks: [{ type: "command", command: "tgt-bash" }] },
      { matcher: "Edit", hooks: [{ type: "command", command: "src-edit" }] },
    ]);
    assert.deepEqual(merged.hooks.events.Stop, [
      { hooks: [{ type: "command", command: "src-stop" }] },
    ]);
  } finally {
    await harness.cleanup();
  }
});

test("providerConfig / sessions 目标已存在时整域跳过且目标字节不变", async () => {
  const harness = await createHarness();
  try {
    const targetProviderPath = join(harness.targetRoot, "v2", "provider_config.json");
    await writeJson(join(harness.sourceRoot, "v2", "provider_config.json"), VALID_PROVIDER_CONFIG);
    const targetProviderBytes = JSON.stringify({ untouched: true });
    await writeText(targetProviderPath, targetProviderBytes);

    const providerResult = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "providerConfig",
    });
    assert.equal(providerResult.status, "skipped");
    assert.equal(providerResult.imported, 0);
    assert.equal(await readFile(targetProviderPath, "utf8"), targetProviderBytes);

    const targetSessionsPath = join(harness.targetRoot, "v2", "tasks-index.sqlite");
    writeSqlite(join(harness.sourceRoot, "v2", "tasks-index.sqlite"), 1);
    writeSqlite(targetSessionsPath, 42);
    const before = await readFile(targetSessionsPath);

    const sessionsResult = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "sessions",
    });
    assert.equal(sessionsResult.status, "done");
    assert.equal(sessionsResult.imported, 0);
    assert.equal(sessionsResult.skipped, 1);
    assert.deepEqual(await readFile(targetSessionsPath), before);
  } finally {
    await harness.cleanup();
  }
});

test("sessions 缺库时用 VACUUM INTO 快照落位", async () => {
  const harness = await createHarness();
  try {
    writeSqlite(join(harness.sourceRoot, "v2", "tasks-index.sqlite"), 7);
    await writeJson(join(harness.sourceRoot, "v2", "sessions", "hash-a", "s1.json"), { id: "s1" });

    const result = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "sessions",
    });
    assert.equal(result.status, "done");
    assert.equal(result.imported, 2);

    const snapshot = new DatabaseSync(join(harness.targetRoot, "v2", "tasks-index.sqlite"), {
      readOnly: true,
    });
    try {
      const row = snapshot.prepare("SELECT v FROM t").get() as { v: number };
      assert.equal(row.v, 7);
    } finally {
      snapshot.close();
    }
    assert.equal(
      await readFile(join(harness.targetRoot, "v2", "sessions", "hash-a", "s1.json"), "utf8"),
      JSON.stringify({ id: "s1" }, null, 2),
    );
  } finally {
    await harness.cleanup();
  }
});

test("源文件损坏时该域 failed 且目标保持不变", async () => {
  const harness = await createHarness();
  try {
    const targetProviderPath = join(harness.targetRoot, "v2", "provider_config.json");
    await writeText(join(harness.sourceRoot, "v2", "provider_config.json"), "{ not-json");

    const providerResult = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "providerConfig",
    });
    assert.equal(providerResult.status, "failed");
    assert.ok(providerResult.error);
    assert.equal(existsSync(targetProviderPath), false);

    await writeText(join(harness.sourceRoot, "v2", "setting.json"), "{ not-json");
    const settingResult = await harness.service.migrateDomain({
      sourceRootPath: harness.sourceRoot,
      domain: "appSettings",
    });
    assert.equal(settingResult.status, "failed");
    assert.equal((await harness.settingService.get()).dataBaseDir, undefined);
  } finally {
    await harness.cleanup();
  }
});

test("不在探测结果内的来源根被拒绝", async () => {
  const harness = await createHarness();
  try {
    await assert.rejects(
      harness.service.migrateDomain({
        sourceRootPath: join(harness.home, "not-a-discovered-root"),
        domain: "workflows",
      }),
      /来源数据根不在本机探测结果内/,
    );
    await assert.rejects(
      harness.service.scanSource({ sourceRootPath: join(harness.home, "not-a-discovered-root") }),
      /来源数据根不在本机探测结果内/,
    );
  } finally {
    await harness.cleanup();
  }
});
