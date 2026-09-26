import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDataBaseDir, setDataBaseDir, setDataRootDir } from "@zcode/services/node";
import { ZCODE_DATA_ROOT_SUFFIX } from "@zcode/shared";

function resolveBootstrapSettingsFile(homePath: string = homedir()): string {
  return join(homePath, ".zcode", "v2", "setting.json");
}

function extractBootstrapDataBaseDir(rawValue: unknown): string | null {
  if (!rawValue || typeof rawValue !== "object") {
    return null;
  }

  const dataBaseDir = (rawValue as { dataBaseDir?: unknown }).dataBaseDir;
  if (typeof dataBaseDir !== "string") {
    return null;
  }

  const trimmed = dataBaseDir.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function readBootstrapDataBaseDirFromDisk(
  settingsFile: string = resolveBootstrapSettingsFile(),
): string | null {
  if (!existsSync(settingsFile)) {
    return null;
  }

  try {
    const raw = readFileSync(settingsFile, "utf-8");
    return extractBootstrapDataBaseDir(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * 产品身份数据根。
 *
 * 上游两条官方渠道的后缀为空串，路径与历史完全一致。下游自建客户端覆盖了产品名或 appId
 * （见 desktop-product-identity.mjs），就必须与官方客户端各用各的数据根：共用
 * `{dataBaseDir}/.zcode` 会让两个客户端读写同一个会话库、凭据和设置，会话列表互相可见，
 * 还会并发写同一个 SQLite。
 *
 * 必须在这里落地而非更晚：logger 与 crashReporter 紧随本模块之后按数据根建目录，
 * 晚了它们会先落到默认根，出现两套日志与崩溃现场。
 */
function applyIdentityDataRoot(): void {
  if (!ZCODE_DATA_ROOT_SUFFIX) {
    return;
  }
  setDataRootDir(join(getDataBaseDir(), `.zcode${ZCODE_DATA_ROOT_SUFFIX}`));
}

export function applyEarlyDataBaseDirBootstrap(): string | null {
  const dataBaseDir = readBootstrapDataBaseDirFromDisk();
  if (dataBaseDir) {
    // 启动早期就把 dataBaseDir 注入进来，避免 logger / crashReporter 先按默认 HOME 建目录，
    // 导致后续再切换到自定义目录时，日志和 crash dump 落在两套路径里。
    setDataBaseDir(dataBaseDir);
  }
  // 必须先应用 dataBaseDir（用户可能把数据放在自定义盘），再拼身份后缀。
  applyIdentityDataRoot();
  return dataBaseDir;
}
