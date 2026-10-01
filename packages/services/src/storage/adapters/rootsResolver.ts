/**
 * 数据根解析：R1 = 家目录下的产品身份数据根（`.zcode{suffix}`，永远存在），R2 = 自定义数据存储路径下的同款数据根
 * （仅当设置了且 ≠ 家目录）。路径来源由调用方注入（desktop host 传 homedir 与 getDataBaseDir），
 * 模块内不读环境变量；后缀是编译期产品身份常量——自建版必须扫自己的 `.zcode-rayn`，
 * 否则「资源管理器 → 存储」会扫到官方数据，清理时删错人的文件。
 */
import { resolve } from "node:path";
import type { RootsResolverPort } from "../app/ports.js";
import type { StorageRootSpec } from "@zcode/shared";
import { getDataRootDirForBaseDir } from "../../paths.js";

export function resolveStorageRoots(params: {
  homeDir: string;
  dataBaseDir: string;
}): StorageRootSpec[] {
  const home = resolve(params.homeDir);
  const dataBase = resolve(params.dataBaseDir);
  const hasCustomDataBaseDir = dataBase !== home;
  const roots: StorageRootSpec[] = [
    { id: "home", path: getDataRootDirForBaseDir(home), hasCustomDataBaseDir },
  ];
  if (hasCustomDataBaseDir) {
    roots.push({
      id: "dataBaseDir",
      path: getDataRootDirForBaseDir(dataBase),
      hasCustomDataBaseDir,
    });
  }
  return roots;
}

export function createStorageRootsResolver(params: {
  getHomeDir: () => string;
  getDataBaseDir: () => string;
}): RootsResolverPort {
  return {
    resolveRoots: async () =>
      resolveStorageRoots({ homeDir: params.getHomeDir(), dataBaseDir: params.getDataBaseDir() }),
  };
}
