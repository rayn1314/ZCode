# 本地数据根按产品身份隔离（spec）

涉及包：`packages/services`（主责：路径单源与 Host 侧接入）、`packages/desktop`、`packages/server`、
`packages/shared`、`packages/zcode-server-cli`、`apps/zcode-cli`（独立子 workspace）。

## 背景与问题

同一台机器上并排安装两个产品身份（官方 / 自建，见 `scripts/product-identity.mjs` 的
`ZCODE_PRODUCT_NAME` / `ZCODE_APP_ID` 覆盖）时，多个进程原先各自假设 `~/.zcode`：

- **互相串数据**：共用 `{dataBaseDir}/.zcode` 会让两个客户端读写同一份会话库
  （`cli/db/db.sqlite`）、凭据、provider 配置与设置——会话列表互相可见、并发写同一个
  SQLite、用户改过的设置（如 provider）相互覆盖。
- **UI 与 Agent 分叉**：`apps/zcode-cli` 是独立构建，它自己决定每个路径「跟数据根」还是
  「写死 home」。桌面若自行假设，会出现 UI 看到的技能 / 配置和 Agent 实际读到的不是同一套。
- **同一规则多处实现**：`{dataRoot}` 的推导曾同时存在于 CLI contracts、services paths、
  CLI bootstrap 的 mailbox 解析、Host services 的 mailbox 解析。每一处都是一次
  「自建构建写进官方根」的机会，2026-10-03 实测命中两处：会话消息被写进官方
  `~/.zcode/mailbox`；hook 信任库落在官方 `~/.zcode/security/`。

## 设计决策：按「数据属于谁」划边界，规则收敛成一份

判断某个路径是否分身份，看的是**这份数据属于谁**，不是**哪个进程在写**。据此分四个域：

1. **身份隔离域** —— 判据：混了会不会串台（看到 / 覆盖对方的内容、凭据、归属、信任决策）。
   会 → 必须分开，全部落在 `{home}/.zcode{suffix}` 派生出的身份数据根下。
2. **用户资产共享域** —— 判据：用户是否期望「配一次、两处生效」。是 → 必须共享，而且必须
   同源；一侧改了另一侧看不见就是 bug。
3. **跨机可达域** —— 判据：两侧是不是同一个文件系统。不是 → 靠路径约定解决不了，只能靠协议。
4. **制品域** —— 判据：这是「程序」不是「数据」。同一身份的不同版本要能并存 / 升级，
   不同身份不能互相覆盖。

同时把「规则」收敛成一份实现：`@zcode/shared/identity-paths-node`
（`packages/shared/src/identity-paths-node.ts`）。各进程只提供自己已知的事实
（显式覆盖值、baseDir、`storage.dir`），派生规则不再重复。

> 真源仍然是 CLI 的实际读取规则（桌面 / 服务跟随它，不自行发明）。与早期版本的区别是：
> 这一版**同时修正了 CLI 侧的规则本身**——原先被记为「共享」的轨迹、hook 信任、CUA 目录
> 属于 CLI 侧写死 home 的实现，而不是产品有意共享，因此把它们改成跟随数据根，并让所有
> 消费方跟随新规则。

## 身份的三层

- `ZCODE_DATA_BASE_DIR`：数据根的**父目录**（用户可以改；bootstrap `setting.json` 记录的
  `dataBaseDir` 就是它）→ 数据根 = `{base}/.zcode{suffix}`。
- `ZCODE_DATA_ROOT`：**数据根本身**，宿主启动 Agent / 远端部署 server 时下发。
- **制品根**：远端 server 代码安装根 `{base}/.zcode{suffix}/server`，由同一后缀派生
  （`packages/server/src/remote/deployShared.ts`）。

后缀 `ZCODE_DATA_ROOT_SUFFIX` 是编译期常量（`@zcode/shared`），由构建注入：官方为空串，
路径与历史逐字节一致。注入点是**所有把 `@zcode/shared` / `@zcode/services` 源码内联进产物的
构建入口**，因此这些产物都按身份分档，不再是官方与自建共用的同一份文件：
`packages/desktop/tsup.config.ts`（main/host/preload）、`packages/desktop/vite.config.ts`
（renderer）、`apps/zcode-cli/packages/cli/scripts/build.mjs`、
`apps/zcode-cli/packages/tui/scripts/build.mjs`、`packages/server/tsup.config.ts`（entry-http）、
`packages/server/build-remote.ts`、`packages/zcode-server-cli/tsup.config.ts`。
判据可复核：产物里若还留着 `typeof __ZCODE_DATA_ROOT_SUFFIX__` 这类运行期兜底，就说明该构建
漏注入，自建版会静默落回官方根。

