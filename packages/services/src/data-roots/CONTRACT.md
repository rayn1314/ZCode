# 身份数据根解析与探测

意图：并排安装两个产品身份时，「某个目录该落哪」这个判断曾在四处各写一遍（CLI contracts、
services paths、CLI bootstrap 的 mailbox 解析、Host services 的 mailbox 解析）。每多一处就多一次
「自建构建写进官方根」的机会——实测过一次自建版收到的会话消息被写进官方 `~/.zcode/mailbox`。
本模块把规则收成单源：调用方只提供自己已知的事实，规则不再重复实现。

不变量：

- 优先级恒为「显式数据根（`ZCODE_DATA_ROOT` / 进程内覆盖） > `{baseDir}/.zcode{suffix}`」，
  baseDir（`ZCODE_DATA_BASE_DIR`）缺省 home；后缀来自编译期产品身份，官方渠道为空串。
- 参数收的是**值**而不是 env 对象：services 侧在模块加载时冻结 env，避免后台任务读到切换后的环境。
- 派生结果总是绝对路径；`~` 与相对路径一律按 home 展开，权限边界类路径不随启动 cwd 漂移。
- mailbox 的**落盘根**（node 侧）与**文件名 / id 白名单**（纯字符串）同源：同一台机上 CLI 进程写、
  Host services 进程读同一棵树，两侧规则一旦分叉就会出现同一条消息被读两次。
  `session-mailbox.ts` 因此不引 `node:os` / `node:path`，被 `packages/shared/src/index.ts` 桶导出。
- 探测只返回**本机**数据根，并排除当前身份（否则等于「自己迁自己」）；官方根排首位，
  自建根按路径排序（UI 顺序不随 `readdir` 抖动）。WSL / 远端数据根不纳入：跨文件系统拷贝语义不同。

与其它模块的交集在**调用方提供事实的那个点**处理，没有共享状态：

- 用量账本（`packages/services/src/usage-ledger/ledgerRoots.ts`）re-export `classifyLedgerRoot`
  等探测函数，按各自的 `relPath` 判「这个根里有没有数据」；探测本身只列目录，不做可用性判断。
- 身份数据迁移（`packages/services/src/migration/migrationService.ts`）在 `discoverSources` 调用探测，
  并在 `migrateDomain` 前重新探测做**集合成员校验**（字符串入参不足以防「调用方自己拼一个路径」）。
- CLI 侧入口 `apps/zcode-cli/packages/contracts/src/path/userDataRoot.ts` 只负责把 env 覆盖值取出，
  再交给 `resolveIdentityDataRoot()`；hook 信任库根由 services 的 `hooksService` 消费。

规则来源：`packages/services/spec/identity-data-migration.md`、
`packages/services/spec/session-mailbox-root.md`、`packages/services/spec/usage-ledger.md`。
