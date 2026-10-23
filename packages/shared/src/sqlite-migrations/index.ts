import type { SqliteMigrationsContract } from "./contract.js";
import { migrate } from "./runner.js";
import { restore } from "./restore.js";

export type {
  MigrationBackup,
  MigrationOptions,
  MigrationResult,
  SqliteMigration,
  SqliteMigrationsContract,
} from "./contract.js";
export {
  MigrationChecksumError,
  STORAGE_MIGRATION_COMMAND,
  storageMigrationReportSchema,
} from "./contract.js";
export const sqliteMigrations: SqliteMigrationsContract = { migrate, restore };

export { databaseFileLocation, IN_MEMORY_BACKUP_DIRECTORY } from "./backup-location.js";

export {
  applySqliteSchemaMigration,
  ensureSqliteSchemaMigrationTable,
  SqliteSchemaMigrationChecksumError,
  SESSION_DATABASE_IDENTITY_MIGRATION,
  runSessionDatabaseIdentityMigration,
} from "./legacy.js";
export type { SqliteSchemaMigration } from "./legacy.js";