## 行为（边界清单）

**身份隔离域（跟随数据根）**

| 路径                                               | 说明                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `{home}/.zcode{suffix}/v2/setting.json`            | 设置指针：写入只落身份文件；读取链=身份文件优先、官方共享文件**只读**兜底（旧用户数据根不丢）                                                                                                                                                                                         |
| `{dataRoot}/v2/`                                   | `provider_config.json`、`tasks-index.sqlite`、`sessions/`、`credentials.json`、日志、崩溃 dump                                                                                                                                                                                        |
| `{dataRoot}/cli/`                                  | `config.json`（技能开关 / 用户 hooks 声明）、`db/`、`log/`、`plugins/`、`rollout/`、`debug/`                                                                                                                                                                                          |
| `{dataRoot}/mailbox/`                              | 会话收件箱（**本轮变更**：原先固定 `~/.zcode/mailbox`），见 `session-mailbox-root.md`                                                                                                                                                                                                 |
| `{dataRoot}/security/workspace-hook-trust-v1.json` | hook 信任库（**本轮变更**：原先固定 `~/.zcode/security/`）。权限边界，必须与声明同源                                                                                                                                                                                                  |
| `{dataRoot}/computer-use/`                         | CUA helper 安装 / 运行根（**本轮变更**）                                                                                                                                                                                                                                              |
| `{dataRoot}/cli/debug`、`{dataRoot}/cli/rollout`   | 模型 IO 轨迹与调试服务器读写根（**本轮变更**：原先写死 `{homedir}/.zcode/cli`）                                                                                                                                                                                                       |
| `{dataRoot}/workflows/`                            | 用户级工作流库（**本轮变更**：原先写死 `{homedir}/.zcode/workflows`）。两代定义各取各的扩展名：动态工作流 `.dwf.ts`（`saved-workflows/store.ts`）与 legacy 脚本 `.workflow.js`（`script-workflow-tool-port.ts`）。项目级仍固定 `{workspace}/.zcode/workflows`（跟仓库走，不按身份分） |
| `{dataRoot}/v2/logs`                               | 桌面主进程日志、导出包（`export-log` / `export-log-stage`）                                                                                                                                                                                                                           |

**用户资产共享域（刻意共享，不得改动）**

用户 skills `~/.zcode/skills`、commands `~/.zcode/commands`、plugins `~/.zcode/plugins`、
`~/.zcode/AGENTS.md`。依据：CLI 侧（`adapters` 的 skills / commands / context 根常量）与
服务侧（`skillsService` / `commandsService` / `pluginSyncService` / `settingsSyncService`）
都写死 home，桌面必须同源，否则 UI 与 Agent 看到的内容不一致。

这四类是**唯一**的共享用户资产。它们共享不代表「凡是 home 下的 ZCode 目录都共享」：
hook 信任库、轨迹、CUA、mailbox、用户级工作流库曾按同一理由被划入共享，但它们是
**权限边界、会话内容或可执行脚本**，混用会让另一个身份读到 / 覆盖不属于它的东西
（一个身份保存的 workflow 被另一个身份列出来并执行，或 `save` 直接覆盖对方同名定义），
因此已改为隔离（见上表）。新增路径必须按上述判据归类，不得沿用「CLI 写死 home 就共享」
的旧推理。

**制品域**

| 路径                                   | 说明                                                                      |
| -------------------------------------- | ------------------------------------------------------------------------- |
| `{base}/.zcode{suffix}/server`         | 远端 server 代码安装根（node / server bundle / agents / tools / 部署锁）  |
| `{base}/.zcode{suffix}/server`（本地） | `zcode-server-cli` 的**本地**默认 server root（**本轮变更**：原先无后缀） |

## 跨机可达性

mailbox 是唯一「既是数据、又是传输通道」的目录，其有效边界是**写侧与读侧的可达性边界**，
不是身份边界：

