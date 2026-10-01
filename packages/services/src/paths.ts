/* path 规则集中维护：旧 task 快照与 provider 配置路径仍在这里收口。 */
import { existsSync, lstatSync } from "node:fs";
import { cp } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, join, win32 } from "node:path";
import { homedir } from "node:os";
import {
  DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
  ZCODE_DATA_ROOT_ENV,
  ZCODE_DATA_ROOT_SUFFIX,
} from "@zcode/shared";

let _dataBaseDir: string | null = null;
let _dataRootDir: string | null = null;
export const ZCODE_WINDOWS_APP_INSTALL_DIR_ENV = "ZCODE_WINDOWS_APP_INSTALL_DIR";
/** env key 定义在 @zcode/shared（server 远端启动命令与本地 spawn env 同源拼写），此处转出保持既有引用。 */
export { ZCODE_DATA_ROOT_ENV };
const envDataBaseDir = process.env.ZCODE_DATA_BASE_DIR?.trim() || null;
const envDataRootDir = process.env[ZCODE_DATA_ROOT_ENV]?.trim() || null;
const defaultDataBaseDir = process.env.HOME?.trim() || homedir();

interface DataBaseDirTargetValidationOptions {
  platform?: NodeJS.Platform | string;
  env?: Record<string, string | undefined>;
  appInstallDir?: string | null;
}

type DataBaseDirTargetValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: typeof DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE;
      forbiddenDir: string;
    };

/** Set the base directory for app data (replaces homedir() prefix). */
export function setDataBaseDir(dir: string | null): void {
  _dataBaseDir = dir?.trim() || null;
}

/** Get the current base directory. Priority: setDataBaseDir() > env ZCODE_DATA_BASE_DIR > homedir(). */
export function getDataBaseDir(): string {
  if (_dataBaseDir) return _dataBaseDir;
  if (envDataBaseDir) return envDataBaseDir;
  // 服务实例会启动后台刷新任务；若每次调用都动态读取 HOME，
  // 测试或宿主切换环境变量后，旧实例可能把数据写到新实例目录。
  return defaultDataBaseDir;
}

/**
 * Set the app data root outright, bypassing the `{dataBaseDir}/.zcode` layout.
 * 供宿主进程按产品身份定向数据根；子进程通过 ZCODE_DATA_ROOT 继承同一值。
 */
export function setDataRootDir(dir: string | null): void {
  _dataRootDir = dir?.trim() || null;
}

/**
 * 身份数据根在给定 base dir 下的位置：`{baseDir}/.zcode{suffix}`。
 *
 * 官方渠道后缀为空串（路径与历史一致）；自建客户端按产品身份加后缀，与官方并排安装时
 * 各用各的会话库、凭据和设置。所有「从 base dir 推到数据根」的地方都必须走这里，
 * 漏掉后缀就会把自建版的数据写回官方根。
 */
export function getDataRootDirForBaseDir(baseDir: string): string {
  return join(baseDir, `.zcode${ZCODE_DATA_ROOT_SUFFIX}`);
}

/**
 * {dataBaseDir}/.zcode{suffix}
 *
 * 优先返回 setDataRootDir() / ZCODE_DATA_ROOT 指定的完整根：同一台机器上并排安装的
 * 产品身份各有独立数据根，会话库、任务索引、凭据和设置都从这里派生。
 * 两者都没有时按 base dir 拼后缀，保证带身份的构建不会回落到官方根。
 */
export function getZCodeDataRootDir(): string {
  if (_dataRootDir) return _dataRootDir;
  if (envDataRootDir) return envDataRootDir;
  return getDataRootDirForBaseDir(getDataBaseDir());
}

/**
 * 用户 home 解析（不跟随 dataBaseDir）。
 *
 * ZCODE_DESKTOP_HOME_DIR 由独立桌面 Dev 实例注入，优先于常规 HOME：设置指针文件与
 * 用户级资产都固定在 home 下，必须与 Dev 实例的 home 覆盖保持一致，否则 Dev 实例会读到真实用户的设置。
 */
export function resolveUserHomeDir(): string {
  const envHome =
    process.env.ZCODE_DESKTOP_HOME_DIR?.trim() ||
    process.env.HOME?.trim() ||
    process.env.USERPROFILE?.trim();
  return envHome && envHome.length > 0 ? envHome : homedir();
}

/**
 * 用户级 ZCode 目录名：`.zcode{suffix}`（自建版为 `.zcode-rayn`）。
 *
 * 仅用于必须按 home 定位、且按产品身份区分的目录（MCP 用户配置描述符等）；
 * 共享类用户资产（skills/commands/plugins/AGENTS.md）不经过它——CLI 侧写死 `~/.zcode`，
 * 桌面必须同源，否则 UI 与 Agent 看到的内容不一致。
 */
