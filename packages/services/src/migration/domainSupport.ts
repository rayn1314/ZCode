import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { ISettingService } from "../setting/setting.js";
import type { ICredentialService } from "../credential/credential.js";
import type { CredentialCipherProvider } from "../credential/providers/credentialCipherProvider.js";
import type {
  MigrationDomainId,
  MigrationDomainResult,
  MigrationDomainSummary,
} from "./migration.js";

/** details 每条数上限：RPC payload 不能随来源条目数线性膨胀。 */
export const MIGRATION_DETAILS_LIMIT = 50;

export interface MigrationServiceDeps {
  /** 用户 home：探测其它身份数据根用（不跟随 dataBaseDir）。 */
  homeDir: string;
  env: Record<string, string | undefined>;
  appDataDir?: string;
  /** 当前身份数据根：所有域的目标根。 */
  dataRootDir: string;
  settingService: ISettingService;
  credentialService: ICredentialService;
  /** 源凭据解密用；由外部注入以便测试（缺省同机器派生密钥，不含产品身份）。 */
  cipher: CredentialCipherProvider;
  existsImpl?: typeof existsSync;
}

export interface MigrationDomainContext {
  sourceRootPath: string;
  targetRootPath: string;
  deps: MigrationServiceDeps;
}

/** 一个迁移域：扫描（只读）+ 迁移（写目标）。 */
export interface MigrationDomainOps {
  scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary>;
  migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult>;
}

/**
 * 把白名单相对路径归一到根内绝对路径，拒绝路径穿越。
 * relSegments 全部是各域写死的常量；这里仍强校验，避免后续有人把外部输入拼进来。
 */
export function resolveDomainPath(rootPath: string, relSegments: readonly string[]): string {
  const root = path.resolve(rootPath);
  const target = path.resolve(root, ...relSegments);
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`拒绝路径穿越：${relSegments.join("/")}`);
  }
  return target;
}

export function fileExistsSync(filePath: string): boolean {
  return existsSync(filePath);
}

export async function fileSizeOrZero(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

/** 读 JSON 并保证顶层是对象；文件不存在返回 null，损坏或非对象抛错（由域决定失败语义）。 */
export async function readJsonObjectFile(
  filePath: string,
): Promise<Record<string, unknown> | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path.basename(filePath)} 顶层不是对象`);
  }
  return parsed as Record<string, unknown>;
}

export function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function skippedResult(
  id: MigrationDomainId,
  itemCount: number,
  reason: string,
): MigrationDomainResult {
  return {
    id,
    status: "skipped",
    imported: 0,
    skipped: itemCount,
    failed: 0,
    details: [reason],
  };
}

/** 统一的 details 截断出口，保证任何域返回的明细都不超过 50 条。 */
export function capDetails(details: readonly string[]): string[] {
  return details.length > MIGRATION_DETAILS_LIMIT
    ? details.slice(0, MIGRATION_DETAILS_LIMIT)
    : [...details];
}
