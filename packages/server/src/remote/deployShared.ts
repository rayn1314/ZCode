import { join } from "node:path";
import { access } from "node:fs/promises";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  SESSION_MAILBOX_DIR_NAME,
  SESSION_MAILBOX_ROOT_ENV,
  ZCODE_DATA_ROOT_SUFFIX,
} from "@zcode/shared";
import type { StdioStream } from "@zcode/server/remote/backend.js";
import { quotePosixPathArg } from "@zcode/server/remote/posixShell.js";
import type { RemoteAssetNetworkPort } from "@zcode/server/remote/remoteAssetNetwork.js";

/**
 * 远端 Server 代码安装根：按产品身份后缀隔离。
 *
 * 与本地数据根同源（ZCODE_DATA_ROOT_SUFFIX）：官方空串 → 保持历史路径 `~/.zcode/server`；
 * 自建（如 `-rayn`）→ `~/.zcode/server-rayn`。这样并排的两个产品各跑各的 node / server bundle /
 * agents / tools / asset-cache / 部署锁，不会互相覆盖或出现「客户端比远端 Server 新」的能力错配。
 *
 * 远端数据根同样按后缀隔离（2026-09-30 起）：代码隔离挡不住 schema 错配——自建 server 写进
 * 共享 provider 配置的新字段，会让读同一份文件的官方 server 在 strict 校验上直接失败。
 * 派生规则与失败语义见 `packages/server/spec/remote-runtime-isolation.md`。
 */
const REMOTE_SERVER_BASE_SUFFIX = ZCODE_DATA_ROOT_SUFFIX.trim();
export const REMOTE_BASE = `~/.zcode/server${REMOTE_SERVER_BASE_SUFFIX}`;
/** `ZCODE_SERVER_RUNTIME_ROOT` 的赋值形式：双引号内 `~` 不展开，必须用 `$HOME`。 */
export const REMOTE_SERVER_RUNTIME_ROOT = `$HOME/.zcode/server${REMOTE_SERVER_BASE_SUFFIX}`;

/**
 * 远端数据根的 env 赋值（`ZCODE_DATA_ROOT="$HOME/.zcode<suffix>"`）。
 *
 * 纯函数派生以便契约测试覆盖官方 / 自建两个分支；仅自建（非空后缀）返回赋值，
 * 官方返回 null——不注入时远端 server / agent 回落 `~/.zcode`，命令行与历史逐字节一致。
 * agent 由 server 全量继承进程 env，无需单独注入。
 */
export function deriveRemoteDataRootEnvAssignment(dataRootSuffix: string): string | null {
  const suffix = dataRootSuffix.trim();
  if (!suffix) {
    return null;
  }
  return `ZCODE_DATA_ROOT="$HOME/.zcode${suffix}"`;
}

export const REMOTE_DATA_ROOT_ENV_ASSIGNMENT =
  deriveRemoteDataRootEnvAssignment(ZCODE_DATA_ROOT_SUFFIX);

/**
 * 远端 mailbox 落盘根的 env 赋值（`ZCODE_MAILBOX_ROOT="$HOME/.zcode<suffix>/mailbox"`）。
 *
 * 与远端数据根同源派生：mailbox 是「同机兜底」的传输通道，必须和远端 server/agent 的数据根
 * 落在同一棵树，否则实时投递与 drain 各写一份。
 *
 * 官方（空后缀）返回 null，与上面的 `deriveRemoteDataRootEnvAssignment` 保持同一约定（这是
 * 部署命令的既有形态，不能逐字节漂移）。这里不担心「靠子进程推导」：同一条启动命令里的
 * `ZCODE_DATA_ROOT` 就是推导输入本身——两边输入是同一个赋值，不存在本地 spawn env 那种
 * 「宿主 baseDir 与子进程 home 各自不同」的空隙。
 */
export function deriveRemoteMailboxRootEnvAssignment(dataRootSuffix: string): string | null {
  const suffix = dataRootSuffix.trim();
  if (!suffix) {
    return null;
  }
  return `${SESSION_MAILBOX_ROOT_ENV}="$HOME/.zcode${suffix}/${SESSION_MAILBOX_DIR_NAME}"`;
}

export const REMOTE_MAILBOX_ROOT_ENV_ASSIGNMENT =
  deriveRemoteMailboxRootEnvAssignment(ZCODE_DATA_ROOT_SUFFIX);

/**
 * 远端 server 启动命令的固定 env 赋值段（白名单透传之前的部分）。
 * 单点构造，保证「部署基址」与「运行时数据根」由同一常量派生。
 */
