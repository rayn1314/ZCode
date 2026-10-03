import { copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import type { MigrationDomainResult, MigrationDomainSummary } from "../migration.js";
import {
  capDetails,
  errorMessage,
  fileSizeOrZero,
  isNotFound,
  resolveDomainPath,
  type MigrationDomainContext,
  type MigrationDomainOps,
} from "../domainSupport.js";

/**
 * 用户级工作流库。
 *
 * 两代定义各取各的扩展名：动态工作流 `.dwf.ts`、legacy 脚本 `.workflow.js`。只收目标目录的
 * 直接子文件（不递归），避免把来源身份的子目录结构（版本、备份）一并搬过来。
 *
 * 冲突判定按「扩展名归一后的逻辑名」：目标已有 `foo.dwf.ts` 时，来源的 `foo.workflow.js`
 * 视为同一个工作流的另一代定义，同样跳过——否则两代会并存并在按名查找时互相覆盖。
 */
const WORKFLOWS_DIR_REL = ["workflows"] as const;
const WORKFLOW_SUFFIXES = [".dwf.ts", ".workflow.js"] as const;

/** 归一后的逻辑名；非工作流文件返回 null。 */
function workflowLogicalName(fileName: string): string | null {
  for (const suffix of WORKFLOW_SUFFIXES) {
    if (fileName.endsWith(suffix) && fileName.length > suffix.length) {
      return fileName.slice(0, -suffix.length);
    }
  }
  return null;
}

interface WorkflowFile {
  name: string;
  logicalName: string;
  sourcePath: string;
}

async function listSourceWorkflows(ctx: MigrationDomainContext): Promise<WorkflowFile[]> {
  const sourceDir = resolveDomainPath(ctx.sourceRootPath, WORKFLOWS_DIR_REL);
  let entries;
  try {
    entries = await readdir(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return [];
    throw error;
  }
  const files: WorkflowFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const logicalName = workflowLogicalName(entry.name);
    if (!logicalName) continue;
    files.push({ name: entry.name, logicalName, sourcePath: path.join(sourceDir, entry.name) });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

/** 目标目录里已存在的「逻辑名」集合（含两代扩展名）。 */
async function listTargetLogicalNames(ctx: MigrationDomainContext): Promise<Set<string>> {
  const targetDir = resolveDomainPath(ctx.targetRootPath, WORKFLOWS_DIR_REL);
  let entries;
  try {
    entries = await readdir(targetDir, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return new Set();
    throw error;
  }
  const names = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const logicalName = workflowLogicalName(entry.name);
    if (logicalName) names.add(logicalName);
  }
  return names;
}

async function scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary> {
  const files = await listSourceWorkflows(ctx);
  const targetNames = await listTargetLogicalNames(ctx);
  let bytes = 0;
  let conflictCount = 0;
  for (const file of files) {
    bytes += await fileSizeOrZero(file.sourcePath);
    if (targetNames.has(file.logicalName)) conflictCount += 1;
  }
  return {
    id: "workflows",
    available: files.length > 0,
    itemCount: files.length,
    bytes,
    conflictCount,
    defaultSelected: true,
    skipReason: files.length > 0 ? undefined : "来源没有这项数据",
    note: "同名（含两代扩展名归一）跳过",
  };
}

async function migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult> {
  const files = await listSourceWorkflows(ctx);
  if (files.length === 0) {
    return {
      id: "workflows",
      status: "skipped",
      imported: 0,
      skipped: 0,
      failed: 0,
      details: ["来源没有这项数据"],
    };
  }
  const targetDir = resolveDomainPath(ctx.targetRootPath, WORKFLOWS_DIR_REL);
  const targetNames = await listTargetLogicalNames(ctx);
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const details: string[] = [];
  for (const file of files) {
    if (targetNames.has(file.logicalName)) {
      skipped += 1;
      details.push(`工作流 ${file.name} 已存在同名工作流，跳过`);
      continue;
    }
    try {
      await mkdir(targetDir, { recursive: true });
      await copyFile(file.sourcePath, path.join(targetDir, file.name));
      // 立刻登记逻辑名：来源同时留有同名两代定义（`foo.dwf.ts` + `foo.workflow.js`）时，
      // 只收先到的那一个。files 按文件名排序，`.dwf.ts` 排在 `.workflow.js` 之前，
      // 因此保留的是当前一代；否则两代会在目标并存，按名查找时互相覆盖。
      targetNames.add(file.logicalName);
      imported += 1;
    } catch (error) {
      failed += 1;
      details.push(`工作流 ${file.name} 复制失败：${errorMessage(error)}`);
    }
  }
  if (imported === 0 && failed === 0) {
    details.push(`${skipped} 项已存在，全部跳过`);
  }
  return {
    id: "workflows",
    status: failed > 0 && imported === 0 ? "failed" : "done",
    imported,
    skipped,
    failed,
    details: capDetails(details),
  };
}

export const workflowsDomain: MigrationDomainOps = { scan, migrate };
