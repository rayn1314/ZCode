import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import type { LedgerSourceVariant } from "@zcode/shared";

// 本机的「机器数据根」探测单源：官方版 `{home}/.zcode` 与自建版 `{home}/.zcode-<身份>`。
// 用量账本（多根只读聚合）与身份数据迁移（按域搬运）都消费这一份结果，规则只实现一次。
//
// 不纳入 WSL / 远端数据根：跨文件系统拷贝的语义与本地不同（权限位、换行、锁、大小写敏感，
// 且 `{dataRoot}` 在远端是另一台机器的路径），迁移不承诺跨机搬运，因此这里只返回本机根。
//
// 各消费方要看的「这个根里有没有数据」判据不同：账本要求 `cli/db/db.sqlite`，
// 迁移域各看自己的相对路径。因此探测本身只负责列目录，是否存在由调用方传入 relPath 决定
// （`hasRelativeFile`）。

export interface MachineDataRootEnv {
  homeDir: string;
  appDataDir?: string;
  env: Record<string, string | undefined>;
  /** 测试注入用：缺省走真实 fs.existsSync。 */
  existsImpl?: typeof existsSync;
}

/** 一个被探测到的数据根。字段与迁移协议的 `MigrationSourceRoot` 结构一致（迁移侧再命名）。 */
export interface DiscoveredDataRoot {
  rootPath: string;
  variant: LedgerSourceVariant;
  /** 自建版身份后缀；官方版为空串。 */
  identity: string;
  label: string;
}

export interface DiscoverMigrationSourceRootsInput {
  homeDir: string;
  env: Record<string, string | undefined>;
  appDataDir?: string;
  /** 当前身份的数据根：探测结果必须排除它（否则等于「自己迁自己」）。 */
  currentDataRootPath: string;
  /** 测试注入用：缺省走真实 fs.existsSync。 */
  existsImpl?: typeof existsSync;
}

/** 相对路径是否存在（文件或目录）。 */
function hasRelativeFile(env: MachineDataRootEnv, rootPath: string, relPath: string): boolean {
  const candidate = path.join(rootPath, relPath);
  return env.existsImpl ? env.existsImpl(candidate) : existsSync(candidate);
}

/** 按目录名区分官方版与自建版数据根：末段形如 .zcode-<身份> 判自建。 */
export function classifyLedgerRoot(rootPath: string): {
  variant: LedgerSourceVariant;
  identity: string;
} {
  const name =
    rootPath
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "";
  if (name.startsWith(".zcode-") && name.length > ".zcode-".length) {
    return { variant: "self", identity: name.slice(".zcode-".length) };
  }
  return { variant: "official", identity: "" };
}

/**
 * 官方版根目录候选链，按优先级排列：`ZCODE_HOME` → 常见安装位置。
 *
 * 两个消费方的「这个候选是不是可用根」判据不同（账本要 `cli/db/db.sqlite`，迁移要 `v2/` 或
 * `cli/` 任一），所以这里只给候选顺序，可用性由调用方用自己的 relPath 判定。
 */
function officialRootCandidates(env: MachineDataRootEnv): string[] {
  return [
    ...(env.env.ZCODE_HOME ? [env.env.ZCODE_HOME] : []),
    path.join(env.homeDir, ".zcode"),
    path.join(env.homeDir, ".config", "zcode"),
    path.join(env.appDataDir ?? path.join(env.homeDir, "AppData", "Roaming"), "zcode"),
  ];
}

/** 官方版根目录：候选链里第一个「含 relPath」的位置；全部落空返回 null。 */
export function detectOfficialRoot(env: MachineDataRootEnv, relPath: string): string | null {
  const found = officialRootCandidates(env).find((c) => hasRelativeFile(env, c, relPath));
  return found ? path.resolve(found) : null;
}

/** 扫 home 下 .zcode-<身份> 形态、装着数据（relPath 存在）的自建版数据根。 */
export async function scanSelfRootCandidates(
  env: MachineDataRootEnv,
  relPath: string,
): Promise<string[]> {
  const paths: string[] = [];
  try {
    const entries = await readdir(env.homeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".zcode-")) {
        continue;
      }
      const rootPath = path.join(env.homeDir, entry.name);
      if (hasRelativeFile(env, rootPath, relPath)) {
        paths.push(rootPath);
      }
    }
  } catch {
    // home 不可读时视作没有自建根
  }
  paths.sort();
  return paths;
}

/** 身份数据根目录名标签，风格与账本 `sourceKeyLabel` 一致。 */
function dataRootLabel(variant: LedgerSourceVariant, identity: string): string {
  return variant === "self" ? `自建版 · ${identity}` : "官方版";
}

/**
 * 迁移域不要求 `cli/db/db.sqlite` 存在：只要目录下存在 `v2/` 或 `cli/` 任一即视为一个可用
 * 数据根。首次运行必然写出 `v2/`（设置、凭据）或 `cli/`（config、会话库），因此该判据不会
 * 漏掉真实根；只有 `workflows/` 的目录不算数据根。
 */
function hasMigrationPayload(env: MachineDataRootEnv, rootPath: string): boolean {
  return hasRelativeFile(env, rootPath, "v2") || hasRelativeFile(env, rootPath, "cli");
}

/**
 * 列出本机全部数据根（排除当前身份的数据根），官方根排首位，其余按路径排序。
 *
 * 官方根优先：常见情形是「从官方切到自建」，官方根是默认迁移来源，排首位让 UI 默认选中它。
 */
export async function discoverMigrationSourceRoots(
  input: DiscoverMigrationSourceRootsInput,
): Promise<DiscoveredDataRoot[]> {
  const env: MachineDataRootEnv = {
    homeDir: input.homeDir,
    appDataDir: input.appDataDir,
    env: input.env,
    existsImpl: input.existsImpl,
  };
  const currentRoot = path.resolve(input.currentDataRootPath);
  const seen = new Set<string>([normalizeComparablePath(currentRoot)]);
  const roots: DiscoveredDataRoot[] = [];

  const push = (rootPath: string): void => {
    const resolved = path.resolve(rootPath);
    const comparable = normalizeComparablePath(resolved);
    if (seen.has(comparable)) return;
    seen.add(comparable);
    const { variant, identity } = classifyLedgerRoot(resolved);
    roots.push({ rootPath: resolved, variant, identity, label: dataRootLabel(variant, identity) });
  };

  for (const candidate of officialRootCandidates(env)) {
    if (hasMigrationPayload(env, candidate)) {
      push(candidate);
    }
  }

  // 自建根按路径排序，保证探测结果稳定（UI 顺序不随 readdir 抖动）。
  const selfRoots = await scanSelfRootCandidates(env, "v2");
  const selfRootsWithCli = new Set(selfRoots);
  for (const candidate of await scanSelfRootCandidates(env, "cli")) {
    selfRootsWithCli.add(candidate);
  }
  for (const selfRoot of [...selfRootsWithCli].sort()) {
    push(selfRoot);
  }

  return roots;
}

/** Windows 路径大小写不敏感：去重按小写比较，否则同根会被当成两个来源。 */
function normalizeComparablePath(rootPath: string): string {
  const normalized = path.resolve(rootPath).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
