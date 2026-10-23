/**
 * data-roots 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import {
  buildSessionMailboxFileName,
  classifyLedgerRoot,
  discoverMigrationSourceRoots,
  expandUserPath,
  getIdentityDataRootForBaseDir,
  resolveIdentityDataRoot,
  resolveSessionMailboxRoot,
  resolveWorkspaceHookTrustStoreRoot,
  type DataRootsContract,
} from "./contract.js";

/** 契约对象就是这些真实导出，没有包装层。 */
export const exampleDataRoots: DataRootsContract = {
  resolveIdentityDataRoot,
  getIdentityDataRootForBaseDir,
  expandUserPath,
  resolveSessionMailboxRoot,
  resolveWorkspaceHookTrustStoreRoot,
  classifyLedgerRoot,
  discoverMigrationSourceRoots,
  buildSessionMailboxFileName,
};

/**
 * 最常见的一次完整调用：由数据根父目录推出当前身份数据根，再推出 mailbox 落盘根。
 *
 * 注意入参全是**值**：调用方（如 services 侧的 paths 模块）在模块加载时冻结 env，
 * 再把冻结值传进来，规则本身不重读 process.env。
 */
export function exampleMailboxRootForIdentity(
  homeDir: string,
  dataBaseDir?: string,
): { dataRootDir: string; mailboxRootDir: string } {
  const dataRootDir = resolveIdentityDataRoot({ baseDir: dataBaseDir, homeDir });
  return {
    dataRootDir,
    mailboxRootDir: resolveSessionMailboxRoot({ dataRootDir, env: {}, homeDir }),
  };
}

/** 迁移来源探测：只覆盖本机根，官方根排首位，当前身份被排除。 */
export async function exampleMigrationSources(
  homeDir: string,
  currentDataRootPath: string,
): Promise<string[]> {
  const roots = await discoverMigrationSourceRoots({ homeDir, env: {}, currentDataRootPath });
  return roots.map((root) => root.rootPath);
}
