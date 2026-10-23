import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  SESSION_MAILBOX_DIR_NAME,
  SESSION_MAILBOX_ROOT_ENV,
  buildSessionMailboxFileName,
  classifyLedgerRoot,
  discoverMigrationSourceRoots,
  expandUserPath,
  getIdentityDataRootForBaseDir,
  resolveIdentityDataRoot,
  resolveSessionMailboxRoot,
  resolveWorkspaceHookTrustStoreFilePath,
  resolveWorkspaceHookTrustStoreRoot,
} from "./contract.js";

// 用例只碰临时 home，绝不读写真实数据根；home 目录名只是拼接基准，不需要真实存在。
const fakeHome = join(tmpdir(), "zcode-data-roots-home");

it("身份数据根：显式根优先，其余按 {baseDir}/.zcode{suffix} 派生", () => {
  const baseDir = join(fakeHome, "data");
  // `~` 展开后仍以显式根为准
  expect(resolveIdentityDataRoot({ explicitRoot: "~/custom-root", homeDir: fakeHome })).toBe(
    join(fakeHome, "custom-root"),
  );
  // 空白的显式根等同缺省，不能退化成「空路径」
  expect(resolveIdentityDataRoot({ explicitRoot: "   ", baseDir, homeDir: fakeHome })).toBe(
    getIdentityDataRootForBaseDir(baseDir),
  );
  // baseDir 缺省 home
  expect(resolveIdentityDataRoot({ homeDir: fakeHome })).toBe(
    getIdentityDataRootForBaseDir(fakeHome),
  );
});

it("mailbox 落盘根跟随身份数据根，显式覆盖优先且过 ~ 展开", () => {
  const dataRootDir = getIdentityDataRootForBaseDir(fakeHome);
  expect(resolveSessionMailboxRoot({ dataRootDir, env: {}, homeDir: fakeHome })).toBe(
    join(dataRootDir, SESSION_MAILBOX_DIR_NAME),
  );
  expect(
    resolveSessionMailboxRoot({
      dataRootDir,
      env: { [SESSION_MAILBOX_ROOT_ENV]: "~/override-mailbox" },
      homeDir: fakeHome,
    }),
  ).toBe(join(fakeHome, "override-mailbox"));
});

it("hook 信任库的 storage.dir 覆盖按 home 解析，落点不随启动目录漂移", () => {
  const dataRootDir = getIdentityDataRootForBaseDir(fakeHome);
  expect(resolveWorkspaceHookTrustStoreRoot({ dataRootDir, homeDir: fakeHome })).toBe(dataRootDir);
  expect(
    resolveWorkspaceHookTrustStoreFilePath({
      dataRootDir,
      storageDirOverride: "custom-store",
      homeDir: fakeHome,
    }),
  ).toBe(join(fakeHome, "custom-store", "security", "workspace-hook-trust-v1.json"));
  expect(expandUserPath("~", { homeDir: fakeHome })).toBe(fakeHome);
});

it("按目录名判定官方版与自建版数据根", () => {
  expect(classifyLedgerRoot(join(tmpdir(), ".zcode"))).toEqual({
    variant: "official",
    identity: "",
  });
  // 末段分隔符先归一，尾部斜杠不影响判定
  expect(classifyLedgerRoot(`${join(tmpdir(), ".zcode-rayn")}/`)).toEqual({
    variant: "self",
    identity: "rayn",
  });
  // 只有前缀没有身份后缀不算自建根
  expect(classifyLedgerRoot(join(tmpdir(), ".zcode-"))).toEqual({
    variant: "official",
    identity: "",
  });
});

it("探测本机数据根：排除当前身份、官方根优先、没有数据的目录不算根", async () => {
  const home = await mkdtemp(join(tmpdir(), "zcode-data-roots-"));
  try {
    await mkdir(join(home, ".zcode", "v2"), { recursive: true });
    await mkdir(join(home, ".zcode-rayn", "cli"), { recursive: true });
    await mkdir(join(home, ".zcode-zeta", "v2"), { recursive: true });
    // 只有 workflows/ 的目录不算数据根（首次运行必然写出 v2/ 或 cli/）
    await mkdir(join(home, ".zcode-empty", "workflows"), { recursive: true });

    const roots = await discoverMigrationSourceRoots({
      homeDir: home,
      env: {},
      currentDataRootPath: join(home, ".zcode-rayn"),
    });

    expect(roots.map((root) => root.rootPath)).toEqual([
      join(home, ".zcode"),
      join(home, ".zcode-zeta"),
    ]);
    expect(roots[0]).toMatchObject({ variant: "official", identity: "", label: "官方版" });
    expect(roots[1]).toMatchObject({
      variant: "self",
      identity: "zeta",
      label: "自建版 · zeta",
    });
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("信封文件名定长（字典序即时间序），重投稳定，非法入参抛错", () => {
  const early = buildSessionMailboxFileName({
    messageId: "m1",
    createdAt: "2026-01-02T03:04:05.006Z",
  });
  const late = buildSessionMailboxFileName({
    messageId: "m2",
    createdAt: "2026-01-02T03:04:06.000Z",
  });
  expect(early).toBe("20260102T030405006Z_m1.json");
  expect(early).toHaveLength(late.length);
  expect(early < late).toBe(true);
  // 同一信封重投：文件名不变，靠原子 rename 覆盖同一路径，不产生第二份可读消息
  expect(
    buildSessionMailboxFileName({ messageId: "m1", createdAt: "2026-01-02T03:04:05.006Z" }),
  ).toBe(early);
  // messageId 来自别的进程 / 远端，必须过白名单，否则 `../` 能借文件名突破会话目录防护
  expect(() =>
    buildSessionMailboxFileName({ messageId: "../escape", createdAt: "2026-01-02T03:04:05.006Z" }),
  ).toThrow();
  expect(() => buildSessionMailboxFileName({ messageId: "m1", createdAt: "not-a-date" })).toThrow();
});