export const ZCODE_USER_DIR_NAME = `.zcode${ZCODE_DATA_ROOT_SUFFIX}`;

/**
 * 设置指针文件所在目录：`{home}/.zcode{suffix}/v2`。
 *
 * setting.json 是 bootstrap 指针：它记录 dataBaseDir（数据根的父目录），所以必须固定在
 * 用户 home 下并按产品身份加后缀，不能跟着 dataBaseDir 走——否则改过数据根的下一次启动
 * 就找不到这个文件，也就找不到数据根。官方渠道后缀为空串，路径与历史完全一致。
 */
export function getBootstrapSettingsDir(): string {
  return join(resolveUserHomeDir(), `.zcode${ZCODE_DATA_ROOT_SUFFIX}`, "v2");
}

/** `{home}/.zcode{suffix}/v2/setting.json`：本产品身份唯一的设置文件，读写都只落这里。 */
export function getBootstrapSettingsFile(): string {
  return join(getBootstrapSettingsDir(), "setting.json");
}

/**
 * bootstrap 读取链：身份文件优先，修复前遗留的官方共享文件兜底。
 *
 * 引入身份后缀之前，自建版把设置写进了官方共享文件 `{home}/.zcode/v2/setting.json`；
 * 用户当时改过的 dataBaseDir 只有那份共享文件知道。身份文件不存在（或字段为空）时必须继续
 * 读共享文件，否则旧用户的数据根会“消失”——数据还在磁盘上，但启动时找不到。
 * 官方渠道两个路径相同，等于只读一个文件，行为不变。
 */
export function getBootstrapSettingsCandidateFiles(): string[] {
  const identityFile = getBootstrapSettingsFile();
  if (!ZCODE_DATA_ROOT_SUFFIX) {
    return [identityFile];
  }
  return [identityFile, join(resolveUserHomeDir(), ".zcode", "v2", "setting.json")];
}

/** 启动早期读取设置的目标文件：身份文件存在就用它，否则用共享兜底文件；都不存在时返回身份文件（读不到即默认值）。 */
export function resolveBootstrapSettingsFileForRead(): string {
  const candidates = getBootstrapSettingsCandidateFiles();
  return candidates.find((candidate) => existsSync(candidate)) ?? getBootstrapSettingsFile();
}

/** 非项目对话共享的真实工作目录；默认 ~/.zcode/workspace/default。 */
export function getConversationWorkspaceDir(): string {
  return join(getZCodeDataRootDir(), "workspace", "default");
}

/** {dataBaseDir}/.zcode/v2 */
export function getAppConfigDir(): string {
  return join(getZCodeDataRootDir(), "v2");
}

function readEnvValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const direct = env[key]?.trim();
  if (direct) {
    return direct;
  }

  const lowerKey = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(env)) {
    if (candidateKey.toLowerCase() !== lowerKey) {
      continue;
    }
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }

  return undefined;
}

function normalizeWindowsComparablePath(pathValue: string): string | null {
  const trimmed = pathValue.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = win32.normalize(trimmed).replace(/[\\/]+$/, "");
  if (!normalized) {
    return null;
  }

  return win32
    .resolve(normalized)
    .replace(/[\\/]+$/, "")
    .toLowerCase();
}