| 组合                          | 实时投递                        | mailbox 兜底               |
| ----------------------------- | ------------------------------- | -------------------------- |
| 同一 CLI 进程内的两个会话     | v4 `sendText`（guide/startNow） | 同一文件系统，有效         |
| 同一台机器、不同进程          | v4 sideband → Host → main 路由  | 同一文件系统，有效         |
| 不同机器（Windows ↔ WSL/SSH） | 走网络路由                      | **源机磁盘，目标机读不到** |

因此：mailbox 只承诺**同机**兜底；跨机投递只能靠实时路由。仓库内不存在 mailbox 的远端
同步 / 搬运机制，也不新增——用路径约定承诺跨机送达是错的。跨机场景下投递结果的真实语义
见 `packages/services/spec/session-mailbox-root.md`。

## 所有权与不变式

- **路径单一事实源**：`@zcode/shared/identity-paths-node`。派生规则包括
  `resolveIdentityDataRoot`、`getIdentityDataRootForBaseDir`、`expandUserPath`、
  `resolveSessionMailboxRoot`、`resolveWorkspaceHookTrustStoreRoot/FilePath`。
  各进程只提供事实（显式覆盖值 / baseDir / `storage.dir`），**禁止再手写 `.zcode` 拼接或
  自备 `~` 展开**。
- `packages/services/src/paths.ts` 仍是 services 侧的收口点（含进程内 `setDataRootDir`
  覆盖与冻结 env 的语义），其派生部分委托给 shared 的单源函数。
- **env key 单点定义**：`ZCODE_DATA_ROOT`、`ZCODE_DATA_BASE_DIR`、`ZCODE_MAILBOX_ROOT`、
  `ZCODE_SERVER_RUNTIME_ROOT` 的键名只来自 `@zcode/shared`，消费方不得自写字面量。
- **Agent spawn env 单点构造**（`packages/services/src/node.ts` + 桌面 `buildHostProcessEnv`）：
  `ZCODE_DATA_ROOT` 在「数据根 ≠ 身份缺省根」或「编译期后缀非空」时下发（后者一律下发：
  Agent CLI 是外部二进制，后缀必须与宿主一致，不能押在子进程自行推导上）；`ZCODE_MAILBOX_ROOT`
  在本地 spawn env 里**一律显式下发解析结果**（含缺省值），不依赖「两侧按同一套输入各自推出
  同一路径」——写侧与读侧落到不同的树会让同一条会话消息被实时投递与 drain 各读一次。远端部署
  命令是例外：它按 `deriveRemoteDataRootEnvAssignment` 的既有约定只在后缀非空时追加赋值
  （官方启动命令逐字节不变），因为同一份命令里的 `ZCODE_DATA_ROOT` 就是推导输入本身。
- **`storage.dir` 相对路径基准**：`resolveWorkspaceHookTrustStoreRoot` 把相对 `storage.dir`
  解析在 **home** 下（`expandUserPath(..., { relativeBaseDir: homeDir })`）。信任库是权限落点，
  相对路径若按进程 cwd 解析，同一条配置在不同启动目录下会指向不同的信任库。env 型路径
  （`ZCODE_DATA_ROOT` / `ZCODE_DATA_BASE_DIR` / `ZCODE_MAILBOX_ROOT`）保持「相对路径按 cwd」
  的既有语义，只有权限边界类路径传 `relativeBaseDir`。
- **不变式**：官方（空后缀）时全部路径与改动前完全一致；共享类资产两渠道同源。

## 失败语义

- 身份文件损坏：隔离侧只读不修、按「该候选为空」跳过，继续看共享兜底候选。
- 身份文件存在但字段为空：同样继续读兜底候选（值级回退，见 `desktopDataBaseDirBootstrap.ts`）。
- 未注入 `ZCODE_DATA_ROOT` 且进程自身没有编译期身份（CLI 独立运行的兜底路径）：解析结果
  即 `{base}/.zcode{suffix}`；本轮起 CLI 构建注入后缀，因此不再回落到官方根。

## 迁移边界

- **hook 信任位置变更**：信任库从共享 `~/.zcode/security/` 迁到身份根后，另一客户端已有的
  信任记录不会自动继承，需要在各自客户端重新审核授权（fail-closed，偏安全）。不自动搬运
  旧文件：信任是权限边界，跨身份搬运等于替用户做了授权决定。
