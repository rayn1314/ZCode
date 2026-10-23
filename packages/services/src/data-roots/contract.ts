import type { LedgerSourceVariant } from "@zcode/shared";
import type { DiscoveredDataRoot, DiscoverMigrationSourceRootsInput } from "./machineDataRoots.js";
import type {
  ExpandUserPathOptions,
  IdentityDataRootInput,
  SessionMailboxRootInput,
  WorkspaceHookTrustStoreRootInput,
} from "@zcode/shared/identity-paths-node";

/**
 * data-roots 对外契约：本机「身份数据根」相关的路径解析与探测规则的单源。
 *
 * 存在的意图：并排安装两个产品身份时，「某个目录该落哪」这个判断曾在四处各写一遍
 * （CLI contracts、services paths、CLI bootstrap 的 mailbox 解析、Host services 的 mailbox 解析），
 * 每多一处就多一次「自建构建写进官方根」的机会。本模块把规则收口成一组纯函数，
 * 调用方只负责提供**自己已知的事实**（显式覆盖值、baseDir、config），规则本身不再重复。
 *
 * 三条不变式（细节见各方法注释与 CONTRACT.md）：
 * 1. 优先级恒为「显式数据根 > `{baseDir}/.zcode{suffix}`」，baseDir 缺省 home；
 * 2. 所有派生结果都是绝对路径，`~` 一律按 home 展开，不随进程 cwd 漂移；
 * 3. mailbox 的**落盘根**（node 侧派生）与**文件名规则**（纯字符串、被 `@zcode/shared` 桶导出）
 *    同源：两侧进程读写同一棵树，规则不能各写一份。
 *
 * 本模块所有函数都是纯函数（除 `discoverMigrationSourceRoots` 只读目录）：
 * 不写文件、不发事件、不等待持久化，因此除探测外均可重复调用。
 */

// 真实导出（node 侧派生单源）：身份数据根、`~` 展开、mailbox 根、hook 信任库根。
export {
  expandUserPath,
  getIdentityDataRootForBaseDir,
  resolveIdentityDataRoot,
  resolveSessionMailboxRoot,
  resolveWorkspaceHookTrustStoreFilePath,
  resolveWorkspaceHookTrustStoreRoot,
} from "@zcode/shared/identity-paths-node";
// mailbox 落盘契约的纯字符串部分：文件名与各 id 白名单（不引 node:os / node:path，桶文件可安全导出）。
export {
  SESSION_MAILBOX_DIR_NAME,
  SESSION_MAILBOX_ROOT_ENV,
  buildSessionMailboxFileName,
  isValidSessionMailboxMessageId,
  isValidSessionMailboxSessionId,
  isValidSessionMessageChain,
  sessionMailboxMessageIdSuffix,
} from "@zcode/shared";
// 机器数据根探测：用量账本（多根只读聚合）与身份数据迁移（按域搬运）共同消费同一份结果。
export {
  classifyLedgerRoot,
  detectOfficialRoot,
  discoverMigrationSourceRoots,
  scanSelfRootCandidates,
} from "./machineDataRoots.js";
export type {
  DiscoveredDataRoot,
  DiscoverMigrationSourceRootsInput,
  MachineDataRootEnv,
} from "./machineDataRoots.js";
export type {
  ExpandUserPathOptions,
  IdentityDataRootInput,
  SessionMailboxRootInput,
  WorkspaceHookTrustStoreRootInput,
} from "@zcode/shared/identity-paths-node";

/** 信封文件名构成的入参；`createdAt` 取消息逻辑时间而非落盘时刻，重投时文件名才稳定。 */
export interface SessionMailboxFileNameInput {
  messageId: string;
  createdAt: string;
}

/**
 * 身份数据根的解析与探测契约。一个意图一个方法，全部为纯计算（探测只读目录）。
 */
export interface DataRootsContract {
  /**
   * 身份数据根（`.zcode{suffix}` 目录本身，总是绝对路径）。
   * 前置：参数是**值**（services 侧在模块加载时冻结 env，不能在这里重读 process.env）。
   * 后置：显式根优先且过 `~` 展开；否则 `{baseDir}/.zcode{suffix}`，baseDir 缺省 home。
   * 幂等、无 IO、不发事件、不等待持久化。
   */
  resolveIdentityDataRoot(input?: IdentityDataRootInput): string;
  /**
   * 从 base dir 推到身份数据根：`{baseDir}/.zcode{suffix}`。
   * 后置：后缀来自编译期产品身份；官方渠道为空串，因此路径与历史一致。
   */
  getIdentityDataRootForBaseDir(baseDir: string): string;
  /**
   * `~` / `~/` 展开：`~` 前缀按 home，绝对路径归一，其余相对路径按 `relativeBaseDir`（缺省 cwd）。
   * 后置：权限边界类路径必须显式传 home，否则同一条配置会随启动目录指向不同落点。
   */
  expandUserPath(value: string, options?: ExpandUserPathOptions): string;
  /**
   * 会话 mailbox 落盘根：`ZCODE_MAILBOX_ROOT` 显式覆盖优先，否则 `{dataRoot}/mailbox`。
   * 后置：必须跟随身份数据根——信封正文就是会话内容，落到共享根会让另一个身份读到不属于它的消息。
   */
  resolveSessionMailboxRoot(input: SessionMailboxRootInput): string;
  /**
   * workspace hook 信任库根：用户 `storage.dir` 覆盖优先，否则身份数据根本身。
   * 后置：相对覆盖值按 home 解析（权限落点不能随启动 cwd 漂移）；信任必须与 hooks 声明同源。
   */
  resolveWorkspaceHookTrustStoreRoot(input: WorkspaceHookTrustStoreRootInput): string;
  /**
   * 按目录名判定数据根属于官方版还是自建版：末段形如 `.zcode-<身份>` 判自建。
   * 后置：官方版返回空身份；纯字符串规则，不读盘。
   */
  classifyLedgerRoot(rootPath: string): { variant: LedgerSourceVariant; identity: string };
  /**
   * 列出本机全部可用数据根（排除当前身份的数据根），官方根排首位、其余按路径排序。
   * 前置：只覆盖本机根；WSL / 远端不纳入（跨文件系统拷贝语义不同，迁移不承诺跨机搬运）。
   * 后置：返回结构稳定的数组；只读目录，不改任何文件。
   */
  discoverMigrationSourceRoots(
    input: DiscoverMigrationSourceRootsInput,
  ): Promise<DiscoveredDataRoot[]>;
  /**
   * mailbox 信封文件名：零填充 UTC 时间戳（`YYYYMMDDTHHMMSSmmmZ`）+ messageId。
   * 前置：messageId 过白名单，`createdAt` 可被 `Date` 解析。
   * 后置：定长前缀保证 `readdir().sort()` 的字典序等于时间序；同一信封重投得到同一文件名（原子覆盖）。
   * 非法入参抛错而不是兜底生成名字。
   */
  buildSessionMailboxFileName(input: SessionMailboxFileNameInput): string;
}
