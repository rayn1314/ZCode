import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 数据根整体覆盖：值是 `.zcode` 目录本身的完整路径。
 *
 * 桌面端 main 按产品身份注入它，让并排安装的官方客户端与自建客户端各用各的数据根。
 */
export const ZCODE_DATA_ROOT_ENV = "ZCODE_DATA_ROOT";

/**
 * 数据根父目录覆盖：值是 `.zcode` 的父目录。
 * 桌面端「设置 → 数据存储路径」写的就是它（默认家目录）。
 */
export const ZCODE_DATA_BASE_DIR_ENV = "ZCODE_DATA_BASE_DIR";

/** 展开 `~`，相对路径按进程 cwd 解析；结果总是绝对路径。 */
export function resolveUserPath(value: string): string {
  if (value === "~") {
    return homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return join(homedir(), value.slice(2));
  }
  return resolve(value);
}

/**
 * ZCode 用户级数据根（`.zcode` 目录本身），总是绝对路径。
 *
 * 并排安装的客户端必须各有独立数据根：共用会让两者的会话列表互相可见，并并发写同一个
 * SQLite。解析顺序必须与 `@zcode/services` 的 `getZCodeDataRootDir()` 保持一致，否则同一份
 * 数据会被两个进程解析到不同目录（例如桌面读新根的凭据、Agent 写旧根的凭据）。
 */
export function resolveZCodeDataRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const explicitRoot = env[ZCODE_DATA_ROOT_ENV]?.trim();
  if (explicitRoot) {
    return resolveUserPath(explicitRoot);
  }
  const baseDir = env[ZCODE_DATA_BASE_DIR_ENV]?.trim() || homedir();
  return join(resolveUserPath(baseDir), ".zcode");
}
