import { existsSync, readFileSync } from "node:fs";
import {
  getBootstrapSettingsCandidateFiles,
  getDataBaseDir,
  getDataRootDirForBaseDir,
  setDataBaseDir,
  setDataRootDir,
} from "@zcode/services/node";
import { ZCODE_DATA_ROOT_SUFFIX } from "@zcode/shared";

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

/**
 * 读取链：身份文件优先，修复前遗留的官方共享文件兜底（见 paths.getBootstrapSettingsCandidateFiles）。
 *
 * 值级回退：身份文件里 dataBaseDir 为空（或文件不存在/读不通）时继续看下一个候选，
 * 否则旧用户自定义的数据根会“消失”——数据还在磁盘上，但启动时按默认 home 找。
 */
function readBootstrapDataBaseDirFromDisk(
  candidates: readonly string[] = getBootstrapSettingsCandidateFiles(),
): string | null {
  for (const settingsFile of candidates) {
    if (!existsSync(settingsFile)) {
      continue;
    }

    try {
      const dataBaseDir = extractBootstrapDataBaseDir(
        JSON.parse(readFileSync(settingsFile, "utf-8")),
      );
      if (dataBaseDir) {
        return dataBaseDir;
      }
    } catch {
      // bootstrap 阶段只读不修：坏文件按“该候选为空”处理，继续看下一个候选。
    }
  }

  return null;
}

/**
 * 产品身份数据根。
 *
 * 上游两条官方渠道的后缀为空串，路径与历史完全一致。下游自建客户端覆盖了产品名或 appId
 * （见 scripts/product-identity.mjs），就必须与官方客户端各用各的数据根：共用
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
  setDataRootDir(getDataRootDirForBaseDir(getDataBaseDir()));
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