- **用户级工作流库位置变更**：两代定义的全局根都从 `{home}/.zcode/workflows` 改成
  `{dataRoot}/workflows`（自建身份即 `{home}/.zcode{suffix}/workflows`）：动态工作流
  （`.dwf.ts`，list/get/save/move/delete 全链）与 legacy 脚本（`.workflow.js`，按名查找）。
  自建身份下旧的 `~/.zcode/workflows/*` 不会被自动拾取，也不会被搬运——搬过去等于把一个
  身份的脚本塞进另一个身份。需要时由用户自行复制到身份根；官方身份路径逐字节不变。
- **凭据库 / 设备标识的显式 `baseDir` 分支**：`resolveSharedZCodeCredentialsPath` 与
  `ensureCliDeviceMid` 在调用方显式传 `baseDir` 时原先自行拼 `{baseDir}/.zcode`（丢后缀），
  现统一走 `resolveIdentityDataRoot({ baseDir })`。当前无生产调用方走该分支（都只传 `env`），
  改动只为消除同类根因。
- **CLI / server 产物按身份分档**：上列注入点写进 `__ZCODE_DATA_ROOT_SUFFIX__` 后，官方与自建
  构建出的 bundle 不再字节相同；turbo 缓存需按身份分档（`apps/zcode-cli/turbo.json` 的 `env`
  声明与 `inputs` 里的 `scripts/product-identity.mjs`）。身份解析模块从
  `packages/desktop/scripts/desktop-product-identity.mjs` 上移到 `scripts/product-identity.mjs`，
  由桌面 / CLI / tui / server / server-cli 各构建入口共用一份；TS 源码 import 它时由同目录的
  `scripts/product-identity.d.mts` 提供类型（照 `target-platform.d.mts` 的既有做法，否则 desktop
  main 这类被 TS 直接引用的地方会报 TS7016）。已有部署不受影响：官方后缀为空，路径与命令逐字节
  不变。
- 历史数据迁移见 `E:\ZCode-dev\README.md`（robocopy 全量 + SQLite `VACUUM INTO` 快照；
  凭据不搬，首次启动重新登录）。`copyDataDirectory` 只迁移 `{base}/.zcode{suffix}/v2`，
  跳过 `setting.json*`（bootstrap 中间态）与符号链接。
- 远端（WSL / SSH）与本地同源：**代码安装根与数据根都按身份后缀隔离**（2026-09-30 起数据根
  也隔离，原先只隔离代码导致共享数据上的 schema 错配炸掉官方 server），见
  `packages/server/spec/remote-runtime-isolation.md`。

## 验证

- 契约测试 `packages/services/test/dataRootIsolation.test.ts`：`ZCODE_DATA_ROOT` 覆盖优先、
  后缀生效、bootstrap 候选链、写入只落身份文件、`copyDataDirectory` 迁移范围。
- 单源派生测试：`packages/services/test/identityPaths.test.ts` 覆盖 `identity-paths-node` 的
  解析函数在官方 / 自建两个后缀分支下的取值、`ZCODE_MAILBOX_ROOT` 覆盖优先、以及
  `storage.dir` 的 `~/` / 绝对 / 相对（按 home）三种形态。
- 构建注入可复核：`grep -c "__ZCODE_DATA_ROOT_SUFFIX__" <产物>` 应为 0（残留即漏注入）；
  自建构建（`ZCODE_APP_ID=dev.zcode.app.rayn`）产物里应出现 `-rayn`。
- mailbox 根测试：`packages/services/test/sessionMailboxStore.test.ts`（缺省跟随数据根，
  不再断言 `~/.zcode/mailbox`）。
- 2026-09-29 覆盖安装实测：自建版启动后设置写入 `~\.zcode-rayn\v2\setting.json`、
  CLI 会话库落在 `~\.zcode-rayn\cli\db`；同时段官方 `~\.zcode` 零改动。
- 2026-10-03 实测记录（本轮修复的起点）：自建版 `~/.zcode-rayn` 与官方 `~/.zcode` 在同一台
  机器上并存且同时被写入，官方根下出现不属于它的 `mailbox/` 与 `security/`。
