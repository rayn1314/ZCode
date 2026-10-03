import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getAppConfigDir,
  getDataRootDirForBaseDir,
  getZCodeDataRootDir,
  setDataBaseDir,
  setDataRootDir,
} from "../../src/paths.js";

/**
 * 钉在临时目录里的数据根。离开作用域时自动恢复进程指针并删除临时目录。
 *
 * 用显式资源管理（`await using`）而不是 try/finally：释放按声明逆序执行，声明在它之后的
 * runtime / repo 会先于临时目录被清理。Windows 上目录里存在未关闭的文件句柄时删除会失败，
 * 逆序释放正好消掉这个顺序陷阱。规则见 `packages/services/spec/test-data-root-isolation.md`。
 */
export class SealedDataRoot {
  constructor(readonly baseDir: string) {}

  /** 按身份后缀推导的数据根，与真实宿主同一规则（不手写 `join(base, ".zcode")`）。 */
  get dataRoot(): string {
    return getDataRootDirForBaseDir(this.baseDir);
  }

  /** `{dataRoot}/v2`，与生产一致。 */
  get configDir(): string {
    return getAppConfigDir();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    setDataRootDir(null);
    setDataBaseDir(null);
    // 测试会留下稍后被回收的句柄（如 SQLite 的 -wal），Windows 上删除可能瞬时失败。
    await rm(this.baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}

/**
 * 把本进程的数据根钉在临时目录里，供测试写入 provider 配置、task 快照、Project Memory 等。
 *
 * 不能只用 `setDataBaseDir()`：数据根解析顺序是
 * `setDataRootDir > ZCODE_DATA_ROOT(env) > {dataBaseDir}/.zcode`，而宿主 shell 天然带
 * `ZCODE_DATA_ROOT`（ZCode 会话本身就是宿主进程的子进程），只设 base dir 会让封根失效、
 * 测试直接读写真实用户数据根。这里改用优先级更高的 `setDataRootDir()` 封根。
 *
 * 用法：`await using root = await sealDataRoot("zcode-xxx-");`
 */
export async function sealDataRoot(prefix: string): Promise<SealedDataRoot> {
  const sealed = new SealedDataRoot(await mkdtemp(join(tmpdir(), prefix)));
  setDataBaseDir(sealed.baseDir);
  setDataRootDir(sealed.dataRoot);
  const resolved = getZCodeDataRootDir();
  if (resolved !== sealed.dataRoot) {
    // 宁可测试红，也不能带着"以为封住了"的状态去写真实用户数据。
    await sealed[Symbol.asyncDispose]();
    throw new Error(`数据根未封住：解析到 ${resolved}，本次测试会写真实用户数据`);
  }
  return sealed;
}
