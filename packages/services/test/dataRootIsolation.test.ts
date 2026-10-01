import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { ZCODE_DATA_ROOT_SUFFIX } from "@zcode/shared";
import type { ISettingService } from "../src/setting/setting.js";

// ZCODE_DATA_ROOT 是宿主进程按 env 注入的身份数据根（见 paths.ts），必须在模块加载前写入，
// 因此这里先设 env 再动态导入。node --test 每个测试文件单独起进程，不影响其它文件。
const envDataRoot = join(tmpdir(), "zcode-data-root-env-fixture");
process.env.ZCODE_DATA_ROOT = envDataRoot;
const paths = await import("../src/paths.js");
const { createSettingService } = await import("../src/setting/settingService.js");

/** 带产品身份后缀的数据根：官方构建后缀为空串，路径与历史一致。 */
function identityDataRoot(baseDir: string): string {
  return join(baseDir, `.zcode${ZCODE_DATA_ROOT_SUFFIX}`);
}

/** 在临时 home 下执行：设置指针文件固定在 home，测试必须把 ZCODE_DESKTOP_HOME_DIR 指向临时目录。 */
async function withTempHome<T>(run: (home: string) => Promise<T>): Promise<T> {
  const home = await mkdtemp(join(tmpdir(), "zcode-identity-home-"));
  const previous = process.env.ZCODE_DESKTOP_HOME_DIR;
  process.env.ZCODE_DESKTOP_HOME_DIR = home;
  try {
    return await run(home);
  } finally {
    if (previous === undefined) {
      delete process.env.ZCODE_DESKTOP_HOME_DIR;
    } else {
      process.env.ZCODE_DESKTOP_HOME_DIR = previous;
    }
    await rm(home, { recursive: true, force: true });
  }
}

test("ZCODE_DATA_ROOT wins over the base-dir derived data root", () => {
  assert.equal(paths.getZCodeDataRootDir(), envDataRoot);
  assert.equal(paths.getAppConfigDir(), join(envDataRoot, "v2"));
  assert.equal(paths.getTasksIndexDatabasePath(), join(envDataRoot, "v2", "tasks-index.sqlite"));
});

test("data root carries the product identity suffix; empty suffix keeps the legacy path", () => {
  const baseDir = join(tmpdir(), "zcode-data-base-fixture");
  assert.equal(paths.getDataRootDirForBaseDir(baseDir), identityDataRoot(baseDir));
  if (ZCODE_DATA_ROOT_SUFFIX) {
    // 有身份后缀时必须与官方根分开，否则两个客户端读写同一份会话库与设置。
    assert.notEqual(paths.getDataRootDirForBaseDir(baseDir), join(baseDir, ".zcode"));
  } else {
    assert.equal(paths.getDataRootDirForBaseDir(baseDir), join(baseDir, ".zcode"));
  }
});

test("bootstrap settings pointer prefers the identity file and falls back to the shared one", async () => {
  await withTempHome(async (home) => {
    const identityFile = paths.getBootstrapSettingsFile();
    assert.equal(identityFile, join(home, `.zcode${ZCODE_DATA_ROOT_SUFFIX}`, "v2", "setting.json"));

    const candidates = paths.getBootstrapSettingsCandidateFiles();
    assert.equal(candidates[0], identityFile);
    if (ZCODE_DATA_ROOT_SUFFIX) {
      assert.deepEqual(candidates, [identityFile, join(home, ".zcode", "v2", "setting.json")]);
    } else {
      // 官方后缀为空串：身份文件即共享文件，候选链退化为单文件，行为与历史一致。
      assert.deepEqual(candidates, [identityFile]);
    }

    // 都不存在时读默认写入目标，读不到即默认值。
    assert.equal(paths.resolveBootstrapSettingsFileForRead(), identityFile);

    // 身份文件存在 → 优先读它。
    await mkdir(dirname(identityFile), { recursive: true });
    await writeFile(identityFile, "{}");
    assert.equal(paths.resolveBootstrapSettingsFileForRead(), identityFile);

    // 身份文件缺失 → 回退到共享兜底文件（官方构建两者同路径，读到的仍是身份文件）。
    await rm(identityFile);
    const sharedFallback = join(home, ".zcode", "v2", "setting.json");
    if (sharedFallback !== identityFile) {
      await mkdir(dirname(sharedFallback), { recursive: true });
      await writeFile(sharedFallback, "{}");
    }
    assert.equal(paths.resolveBootstrapSettingsFileForRead(), sharedFallback);
  });
});

test("settings writes only land in the identity pointer file, never in the shared official file", async () => {
  await withTempHome(async (home) => {
    const service: ISettingService = createSettingService();
    await service.update({});
    assert.equal(existsSync(paths.getBootstrapSettingsFile()), true);
    if (ZCODE_DATA_ROOT_SUFFIX) {
      // 自建版改过的设置不能写进官方共享文件，否则官方客户端会读到自建版的值。
      assert.equal(existsSync(join(home, ".zcode", "v2", "setting.json")), false);
    }
  });
});

test("copyDataDirectory migrates the identity data root: user config moves, pointer file stays", async () => {
  const root = await mkdtemp(join(tmpdir(), "zcode-copy-data-"));
  const oldBase = join(root, "old-base");
  const newBase = join(root, "new-base");
  try {
    const oldV2 = join(identityDataRoot(oldBase), "v2");
    await mkdir(join(oldV2, "sessions"), { recursive: true });
    await writeFile(join(oldV2, "personal.json"), '{"schemaVersion":1}');
    await writeFile(join(oldV2, "sessions", "task.json"), "{}");
    await writeFile(join(oldV2, "setting.json"), '{"dataBaseDir":"old"}');
    // setting.json 的原子写入中间态（lock/tmp）同样不迁移。
    await writeFile(join(oldV2, "setting.json.lock"), "");
    // 数据根之外的兄弟目录不属于迁移范围。
    await mkdir(join(oldBase, "unrelated"), { recursive: true });
    await writeFile(join(oldBase, "unrelated", "keep.txt"), "keep");

    // 迁移必须按给定 base dir 推导身份根，而不是当前进程的 ZCODE_DATA_ROOT。
    await paths.copyDataDirectory(oldBase, newBase);

    const newV2 = join(identityDataRoot(newBase), "v2");
    assert.equal(await readFile(join(newV2, "personal.json"), "utf8"), '{"schemaVersion":1}');
    assert.equal(await readFile(join(newV2, "sessions", "task.json"), "utf8"), "{}");
    assert.equal(existsSync(join(newV2, "setting.json")), false);
    assert.equal(existsSync(join(newV2, "setting.json.lock")), false);
    assert.equal(existsSync(join(newBase, "unrelated")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
