import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

/**
 * 内存（未落盘）数据库没有可推导的数据根，迁移前备份退到系统临时目录。
 * 不能拿 dbPath 兜底推导：`dirname(":memory:")` 是 "."，备份会被写进进程当前工作目录。
 */
export const IN_MEMORY_BACKUP_DIRECTORY = join(tmpdir(), "zcode-sqlite-migration-backup");

/** 数据库真实的落盘文件；`:memory:`、`file::memory:?cache=shared` 等返回 undefined。 */
export function databaseFileLocation(db: DatabaseSync): string | undefined {
  const file = db
    .prepare("pragma database_list")
    .all()
    .find((row) => row.name === "main")?.file;
  return typeof file === "string" && file.length > 0 ? file : undefined;
}
