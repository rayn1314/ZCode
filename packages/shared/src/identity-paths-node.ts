// 身份路径派生（node 侧单一实现）。
//
// 为什么单列一个文件：并排安装两个产品身份时，"某个目录该落哪"这个判断曾在四处各写一遍
// （CLI contracts、services paths、CLI bootstrap 的 mailbox 解析、Host services 的 mailbox
// 解析）。每多一处就多一次「自建构建写进官方根」的机会——2026-10-03 实测：自建版收到的
// 会话消息被写进官方 `~/.zcode/mailbox`，两个产品身份共用同一棵收件箱树。
// 这里收口成一组纯函数：调用方只负责**提供自己已知的事实**（显式覆盖值、baseDir、config），
// 规则本身不再重复。
//
// 本文件引 node:os / node:path，因此**不进 src/index.ts 桶文件**（桶被 renderer 侧消费）；
// 消费方按子路径 `@zcode/shared/identity-paths-node` 引入。

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ZCODE_DATA_ROOT_SUFFIX } from "./env.js";
import { SESSION_MAILBOX_DIR_NAME, SESSION_MAILBOX_ROOT_ENV } from "./session-mailbox.js";

/** 用户安全区目录名（hook 信任库等权限边界的落点）。 */
export const ZCODE_SECURITY_DIR_NAME = "security";
/** workspace hook 信任库文件名。 */
export const WORKSPACE_HOOK_TRUST_STORE_FILE_NAME = "workspace-hook-trust-v1.json";

export interface ExpandUserPathOptions {
  /** `~` / `~/` 的展开基准；缺省 `os.homedir()`。 */
  homeDir?: string;
  /**
   * 既不是 `~` 也不是绝对路径时的基准目录；缺省进程 cwd。
   *
   * 权限边界类路径（user config 的 `storage.dir`）必须显式传 home：相对路径若按 cwd 解析，
   * 同一条配置在不同启动目录下会指向不同的信任库，等于把权限判定的落点交给启动目录。
   * 旧实现（CLI 与 services 两侧）都是 `resolve(home, ...)`，这里必须与之一致。
   */
  relativeBaseDir?: string;
}

/**
 * `~` 展开：`~` 与 `~/`（含 `~\`）前缀按 home 展开，绝对路径归一，其余相对路径按
 * `relativeBaseDir`（缺省进程 cwd）解析。
 *
 * 各进程历史上各写一份等价实现，且对环境变量的 trim 行为还不一致；统一走这里。
 */
export function expandUserPath(value: string, options: ExpandUserPathOptions = {}): string {
  const trimmed = value.trim();
  const homeDir = options.homeDir ?? homedir();
  if (trimmed === "~") return homeDir;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return join(homeDir, trimmed.slice(2));
  }
  return options.relativeBaseDir ? resolve(options.relativeBaseDir, trimmed) : resolve(trimmed);
}

/**
 * 身份数据根在给定 base dir 下的位置：`{baseDir}/.zcode{suffix}`。
 *
 * 官方渠道后缀为空串（路径与历史一致）；自建客户端按产品身份加后缀，与官方并排安装时
 * 各用各的会话库、凭据和设置。所有「从 base dir 推到数据根」的地方都必须走这里。
 */
export function getIdentityDataRootForBaseDir(baseDir: string): string {
  return join(baseDir, `.zcode${ZCODE_DATA_ROOT_SUFFIX}`);
}

export interface IdentityDataRootInput {
  /** 显式数据根：`ZCODE_DATA_ROOT` 或进程内 `setDataRootDir()` 的值。 */
  explicitRoot?: string | null;
  /** 数据根父目录：`ZCODE_DATA_BASE_DIR` 或进程内 `setDataBaseDir()` 的值；缺省 home。 */
  baseDir?: string | null;
  /** 缺省 `os.homedir()`；仅为测试注入。 */
  homeDir?: string;
}

