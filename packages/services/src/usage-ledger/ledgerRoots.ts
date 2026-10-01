import { existsSync } from "node:fs";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerSourceKind, LedgerSourceVariant } from "@zcode/shared";
import type { LedgerPriceLoader } from "./ledgerPrices.js";
import type { SpawnLike } from "./ledgerWsl.js";

export const DB_REL_PATH = path.join("cli", "db", "db.sqlite");
export const SELF_ROOTS_TTL_MS = 30_000;

export interface LedgerRootRef {
  rootPath: string;
  dbPath: string;
  providerConfigPath: string;
  kind: LedgerSourceKind;
  /** kind=wsl 时的发行版名。 */
  distro: string | null;
  variant: LedgerSourceVariant;
  /** 自建版身份后缀；官方版为空串。 */
  identity: string;
  /** host 自己的数据根：它读取失败且被选中时整个快照报错，其余源失败只标记不可用。 */
  isPrimary: boolean;
  /** 去重后的来源 key。 */
  key: string;
  label: string;
}

export interface LedgerReaderOptions {
  /** host 自己的数据根（主源）。 */
  dataRootDir: string;
  homeDir?: string;
  appDataDir?: string;
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  now?: () => number;
  spawnImpl?: SpawnLike;
  writeFileImpl?: typeof writeFile;
  existsImpl?: typeof existsSync;
  priceLoader: LedgerPriceLoader;
}

export interface LedgerRootEnv {
  homeDir: string;
  appDataDir?: string;
  env: Record<string, string | undefined>;
  now: () => number;
  existsImpl?: typeof existsSync;
}

function baseKeyLabel(
  kind: LedgerSourceKind,
  distro: string | null,
): { base: string; baseLabel: string } {
  return kind === "windows"
    ? { base: "windows", baseLabel: "Windows" }
    : { base: `wsl:${distro}`, baseLabel: `WSL · ${distro}` };
}

export function sourceKeyLabel(
  kind: LedgerSourceKind,
  distro: string | null,
  variant: LedgerSourceVariant,
  identity: string,
): { key: string; label: string } {
  const { base, baseLabel } = baseKeyLabel(kind, distro);
  if (variant === "self") {
    return { key: `${base}@${identity}`, label: `${baseLabel} · 自建 ${identity}` };
  }
  return { key: base, label: baseLabel };
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

function hasDb(env: LedgerRootEnv, rootPath: string): boolean {
  return env.existsImpl
    ? env.existsImpl(path.join(rootPath, DB_REL_PATH))
    : existsSync(path.join(rootPath, DB_REL_PATH));
}

/** 官方版根目录候选链：ZCODE_HOME → 常见安装位置。全部落空返回 null。 */
export function detectOfficialRoot(env: LedgerRootEnv): string | null {
  const envHome = env.env.ZCODE_HOME;
  if (envHome && hasDb(env, envHome)) {
    return path.resolve(envHome);
  }
  const candidates = [
    path.join(env.homeDir, ".zcode"),
    path.join(env.homeDir, ".config", "zcode"),
    path.join(env.appDataDir ?? path.join(env.homeDir, "AppData", "Roaming"), "zcode"),
  ];
  const found = candidates.find((c) => hasDb(env, c));
  return found ? path.resolve(found) : null;
}

/** 扫 home 下 .zcode-<身份> 形态、装着库的自建版数据根。TTL 缓存由调用方持有。 */
export async function scanSelfRootCandidates(env: LedgerRootEnv): Promise<string[]> {
  const paths: string[] = [];
  try {
    const entries = await readdir(env.homeDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(".zcode-")) {
        continue;
      }
      const rootPath = path.join(env.homeDir, entry.name);
      if (hasDb(env, rootPath)) {
        paths.push(rootPath);
      }
    }
  } catch {
    // home 不可读时视作没有自建根
  }
  paths.sort();
  return paths;
}
