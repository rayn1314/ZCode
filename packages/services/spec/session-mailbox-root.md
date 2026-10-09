# 会话收件箱（mailbox）落盘根归属（spec）

涉及包：`packages/services`（主责：Host 侧读写与失败语义）、`packages/shared`（落盘根与文件名的
单源规则）、`apps/zcode-cli`（独立子 workspace：投递端口与 drain）、`packages/desktop`、
`packages/server`（spawn / 远端 env 下发）。

身份归属总表见 `packages/desktop/spec/product-identity-data-root.md`。

## 背景与问题

mailbox 是跨会话投递的**同机兜底**：目标在进程内可达时走 v4 命令面（`guide` / `startNow`），
不可达时把信封落盘，等目标下次自醒时由 drain 读取（`UserPromptSubmit` / `PostToolUse` / `Stop`）。

同一台机器上写入方可能是 CLI 进程（`adapters/mailbox`）或 Host services 进程
（`services/session/sessionMailboxStore`），读取方是目标 CLI。三条曾经的缺陷：

1. **落盘根写死 `~/.zcode/mailbox`**（`session-mailbox.ts` 的 `DEFAULT_SESSION_MAILBOX_ROOT`）。
   并排安装的两个产品身份共用一棵收件箱树——信封 `content` 就是会话正文，另一个身份能读到
   不属于它的消息，且两边 schema 未必兼容。
2. **同一条规则两处实现**：CLI 侧 `bootstrap/app/app-config-options.ts` 借通用 `resolvePath`
   展开 `~` 且不 trim；Host 侧 `sessionMailboxStore.ts` 自备 `expandHome` 且 trim。两侧只共享
   常量名与缺省字符串。
3. **env 从未被显式下发**：`ZCODE_MAILBOX_ROOT` 不在任何 spawn / 远端 env 白名单里，只靠
   `process.env` 碰巧继承且未被 sanitize 掉。只要有一环不继承，两侧就落到不同的树。

2026-10-03 实测：自建版收到的会话消息被写进官方 `~/.zcode/mailbox/sess_77030aa6-…/read/`。

## 设计决策

- **落盘根跟随身份数据根**：缺省 `{dataRoot}/mailbox`，由
  `@zcode/shared/identity-paths-node` 的 `resolveSessionMailboxRoot()` 单源推导；
  `ZCODE_MAILBOX_ROOT` 仅作显式覆盖（测试 / 排障），正常部署不设置。
- **两个进程都传「自己已知的数据根」**：CLI 传 `resolveZCodeDataRoot()`，Host 传
  `getZCodeDataRootDir()`。规则不重复，事实各知各的。
- **env 显式下发**：桌面 `buildHostProcessEnv` 与 services 的 Agent spawn env 都下发
  `ZCODE_MAILBOX_ROOT`，值为单源函数的解析结果（含缺省值）——**不再依赖「两侧按同一套输入各自
  推导出同一路径」**：写侧的输入是宿主 baseDir / 编译期身份，读侧的输入是子进程 home / 后缀，
  两边只要有一处不同就会落到不同的树。远端启动命令按既有约定只在后缀非空时追加该赋值
  （官方命令逐字节不变），因为那份命令里的 `ZCODE_DATA_ROOT` 就是推导输入本身。
- **只承诺同机**：跨机（Windows ↔ WSL/SSH）时源机落盘的信封目标机永远读不到，仓库内没有
  也不新增 mailbox 搬运机制。跨机投递靠实时路由（`session/message-send-requested` sideband
  → Host → main `taskRealtimeBus` → 目标 Host）；mailbox 不作为跨机送达的承诺。

## 行为