export function buildRemoteServerBaseEnvAssignments(): string[] {
  const assignments = [
    `${SERVICE_AUTHORITY_MODE_ENV}="desktop-attached-remote"`,
    `ZCODE_SERVER_RUNTIME_ROOT="${REMOTE_SERVER_RUNTIME_ROOT}"`,
  ];
  if (REMOTE_DATA_ROOT_ENV_ASSIGNMENT) {
    assignments.push(REMOTE_DATA_ROOT_ENV_ASSIGNMENT);
  }
  if (REMOTE_MAILBOX_ROOT_ENV_ASSIGNMENT) {
    assignments.push(REMOTE_MAILBOX_ROOT_ENV_ASSIGNMENT);
  }
  return assignments;
}

export interface RemoteAssetDeployOptions {
  /** 取消当前连接初始化；共享 cache 仍可独立完成，但不得继续写入远端 staging。 */
  signal?: AbortSignal;
  releaseDir?: string | null;
  resolveReleaseDir?: (
    componentIds?: string[],
    options?: { forceRefresh?: boolean },
  ) => Promise<string | null>;
  resolveComponentSha256?: (componentId: string) => Promise<string | null>;
  remoteCdnBaseUrl?: string;
  remoteCdnBaseUrls?: string[];
  remoteCacheDir?: string;
  manifestRequestTimeoutMs?: number;
  remoteAssetNetwork?: RemoteAssetNetworkPort;
}

export interface DeployLoggers {
  log: (...args: unknown[]) => void;
  logWarn: (...args: unknown[]) => void;
}

export async function fileExists(...pathParts: string[]): Promise<boolean> {
  const fullPath = join(...pathParts);
  try {
    await access(fullPath);
    return true;
  } catch {
    return false;
  }
}

export async function resolveFirstExistingPath(candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function formatOptionalValue(value?: string): string {
  return value && value.trim().length > 0 ? value : "<empty>";
}

export function formatOptionalValues(values?: string[]): string {
  const normalizedValues = values?.map((value) => value.trim()).filter((value) => value.length > 0);
  return normalizedValues && normalizedValues.length > 0 ? normalizedValues.join(", ") : "<empty>";
}

export function buildRemoteMoveCommand(sourcePath: string, targetPath: string): string {
  // 部分远端 shell 会把 mv 定义成 alias/function（例如 mv -i）。
  // 部署通过非交互 SSH exec 执行时，覆盖确认没人输入会卡死；这里用 command 绕过 alias/function，
  // 同时加 -f 明确强制覆盖，保证临时文件替换不会等待交互确认。
  return `command mv -f ${quotePosixPathArg(sourcePath)} ${quotePosixPathArg(targetPath)}`;
}

export function buildRemoteChmodExecutableCommand(filePath: string): string {
  // 和 mv 一样，chmod 也可能被远端 shell 自定义；用 command 确保调用真实命令。
  return `command chmod +x ${quotePosixPathArg(filePath)}`;
}

export function buildRemoteExecutableReplaceCommand(
  sourcePath: string,
  targetPath: string,
): string {
  return `${buildRemoteChmodExecutableCommand(sourcePath)} && ${buildRemoteMoveCommand(sourcePath, targetPath)}`;
}

export function createRemoteAssetPlaceholderError(
  platformArch: string,
  options: RemoteAssetDeployOptions,
  resourceLabel: string,
): Error {
  // 远端部署资源在生产态需要走 CDN + 本地缓存。
  // 如果这里仍然只报“本地文件缺失”，排障时会误判成打包漏文件；
  // 统一把错误指向配置（CDN 基址/缓存目录）和缓存内容，避免定位方向跑偏。
  return new Error(
    `[deploy] ${resourceLabel} missing for ${platformArch}. ` +
      `Development should read from mock-cdn/releases; production should download and cache remote assets from CDN ` +
      `(remoteCdnBaseUrl=${formatOptionalValue(options.remoteCdnBaseUrl)}, remoteCdnBaseUrls=${formatOptionalValues(options.remoteCdnBaseUrls)}, remoteCacheDir=${formatOptionalValue(options.remoteCacheDir)}).`,
  );
}

export function waitForClose(stream: StdioStream): Promise<void> {
  return new Promise((resolve, reject) => {
    let stderrText = "";
    stream.stderr.on("data", (chunk: Buffer | string) => {
      if (stderrText.length >= 2048) {
        return;
      }
      stderrText += chunk.toString();
    });

    stream.onClose((code) => {
      // 之前只等待 close 不校验退出码，远端命令失败会被当成成功继续执行。
      // 这会导致部署链路把失败写成“已完成”（甚至继续写 version），形成假成功状态。
      if (code !== 0) {
        const stderrSummary = stderrText.trim();
        reject(
          new Error(
            stderrSummary.length > 0
              ? `[deploy] remote command failed with exit code ${code}: ${stderrSummary}`
              : `[deploy] remote command failed with exit code ${code}`,
          ),
        );
        return;
      }
      resolve();
    });
  });
}
