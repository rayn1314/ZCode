/**
 * desktop-diagnostics 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * ① 主进程启动最早期注册崩溃捕获（`packages/desktop/src/main/index.ts` 的实际调用点）；
 * ② 导出日志时按路径策略过滤（收集阶段逐条跳过，不进包）。
 */
import {
  isExcludedRelativePath,
  registerProcessLevelErrorCapture,
  shouldApplyLogExportRetention,
} from "./contract.js";

/** 注入的 logger 就是 desktop logger；它是 appendFileSync 同步落盘，无需额外 flush。 */
const logger = {
  error: (...args: unknown[]) => console.error(...args),
};

/** ① 启动期只调用一次；重复注册是空操作。 */
export function registerCrashCapture(): void {
  registerProcessLevelErrorCapture(logger);
}

/** ② 收集阶段：默认拒绝，判不进去就别进包。 */
export function collectExportablePaths(relativePaths: readonly string[]): string[] {
  return relativePaths.filter((relativePath) => !isExcludedRelativePath(relativePath));
}

/** 保留（体积）策略只作用于日志目录自身（`logs/`、`.zcode/cli/log/`），与上面这条各管一件事。 */
export const appliedRetention = shouldApplyLogExportRetention(
  ".zcode/cli/log/zcode-2026-10-23.jsonl",
);

/** 判例：crashpad dump 与顶层数据库都不进包；`repo-backup` 不是 `repo`，照常保留。 */
export const keepOrDrop = {
  dump: isExcludedRelativePath(String.raw`crash\live\reports\5b2e2236.dmp`),
  tasksIndex: isExcludedRelativePath("tasks-index.sqlite-wal"),
  repoBackup: isExcludedRelativePath("repo-backup/src/index.ts"),
  normalLog: isExcludedRelativePath("logs/2026-10-23.log"),
};