| 环节         | 位置                                                              | 行为                                                                                                |
| ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 根解析       | `identity-paths-node.resolveSessionMailboxRoot()`                 | `ZCODE_MAILBOX_ROOT` > `{dataRoot}/mailbox`，两者都过 `~` 展开与 trim（env 型路径的相对形态按 cwd） |
| CLI 适配器   | `apps/zcode-cli/packages/bootstrap/src/app/app-config-options.ts` | 调用单源函数，dataRoot 取 `resolveZCodeDataRoot()`                                                  |
| Host 适配器  | `packages/services/src/session/sessionMailboxStore.ts`            | 调用单源函数，dataRoot 取 `getZCodeDataRootDir()`                                                   |
| 投递落盘     | CLI `adapters/mailbox`、Host `sessionMailboxStore.deliver`        | 写 `{sessionId}/unread/`，临时文件 + 原子 rename                                                    |
| drain / 归档 | CLI `adapters/mailbox.drainUnread`                                | 读 `unread/` 按文件名序取前 N 条，处理后 rename 到 `read/`，坏档进 `failed/`                        |
| 实时命中去重 | Host `sessionMailboxStore.consume`                                | 按 messageId 删 unread 副本，避免同一条被实时投递与 drain 各算一次                                  |
| 跨进程上报   | CLI `session-message-port.notifySendRequested`                    | 落盘后上报 `session/message-send-requested`，失败只影响实时性不影响持久化                           |

## 所有权与不变式

- **唯一写侧入口**：每进程各自一份适配器实例，但落盘根来自同一个单源函数，因此同机两个
  进程读写的必然是同一棵树（否则实时投递与 drain 各写一份，同一条消息被读两次）。
- **文件名规则**（`@zcode/shared/session-mailbox`）：零填充 UTC 时间戳 +
  `_<messageId>.json`，保证 `readdir().sort()` 的字典序等于时间序；`sessionId` 与
  `messageId` 过白名单，防路径穿越。
- **防环链**：`chain.{hop,originMessageId}` 是唯一裁决点（发送侧端口 cap 判定，接收侧不得
  因 hop 大而丢弃）。
- **不变式**：官方（空后缀）时落盘根与改动前一致；同一身份的单机上，CLI 与 Host 解析到
  同一路径。

## 失败语义

- 落盘失败：直接抛给调用方，不假装成功（不 DU 降级为「已送达」）。
- 不可达降级：写到 mailbox 并返回 `stored`，`detail` 带原因（`reason`）。
- **跨机不可达**：`stored` 只表示「已落到本机 mailbox」，不表示目标会收到。跨机能达成的
  只有实时路由；实现若无法确认送达，结果语义不得描述为已投递。
- 冷恢复失败 / 网关缺席：降级 mailbox，日志带原因。

## 迁移边界

- 位置变更：旧版落在 `~/.zcode/mailbox` 的信封**不自动搬运**。它们是「未读消息」而不是
  持久事实，且搬运需要跨身份读对方目录，代价大于收益；升级后未读消息会留在旧位置，需要时
  由用户手工查看。
- 已归档（`read/`、`failed/`）的信封同样不迁移，仅作历史留档；其手动清理路径（资源管理器
  「会话信箱归档消息」，`unread/` 不触达）见 `session-mailbox-storage-clean.md`。
- 远端 server / 桌面下发 `ZCODE_MAILBOX_ROOT` 后，远端与本地各自解析各自机器上的数据根；
  两侧不共享文件系统这一点没有变化，不要据此认为远端能收到本机落盘的消息。

## 验证

- `packages/services/test/sessionMailboxStore.test.ts`：缺省根跟随数据根（不再断言
  `~/.zcode/mailbox`）、`ZCODE_MAILBOX_ROOT` 覆盖生效、落盘文件名与 CLI 规则一致、consume 幂等。
- `apps/zcode-cli/packages/adapters/test/mailbox.test.ts`：`deliver` → `drainUnread` 全链路、
  坏档进 `failed/`、路径穿越拒绝、`chain` 往返。
- 单源派生：官方 / 自建两个后缀分支下 `resolveSessionMailboxRoot()` 的取值。
- 2026-10-03 实测回归点：自建版投递必须落在 `{dataRoot}/mailbox`，官方 `~/.zcode/mailbox`
  零改动。
