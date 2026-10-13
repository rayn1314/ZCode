// 0004 任务纳入自动化体系：automations 增加会话目标描述与执行截止列。
// 模板形态（无 cron）用空字符串表达，不动 cron_expr NOT NULL 约束（0001 冻结）。
// 独立常量文件：与 0002/0003 的迁移 SQL 同构，保证 checksum 输入稳定。
import type { DatabaseSync } from "node:sqlite";

export const TASK_GOAL_MERGE_MIGRATION_SQL = [
  ["objective", "ALTER TABLE automations ADD COLUMN objective TEXT"],
  ["deadline_ms", "ALTER TABLE automations ADD COLUMN deadline_ms INTEGER"],
] as const;

/**
 * 0004 的执行入口：按列存在性幂等补列（重跑迁移/账本被删时不能重复 ADD）。
 * 与 0001 adoptSchema 的 columns 循环同构；迁移 runner 不直接书写 DDL 文本。
 */
export function applyTaskGoalMergeMigration(db: DatabaseSync): void {
  const existing = db.prepare("PRAGMA table_info(automations)").all() as Array<{
    name: string;
  }>;
  const existingNames = new Set(existing.map((c) => c.name));
  for (const [column, statement] of TASK_GOAL_MERGE_MIGRATION_SQL) {
    if (existingNames.has(column)) continue;
    db.prepare(statement).run();
  }
}
