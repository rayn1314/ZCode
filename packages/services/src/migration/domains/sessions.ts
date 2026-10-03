import { copyFile, mkdir, readdir, rename, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import type { MigrationDomainResult, MigrationDomainSummary } from "../migration.js";
import {
  capDetails,
  errorMessage,
  fileExistsSync,
  fileSizeOrZero,
  isNotFound,
  resolveDomainPath,
  type MigrationDomainContext,
  type MigrationDomainOps,
} from "../domainSupport.js";

// node:sqlite 的引入方式与 tasksDatabase/startup.ts、usage-ledger/ledgerReader.ts 一致：
// createRequire 规避构建器把 node:sqlite 改写成不存在的 npm sqlite 包。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

/**
 * 会话与任务历史。
 *
 * 两个 SQLite 库用 `VACUUM INTO` 快照：运行中的库有 `-wal` / `-shm`，直接拷主库文件会拿到
 * 半截状态；`VACUUM INTO` 由 SQLite 自己产出一致快照，不需要也不应单独搬 `-wal` / `-shm`。
 * `v2/sessions/**` 是会话快照文件，逐文件补缺失。
 *
 * 目标已存在一律跳过，绝不覆盖；本域内任一产物失败则回滚本次新建的全部产物，保证
 * 「要么都补上、要么目标保持原状」，不留半截状态。
 */
const SQLITE_REL_PATHS = [
  ["v2", "tasks-index.sqlite"],
  ["cli", "db", "db.sqlite"],
] as const;
const SESSIONS_DIR_REL = ["v2", "sessions"] as const;

function sqliteSourcePath(ctx: MigrationDomainContext, rel: readonly string[]): string {
  return resolveDomainPath(ctx.sourceRootPath, rel);
}

function sqliteTargetPath(ctx: MigrationDomainContext, rel: readonly string[]): string {
  return resolveDomainPath(ctx.targetRootPath, rel);
}

async function listSessionFiles(dir: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listSessionFiles(child)));
    } else if (entry.isFile()) {
      files.push(child);
    }
  }
  return files;
}

async function scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary> {
  let itemCount = 0;
  let conflictCount = 0;
  let bytes = 0;
  for (const rel of SQLITE_REL_PATHS) {
    const source = sqliteSourcePath(ctx, rel);
    if (!fileExistsSync(source)) continue;
    itemCount += 1;
    bytes += await fileSizeOrZero(source);
    if (fileExistsSync(sqliteTargetPath(ctx, rel))) conflictCount += 1;
  }
  const sessionsDir = resolveDomainPath(ctx.sourceRootPath, SESSIONS_DIR_REL);
  const sessionFiles = await listSessionFiles(sessionsDir);
  for (const file of sessionFiles) {
    itemCount += 1;
    bytes += await fileSizeOrZero(file);
    const relative = path.relative(sessionsDir, file);
    if (fileExistsSync(resolveDomainPath(ctx.targetRootPath, [...SESSIONS_DIR_REL, relative]))) {
      conflictCount += 1;
    }
  }
  return {
    id: "sessions",
    available: itemCount > 0,
    itemCount,
    bytes,
    conflictCount,
    defaultSelected: false,
    skipReason: itemCount > 0 ? undefined : "来源没有这项数据",
    note: "整库搬运，不做会话级选择；目标已有的库文件直接跳过",
  };
}

/** SQLite 字符串字面量转义：VACUUM 不接受参数绑定，路径只能拼进 SQL 文本。 */
function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

async function vacuumIntoSnapshot(sourceDb: string, destination: string): Promise<void> {
  const tempPath = `${destination}.migration-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  try {
    db.exec(`VACUUM INTO '${escapeSqlString(tempPath)}'`);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    db.close();
  }
  try {
    await rename(tempPath, destination);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult> {
  const created: string[] = [];
  let imported = 0;
  let skipped = 0;
  const details: string[] = [];
  try {
    for (const rel of SQLITE_REL_PATHS) {
      const source = sqliteSourcePath(ctx, rel);
      if (!fileExistsSync(source)) continue;
      const destination = sqliteTargetPath(ctx, rel);
      if (fileExistsSync(destination)) {
        skipped += 1;
        details.push(`${rel.join("/")} 目标已存在，跳过`);
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await vacuumIntoSnapshot(source, destination);
      created.push(destination);
      imported += 1;
    }

    const sessionsDir = resolveDomainPath(ctx.sourceRootPath, SESSIONS_DIR_REL);
    for (const file of await listSessionFiles(sessionsDir)) {
      const relative = path.relative(sessionsDir, file);
      const destination = resolveDomainPath(ctx.targetRootPath, [...SESSIONS_DIR_REL, relative]);
      if (fileExistsSync(destination)) {
        skipped += 1;
        continue;
      }
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(file, destination);
      created.push(destination);
      imported += 1;
    }
  } catch (error) {
    // 回滚本次新建的产物（照 claudeNativeSessionImportService 的 createdOutputPaths 先例）：
    // 部分成功的会话库没有使用价值，目标必须保持「迁移前」的可预期状态。
    await rollbackCreated(created);
    return {
      id: "sessions",
      status: "failed",
      imported: 0,
      skipped,
      failed: 1,
      details: capDetails(details),
      error: errorMessage(error),
    };
  }

  if (imported === 0 && skipped === 0) {
    return {
      id: "sessions",
      status: "skipped",
      imported: 0,
      skipped: 0,
      failed: 0,
      details: ["来源没有这项数据"],
    };
  }
  return {
    id: "sessions",
    status: "done",
    imported,
    skipped,
    failed: 0,
    details: capDetails(details),
  };
}

async function rollbackCreated(paths: readonly string[]): Promise<void> {
  for (const created of new Set(paths)) {
    await rm(created, { force: true }).catch(() => undefined);
  }
}

export const sessionsDomain: MigrationDomainOps = { scan, migrate };
