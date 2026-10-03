import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { LedgerSourceKind, LedgerSourceVariant } from "@zcode/shared";
import type { LedgerPriceLoader } from "./ledgerPrices.js";
import type { SpawnLike } from "./ledgerWsl.js";
import {
  detectOfficialRoot as detectOfficialRootFor,
  scanSelfRootCandidates as scanSelfRootCandidatesFor,
  type MachineDataRootEnv,
} from "../data-roots/machineDataRoots.js";

// 数据根探测（官方根候选链、自建根扫描、官方/自建归类）已收成单源：
// `../data-roots/machineDataRoots.js`。这里只保留账本领域自己的东西——
// 账本要求的相对路径（`cli/db/db.sqlite`）、TTL 常量、来源 key/标签与引用结构，
// 并以账本自己的 relPath 适配单源探测，账本调用点保持零改动。
// 迁移域复用同一份探测，但按各域自己的相对路径判定根是否可用。

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
  /** kind=wsl 专属：非空表示本次探测未确认到该源（发行版停止/瞬态失败），值是最后一次确认的时刻；仅供灰显不参与聚合。 */
  staleAt?: number;
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

/**
 * 探测环境：单源定义的机器数据根环境 + 账本自己的探测 TTL 时钟。
 *
 * `now` 只有账本消费（`SELF_ROOTS_TTL_MS` 缓存），因此留在账本侧，不塞进单源模块。
 */
export type LedgerRootEnv = MachineDataRootEnv & { now: () => number };

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

export { classifyLedgerRoot } from "../data-roots/machineDataRoots.js";

/** 官方版根目录候选链：ZCODE_HOME → 常见安装位置；按账本的库路径判定。 */
export function detectOfficialRoot(env: LedgerRootEnv): string | null {
  return detectOfficialRootFor(env, DB_REL_PATH);
}

/** 扫 home 下 .zcode-<身份> 形态、装着账本库的自建版数据根。TTL 缓存由调用方持有。 */
export async function scanSelfRootCandidates(env: LedgerRootEnv): Promise<string[]> {
  return scanSelfRootCandidatesFor(env, DB_REL_PATH);
}
