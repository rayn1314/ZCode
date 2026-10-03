import { decodeProviderConfigFile } from "@zcode/provider-node";
import { readFile } from "node:fs/promises";
import { atomicWriteText } from "../../fs/atomicFileUtils.js";
import type { MigrationDomainResult, MigrationDomainSummary } from "../migration.js";
import {
  errorMessage,
  fileExistsSync,
  fileSizeOrZero,
  isNotFound,
  resolveDomainPath,
  skippedResult,
  type MigrationDomainContext,
  type MigrationDomainOps,
} from "../domainSupport.js";

/**
 * 服务商配置（自定义 provider 与模型规则）。
 *
 * 目标已存在整域跳过：`provider_config.json` 是单文件配置，半合并会破坏 provider/model 规则的
 * 一致性，也没有「按 provider 挑」的语义，因此不做逐项合并。
 */
const PROVIDER_CONFIG_REL = ["v2", "provider_config.json"] as const;

function sourcePath(ctx: MigrationDomainContext): string {
  return resolveDomainPath(ctx.sourceRootPath, PROVIDER_CONFIG_REL);
}

function targetPath(ctx: MigrationDomainContext): string {
  return resolveDomainPath(ctx.targetRootPath, PROVIDER_CONFIG_REL);
}

/**
 * 校验源文件：用 provider-node 的既有文件编解码器（含 schemaVersion 与规则结构的 zod 校验），
 * 与运行时加载同一套口径；不通过就直接失败，绝不写坏目标。
 */
async function readValidatedSource(filePath: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  decodeProviderConfigFile(JSON.parse(raw));
  return raw;
}

async function scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary> {
  const filePath = sourcePath(ctx);
  let valid = false;
  try {
    valid = (await readValidatedSource(filePath)) !== null;
  } catch {
    valid = false;
  }
  if (!valid) {
    return {
      id: "providerConfig",
      available: false,
      itemCount: 0,
      bytes: 0,
      conflictCount: 0,
      defaultSelected: true,
      skipReason: fileExistsSync(filePath)
        ? "来源 provider_config.json 校验失败"
        : "来源没有这项数据",
    };
  }
  const targetExists = fileExistsSync(targetPath(ctx));
  return {
    id: "providerConfig",
    available: true,
    itemCount: 1,
    bytes: await fileSizeOrZero(filePath),
    conflictCount: targetExists ? 1 : 0,
    defaultSelected: true,
    note: targetExists ? "目标已有服务商配置，整域跳过" : undefined,
  };
}

async function migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult> {
  const destination = targetPath(ctx);
  if (fileExistsSync(destination)) {
    return skippedResult("providerConfig", 1, "目标已有 provider_config.json，整域跳过（不覆盖）");
  }
  const source = await readValidatedSource(sourcePath(ctx));
  if (source === null) {
    return skippedResult("providerConfig", 0, "来源没有这项数据");
  }
  try {
    await atomicWriteText(destination, source);
    return {
      id: "providerConfig",
      status: "done",
      imported: 1,
      skipped: 0,
      failed: 0,
      details: [],
    };
  } catch (error) {
    return {
      id: "providerConfig",
      status: "failed",
      imported: 0,
      skipped: 0,
      failed: 1,
      details: [],
      error: errorMessage(error),
    };
  }
}

export const providerConfigDomain: MigrationDomainOps = { scan, migrate };