function isWindowsPathEqualOrInside(pathValue: string, rootValue: string): boolean {
  const normalizedPath = normalizeWindowsComparablePath(pathValue);
  const normalizedRoot = normalizeWindowsComparablePath(rootValue);
  if (!normalizedPath || !normalizedRoot) {
    return false;
  }

  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}\\`);
}

function collectWindowsForbiddenAppInstallDirs(
  options: Required<Pick<DataBaseDirTargetValidationOptions, "env">> &
    Pick<DataBaseDirTargetValidationOptions, "appInstallDir">,
): string[] {
  const env = options.env;
  const programFiles = readEnvValue(env, "ProgramFiles");
  const programFilesX86 = readEnvValue(env, "ProgramFiles(x86)");
  const programW6432 = readEnvValue(env, "ProgramW6432");
  const localAppData = readEnvValue(env, "LOCALAPPDATA");
  const candidates = [
    options.appInstallDir,
    readEnvValue(env, ZCODE_WINDOWS_APP_INSTALL_DIR_ENV),
    programFiles ? win32.join(programFiles, "ZCode") : null,
    programFilesX86 ? win32.join(programFilesX86, "ZCode") : null,
    programW6432 ? win32.join(programW6432, "ZCode") : null,
    localAppData ? win32.join(localAppData, "Programs", "ZCode") : null,
  ];
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of candidates) {
    const normalized =
      typeof candidate === "string" ? normalizeWindowsComparablePath(candidate) : null;
    if (!candidate || !normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    result.push(candidate);
  }

  return result;
}

export function validateDataBaseDirTarget(
  targetBaseDir: string,
  options: DataBaseDirTargetValidationOptions = {},
): DataBaseDirTargetValidationResult {
  if ((options.platform ?? process.platform) !== "win32") {
    return { ok: true };
  }

  for (const forbiddenDir of collectWindowsForbiddenAppInstallDirs({
    env: options.env ?? process.env,
    appInstallDir: options.appInstallDir ?? null,
  })) {
    if (isWindowsPathEqualOrInside(targetBaseDir, forbiddenDir)) {
      return {
        ok: false,
        code: DATA_BASE_DIR_FORBIDDEN_WINDOWS_INSTALL_DIR_ERROR_CODE,
        forbiddenDir,
      };
    }
  }

  return { ok: true };
}

export function getExportLogStageDir(): string {
  return join(getZCodeDataRootDir(), "export-log-stage");
}

export function getExportLogDir(): string {
  return join(getZCodeDataRootDir(), "export-log");
}

export function getFeedbackRootDir(): string {
  return join(getZCodeDataRootDir(), "feedback");
}

export function getFeedbackAttachmentDir(): string {
  return join(getFeedbackRootDir(), "attachments");
}

export function getFeedbackLogArchiveDir(): string {
  return join(getFeedbackRootDir(), "logs");
}

export function getGitCheckpointIndexRootDir(): string {
  return join(getZCodeDataRootDir(), "git-checkpoint-index");
}

/** ~/.zcode/v2/tasks-index.sqlite */
export function getTasksIndexDatabasePath(): string {
  return join(getAppConfigDir(), "tasks-index.sqlite");
}

/** workspace 级身份键：远程优先使用 workspaceIdentity，本地回退 workspacePath。 */
function getWorkspaceKey(workspacePath: string, workspaceIdentity?: string): string {
  return workspaceIdentity?.trim() || workspacePath;
}

/** 与 ZCode session 持久化一致：使用 workspaceKey 的 SHA-256 前 12 位 */
export function getWorkspaceHash(workspacePath: string, workspaceIdentity?: string): string {
  return createHash("sha256")
    .update(getWorkspaceKey(workspacePath, workspaceIdentity))
    .digest("hex")
    .slice(0, 12);
}

/** ~/.zcode/v2/sessions/{workspaceHash} */
function getTaskSessionDir(workspacePath: string, workspaceIdentity?: string): string {
  return join(getAppConfigDir(), "sessions", getWorkspaceHash(workspacePath, workspaceIdentity));
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.json */
export function getLegacyTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.json`);
}

/** ~/.zcode/v2/sessions/{workspaceHash}/{taskId}.deleted.json */
export function getLegacyDeletedTaskSessionSnapshotPath(
  workspacePath: string,
  taskId: string,
  workspaceIdentity?: string,
): string {
  return join(getTaskSessionDir(workspacePath, workspaceIdentity), `${taskId}.deleted.json`);
}

/**
 * Copy the identity data directory (`{baseDir}/.zcode{suffix}/v2`) from one base dir to another.
 * Excludes setting.json and its transient atomic-write siblings — bootstrap
 * state must only live at the default homedir location.
 */
export async function copyDataDirectory(oldBaseDir: string, newBaseDir: string): Promise<void> {
  // 按产品身份加后缀：自建客户端只迁移自己的数据根，不能去动官方 {baseDir}/.zcode/v2。
  const oldDir = join(getDataRootDirForBaseDir(oldBaseDir), "v2");
  const newDir = join(getDataRootDirForBaseDir(newBaseDir), "v2");
  await cp(oldDir, newDir, {
    recursive: true,
    force: false,
    filter: (source) => {
      const sourceName = basename(source);
      if (sourceName === "setting.json" || sourceName.startsWith("setting.json.")) {
        // setting.json.lock 和 setting.json.*.tmp 由原子写入短暂创建/删除，
        // 复制过程中扫描到已消失的 lock 会触发 ENOENT，并让数据目录迁移失败。
        // 这些文件都属于 bootstrap 写入中间态，不能迁移到新数据根。
        return false;
      }
      // Windows 非提权环境下 fs.cp 无法复制符号链接（EPERM）。
      // 跳过符号链接可避免 Windows 非提权环境下 fs.cp 报 EPERM。
      try {
        if (lstatSync(source).isSymbolicLink()) return false;
      } catch {
        // lstat 失败时放行，让 cp 自行处理
      }
      return true;
    },
  });
}
