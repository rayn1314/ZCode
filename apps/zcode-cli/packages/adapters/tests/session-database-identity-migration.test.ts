import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import {
  runSqliteSessionMigrations,
  runSqliteSessionMigrationsAsync,
  type SqliteMigrationProgress,
} from "../src/storage/session-store/migration-runner.js";
import { runSessionDatabaseIdentityMigration } from "@zcode/shared/sqlite-migrations";

// shared 的 identity 迁移固定 id 为 0024；本 fork 的 0023/0024 已随 0.16.9 发布给会话目标
// 截止时间迁移，两个 0024 不能共存，因此在 Agent 清单里把 identity 顺延为 0026。
// 两条记录执行同一份 SQL，checksum 相同，但不再共用同一账本行。
const AGENT_IDENTITY_MIGRATION_ID = "0026_session_database_identity";
const SOURCE_IDENTITY_MIGRATION_ID = "0024_session_database_identity";

it.each(["source-first", "agent-first"])(
  "%s：两端执行同一份 identity SQL，结构接管不生成业务代际",
  async (order) => {
    const db = new DatabaseSync(":memory:");
    try {
      const agent = () => runSqliteSessionMigrations(db, ":memory:");
      const source = () => runSessionDatabaseIdentityMigration(db);
      await (order === "source-first" ? source : agent)();
      await (order === "source-first" ? agent : source)();
      const agentRow = db
        .prepare("SELECT checksum FROM schema_migration WHERE id=?")
        .get(AGENT_IDENTITY_MIGRATION_ID) as { checksum: string } | undefined;
      const sourceRow = db
        .prepare("SELECT checksum FROM schema_migration WHERE id=?")
        .get(SOURCE_IDENTITY_MIGRATION_ID) as { checksum: string } | undefined;
      expect(agentRow).toBeDefined();
      expect(sourceRow).toBeDefined();
      // 同一份 SQL 必须得到同一 checksum；两端重复接管不改写 identity 代际。
      expect(agentRow!.checksum).toBe(sourceRow!.checksum);
      expect(db.prepare("SELECT * FROM zcode_database_identity").all()).toEqual([]);
      // Agent 清单 26 条 + Source 的 0024 共 27 行；两种顺序结果一致。
      expect(db.prepare("SELECT COUNT(*) AS n FROM schema_migration").get()?.n).toBe(27);
      // 重复打开两端都不得改写账本。
      const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
      await agent();
      await source();
      expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
    } finally {
      db.close();
    }
  },
);

it("Source 记账失败回滚新表；Source 拒绝损坏 checksum，Agent 不覆盖历史账本行", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, app_version TEXT, time_applied INTEGER NOT NULL);
      CREATE TRIGGER reject_identity BEFORE INSERT ON schema_migration
      WHEN NEW.id='0024_session_database_identity'
      BEGIN SELECT RAISE(ABORT, 'injected identity ledger failure'); END;`);
    expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(
      "injected identity ledger failure",
    );
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='zcode_database_identity'").get(),
    ).toBeUndefined();
    expect(db.prepare("SELECT * FROM schema_migration").all()).toEqual([]);
    db.exec("DROP TRIGGER reject_identity");
    runSessionDatabaseIdentityMigration(db);
    db.exec("UPDATE schema_migration SET checksum='broken'");
    expect(() => runSessionDatabaseIdentityMigration(db)).toThrow(/checksum mismatch/);
    // Agent 的 identity 已顺延为 0026，不再与 Source 的 0024 共用账本行，因此不会读取
    // Source 那条损坏记录；但也绝不能覆盖它，损坏事实原样保留供人工处理。
    await runSqliteSessionMigrations(db, ":memory:");
    const rows = db.prepare("SELECT id, checksum FROM schema_migration").all() as Array<{
      id: string;
      checksum: string;
    }>;
    expect(rows).toContainEqual({ id: SOURCE_IDENTITY_MIGRATION_ID, checksum: "broken" });
    expect(rows.some((row) => row.id === AGENT_IDENTITY_MIGRATION_ID)).toBe(true);
  } finally {
    db.close();
  }
});

it("Agent 正式迁移接管已有 Source identity，不覆盖代际且重复打开不改账本", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE zcode_database_identity (scope TEXT PRIMARY KEY, identity TEXT NOT NULL);
      INSERT INTO zcode_database_identity VALUES ('session', 'existing-generation')`);
    await runSqliteSessionMigrations(db, ":memory:");
    expect(
      db.prepare("SELECT id FROM schema_migration WHERE id=?").get(AGENT_IDENTITY_MIGRATION_ID),
    ).toEqual({
      id: AGENT_IDENTITY_MIGRATION_ID,
    });
    const ledger = db.prepare("SELECT * FROM schema_migration ORDER BY id").all();
    await runSqliteSessionMigrations(db, ":memory:");
    expect(db.prepare("SELECT * FROM schema_migration ORDER BY id").all()).toEqual(ledger);
    expect(db.prepare("SELECT identity FROM zcode_database_identity").get()).toEqual({
      identity: "existing-generation",
    });
  } finally {
    db.close();
  }
});

it("Agent/Source 共用应用原语，identity SQL 成功但记账失败时保留真实执行数量", async () => {
  const db = new DatabaseSync(":memory:");
  const states: SqliteMigrationProgress[] = [];
  try {
    await expect(
      runSqliteSessionMigrationsAsync(db, ":memory:", {
        onProgress: async (state) => {
          states.push(state);
          if (
            state.phase === "migrating" &&
            state.migrationId === AGENT_IDENTITY_MIGRATION_ID
          ) {
            db.exec(`CREATE TRIGGER reject_identity BEFORE INSERT ON schema_migration
              WHEN NEW.id='0026_session_database_identity'
              BEGIN SELECT RAISE(ABORT, 'injected identity ledger failure'); END;`);
          }
        },
      }),
    ).rejects.toMatchObject({ kind: "sql_failed", migrationId: AGENT_IDENTITY_MIGRATION_ID });
    expect(states.at(-1)).toMatchObject({
      phase: "failed",
      // identity 是 Agent 清单的最后一条：26 条 SQL 全部执行，账本提交回滚。
      migration: { kind: "initialize", executedCount: 26, committedCount: 0 },
    });
    expect(db.isTransaction).toBe(false);
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='zcode_database_identity'").get(),
    ).toBeUndefined();
    expect(
      db.prepare("SELECT 1 FROM sqlite_master WHERE name='schema_migration'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
});