/**
 * 身份数据根（`.zcode{suffix}` 目录本身），总是绝对路径。
 *
 * 优先级：显式数据根 > `{baseDir}/.zcode{suffix}`；baseDir 缺省 home。
 * 参数收的是**值**而不是 env 对象：services 侧在模块加载时冻结 env（避免后台任务读到切换后的
 * 环境），这里必须允许它把自己冻结的值传进来，而不是再读一次 process.env。
 */
export function resolveIdentityDataRoot(input: IdentityDataRootInput = {}): string {
  const homeDir = input.homeDir ?? homedir();
  const explicit = input.explicitRoot?.trim();
  if (explicit) return expandUserPath(explicit, { homeDir });
  const baseDir = input.baseDir?.trim();
  return getIdentityDataRootForBaseDir(baseDir ? expandUserPath(baseDir, { homeDir }) : homeDir);
}

export interface SessionMailboxRootInput {
  /** 本进程解析出的身份数据根（CLI `resolveZCodeDataRoot` / Host `getZCodeDataRootDir`）。 */
  dataRootDir: string;
  /** 缺省 `process.env`；仅为测试注入。 */
  env?: Record<string, string | undefined>;
  /** 缺省 `os.homedir()`；仅为测试注入。 */
  homeDir?: string;
}

/**
 * 会话 mailbox 落盘根：`ZCODE_MAILBOX_ROOT` 显式覆盖优先，否则 `{dataRoot}/mailbox`。
 *
 * 必须跟随身份数据根，不能固定 `~/.zcode`：信封正文就是会话内容，落在共享根会让并排安装的
 * 另一个产品身份读到不属于它的消息。显式覆盖只用于测试与排障，正常部署不设置。
 *
 * 跨机不可共享（Windows 与 WSL 是两个文件系统），因此 mailbox 只承诺**同机**兜底；
 * 跨机投递靠实时路由，不能靠这里落盘。
 */
export function resolveSessionMailboxRoot(input: SessionMailboxRootInput): string {
  const env = input.env ?? process.env;
  const homeDir = input.homeDir ?? homedir();
  const configured = env[SESSION_MAILBOX_ROOT_ENV]?.trim();
  if (configured) return expandUserPath(configured, { homeDir });
  return join(input.dataRootDir, SESSION_MAILBOX_DIR_NAME);
}

export interface WorkspaceHookTrustStoreRootInput {
  /** 本进程解析出的身份数据根。信任库跟随 hooks **声明**所在的数据根。 */
  dataRootDir: string;
  /** CLI `cli/config.json` 的 `storage.dir`：用户显式改过数据根时仍以它为准。 */
  storageDirOverride?: string | null;
  /** 缺省 `os.homedir()`；仅为测试注入。同时是 `storage.dir` 相对路径的解析基准。 */
  homeDir?: string;
}

/**
 * workspace hook 信任库根目录。
 *
 * hook 信任记录是**权限边界**（未授权的声明会被 Runtime 硬拦截），必须与 hooks 声明同源：
 * 声明从 `{dataRoot}/cli/config.json` 读，信任也必须落在同一个身份根下。落在共享的
 * `~/.zcode/security/` 会让一个客户端授予的信任被另一个客户端继承——用户没在那边点过同意，
 * hook 却已经可执行。
 *
 * 用户的 `storage.dir` 覆盖优先（那是用户显式指定的存储根），其中相对路径按 home 解析：
 * 权限落点不能随启动 cwd 漂移。
 */
export function resolveWorkspaceHookTrustStoreRoot(
  input: WorkspaceHookTrustStoreRootInput,
): string {
  const override = input.storageDirOverride?.trim();
  if (!override) return input.dataRootDir;
  const homeDir = input.homeDir ?? homedir();
  return expandUserPath(override, { homeDir, relativeBaseDir: homeDir });
}

/** `{信任库根}/security/workspace-hook-trust-v1.json`。 */
export function resolveWorkspaceHookTrustStoreFilePath(
  input: WorkspaceHookTrustStoreRootInput,
): string {
  return join(
    resolveWorkspaceHookTrustStoreRoot(input),
    ZCODE_SECURITY_DIR_NAME,
    WORKSPACE_HOOK_TRUST_STORE_FILE_NAME,
  );
}
