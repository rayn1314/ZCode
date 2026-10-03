import { readFile } from "node:fs/promises";
import { credentialRecordSchema } from "@zcode/shared";
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
 * 登录凭据。
 *
 * 不整文件覆盖：源文件是密文，但两代密钥派生的**输入虽同源**（机器派生密钥不含产品身份），
 * 直接抄文件仍然绕过了目标侧服务的写入路径。这里逐 key 读源密文 → 解密 → 目标
 * `credentialService.save` 重新加密落盘，保证目标时间读得到明文且不会双重加密。
 *
 * 目标已有的 key 一律跳过（凭据属于账号安全面，跨身份覆盖等于替用户切换登录态）。
 */
const CREDENTIALS_REL = ["v2", "credentials.json"] as const;

function sourcePath(ctx: MigrationDomainContext): string {
  return resolveDomainPath(ctx.sourceRootPath, CREDENTIALS_REL);
}

async function readSourceEntries(filePath: string): Promise<Array<[string, string]> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  // 损坏的源必须整体失败：逐 key 尽力而为会把「读不出来」伪装成「没有可迁移项」。
  const parsed = credentialRecordSchema.parse(JSON.parse(raw));
  return Object.entries(parsed);
}

async function scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary> {
  const filePath = sourcePath(ctx);
  let entries: Array<[string, string]> | null;
  try {
    entries = await readSourceEntries(filePath);
  } catch {
    return {
      id: "credentials",
      available: false,
      itemCount: 0,
      bytes: 0,
      conflictCount: 0,
      defaultSelected: false,
      skipReason: "来源 credentials.json 损坏，无法读取",
    };
  }
  if (!entries || entries.length === 0) {
    return {
      id: "credentials",
      available: false,
      itemCount: 0,
      bytes: 0,
      conflictCount: 0,
      defaultSelected: false,
      skipReason: "来源没有这项数据",
    };
  }
  let conflictCount = 0;
  for (const [key] of entries) {
    if (await hasTargetValue(ctx, key)) {
      conflictCount += 1;
    }
  }
  return {
    id: "credentials",
    available: true,
    itemCount: entries.length,
    bytes: await fileSizeOrZero(filePath),
    conflictCount,
    defaultSelected: false,
    note: "凭据经解密后在目标身份重新加密；目标已有的 key 跳过",
  };
}

async function hasTargetValue(ctx: MigrationDomainContext, key: string): Promise<boolean> {
  try {
    return (await ctx.deps.credentialService.load(key)) !== null;
  } catch {
    // 目标凭据库损坏：读不出也绝不能当「不存在」去覆盖。
    return true;
  }
}

async function migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult> {
  const entries = await readSourceEntries(sourcePath(ctx));
  if (!entries || entries.length === 0) {
    return {
      id: "credentials",
      status: "skipped",
      imported: 0,
      skipped: 0,
      failed: 0,
      details: ["来源没有这项数据"],
    };
  }
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  const details: string[] = [];
  for (const [key, value] of entries) {
    if (await hasTargetValue(ctx, key)) {
      skipped += 1;
      continue;
    }
    try {
      const plaintext = ctx.deps.cipher.decrypt(value);
      await ctx.deps.credentialService.save(key, plaintext);
      imported += 1;
    } catch (error) {
      failed += 1;
      details.push(`凭据 ${key} 写入失败：${errorMessage(error)}`);
    }
  }
  if (imported === 0 && failed === 0) {
    details.push(`${skipped} 项已存在，全部跳过`);
  }
  return {
    id: "credentials",
    status: failed > 0 && imported === 0 ? "failed" : "done",
    imported,
    skipped,
    failed,
    details: capDetails(details),
  };
}

export const credentialsDomain: MigrationDomainOps = { scan, migrate };
