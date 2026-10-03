import assert from "node:assert/strict";
import { join, resolve } from "node:path";
import test from "node:test";
import { SESSION_MAILBOX_DIR_NAME, ZCODE_DATA_ROOT_SUFFIX } from "@zcode/shared";
import {
  WORKSPACE_HOOK_TRUST_STORE_FILE_NAME,
  expandUserPath,
  getIdentityDataRootForBaseDir,
  resolveIdentityDataRoot,
  resolveSessionMailboxRoot,
  resolveWorkspaceHookTrustStoreFilePath,
  resolveWorkspaceHookTrustStoreRoot,
} from "@zcode/shared/identity-paths-node";

/**
 * 单源派生契约。
 *
 * 后缀 `ZCODE_DATA_ROOT_SUFFIX` 是构建期注入的编译期常量，测试进程通常为空串（官方渠道），
 * 无法在同一进程内切换。因此断言按「把真实后缀代入期望值」写：官方空后缀时逐字节等于历史路径，
 * 自建非空后缀时期望值随之带上带后缀的身份根（参照 dataRootIsolation.test.ts 的既有做法）。
 */
const suffix = ZCODE_DATA_ROOT_SUFFIX;
const identityRootName = `.zcode${suffix}`;

const homeDir = resolve("/tmp/zcode-identity-home");
const explicitHome = resolve("/tmp/zcode-identity-home-alt");

test("expandUserPath：~ / ~/ 前缀按 home 展开，绝对路径归一，相对路径基准可指定", () => {
  assert.equal(expandUserPath("~", { homeDir }), homeDir);
  assert.equal(expandUserPath("~/dir", { homeDir }), join(homeDir, "dir"));
  assert.equal(expandUserPath("  ~/dir  ", { homeDir }), join(homeDir, "dir"));
  assert.equal(expandUserPath(resolve("/abs/dir"), { homeDir }), resolve("/abs/dir"));
  // 缺省基准是进程 cwd（env 型路径的既有语义）。
  assert.equal(expandUserPath("rel/dir", { homeDir }), resolve("rel/dir"));
  // 权限边界类路径显式传 relativeBaseDir：相对路径绑基准目录，不随 cwd 漂移。
  assert.equal(
    expandUserPath("rel/dir", { homeDir, relativeBaseDir: homeDir }),
    join(homeDir, "rel/dir"),
  );
});

test("getIdentityDataRootForBaseDir：官方空后缀 = {base}/.zcode，自建带后缀", () => {
  const base = resolve("/tmp/zcode-base");
  assert.equal(getIdentityDataRootForBaseDir(base), join(base, identityRootName));
  if (suffix) {
    assert.notEqual(getIdentityDataRootForBaseDir(base), join(base, ".zcode"));
  } else {
    assert.equal(getIdentityDataRootForBaseDir(base), join(base, ".zcode"));
  }
});

test("resolveIdentityDataRoot：显式根 > baseDir 派生；baseDir 缺省 home", () => {
  const base = resolve("/tmp/zcode-base");
  // baseDir 派生（官方 = {base}/.zcode，自建 = {base}/.zcode{suffix}）。
  assert.equal(resolveIdentityDataRoot({ baseDir: base, homeDir }), join(base, identityRootName));
  // 显式数据根优先，并过 ~ 展开。
  assert.equal(
    resolveIdentityDataRoot({ explicitRoot: "~/explicit", baseDir: base, homeDir }),
    join(homeDir, "explicit"),
  );
  // 空串显式根视为未设置，回落 baseDir。
  assert.equal(
    resolveIdentityDataRoot({ explicitRoot: "   ", baseDir: base, homeDir }),
    join(base, identityRootName),
  );
  // 无 baseDir 时缺省 home。
  assert.equal(resolveIdentityDataRoot({ homeDir }), join(homeDir, identityRootName));
});

test("resolveSessionMailboxRoot：ZCODE_MAILBOX_ROOT 覆盖优先，缺省 {dataRoot}/mailbox", () => {
  const dataRoot = resolve("/tmp/zcode-data-root");
  assert.equal(
    resolveSessionMailboxRoot({ dataRootDir: dataRoot, env: {}, homeDir }),
    join(dataRoot, SESSION_MAILBOX_DIR_NAME),
  );
  assert.equal(
    resolveSessionMailboxRoot({
      dataRootDir: dataRoot,
      env: { ZCODE_MAILBOX_ROOT: "~/mb" },
      homeDir,
    }),
    join(homeDir, "mb"),
  );
  assert.equal(
    resolveSessionMailboxRoot({
      dataRootDir: dataRoot,
      env: { ZCODE_MAILBOX_ROOT: "  " },
      homeDir,
    }),
    join(dataRoot, SESSION_MAILBOX_DIR_NAME),
  );
});

test("resolveWorkspaceHookTrustStoreFilePath：跟随声明所在数据根，storage.dir 覆盖三种形态", () => {
  const dataRoot = resolve("/tmp/zcode-data-root");
  const trustRelativePath = join("security", WORKSPACE_HOOK_TRUST_STORE_FILE_NAME);

  // 未配置 storage.dir：信任库必须落在声明所在的数据根下（权限边界，不能共享）。
  assert.equal(resolveWorkspaceHookTrustStoreRoot({ dataRootDir: dataRoot }), dataRoot);
  assert.equal(
    resolveWorkspaceHookTrustStoreFilePath({ dataRootDir: dataRoot }),
    join(dataRoot, trustRelativePath),
  );

  // `~/` 形态按 home 展开。
  assert.equal(
    resolveWorkspaceHookTrustStoreFilePath({
      dataRootDir: dataRoot,
      storageDirOverride: "~/custom-storage",
      homeDir,
    }),
    join(homeDir, "custom-storage", trustRelativePath),
  );
  // 绝对形态直接归一。
  assert.equal(
    resolveWorkspaceHookTrustStoreFilePath({
      dataRootDir: dataRoot,
      storageDirOverride: resolve("/abs/storage"),
      homeDir,
    }),
    join(resolve("/abs/storage"), trustRelativePath),
  );
  // 相对形态按 home 解析：改 repo 前 CLI 与 services 两侧都是 resolve(home, ...)，
  // 信任库是权限落点，不能随启动 cwd 漂移。
  assert.equal(
    resolveWorkspaceHookTrustStoreFilePath({
      dataRootDir: dataRoot,
      storageDirOverride: "rel-storage",
      homeDir,
    }),
    join(homeDir, "rel-storage", trustRelativePath),
  );
  // 空白覆盖值视为未设置。
  assert.equal(
    resolveWorkspaceHookTrustStoreFilePath({ dataRootDir: dataRoot, storageDirOverride: "  " }),
    join(dataRoot, trustRelativePath),
  );

  // 显式 homeDir 只影响 `~` 展开，不影响数据根取值。
  assert.equal(
    resolveWorkspaceHookTrustStoreRoot({ dataRootDir: dataRoot, homeDir: explicitHome }),
    dataRoot,
  );
});
