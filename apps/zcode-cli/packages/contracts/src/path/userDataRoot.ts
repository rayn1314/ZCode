import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ZCODE_DATA_BASE_DIR_ENV, ZCODE_DATA_ROOT_ENV } from "@zcode/shared";
import { resolveIdentityDataRoot } from "@zcode/shared/identity-paths-node";

/**
 * 数据根整体覆盖 env key：值是 `.zcode{suffix}` 目录本身的完整路径。
 *
 * 桌面端 main 按产品身份注入它，让并排安装的官方客户端与自建客户端各用各的数据根。
 * 键名单点在 `@zcode/shared`（远端部署命令、services 的 spawn env、CLI 读取端必须拼写同源），
 * 这里只做 re-export 维持 contracts 既有 import 路径，不再自备字面量。
 */
export { ZCODE_DATA_ROOT_ENV };

/**
 * 数据根父目录覆盖 env key：值是 `.zcode{suffix}` 的父目录。
 * 桌面端「设置 → 数据存储路径」写的就是它（默认家目录）。同上的单点 re-export。
 */
export { ZCODE_DATA_BASE_DIR_ENV };

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
 * ZCode 用户级数据根（`.zcode{suffix}` 目录本身），总是绝对路径。
 *
 * 并排安装的客户端必须各有独立数据根：共用会让两者的会话列表互相可见，并并发写同一个
 * SQLite。派生规则（后缀取自编译期产品身份常量）已收敛到单源
 * `@zcode/shared/identity-paths-node` 的 `resolveIdentityDataRoot()`——它与
 * `@zcode/services` 的 `getZCodeDataRootDir()` 是同一份实现，本函数只负责把 env 里的覆盖值
 * 取出来传进去（显式数据根 > `{数据根父目录}/.zcode{suffix}`），不再自行拼 `.zcode`。
 */
export function resolveZCodeDataRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  return resolveIdentityDataRoot({
    explicitRoot: env[ZCODE_DATA_ROOT_ENV],
    baseDir: env[ZCODE_DATA_BASE_DIR_ENV],
  });
}
