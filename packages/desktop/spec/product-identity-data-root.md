# 本地数据根按产品身份隔离（spec）

## 背景与问题

同一台机器上并排安装两个产品身份（官方 / 自建，见 `desktop-product-identity.mjs` 的
`ZCODE_PRODUCT_NAME` / `ZCODE_APP_ID` 覆盖）时，桌面原先在多个 service 里各自假设
`~/.zcode`：

- **互相串数据**：共用 `{dataBaseDir}/.zcode` 会让两个客户端读写同一份会话库
  （`cli/db/db.sqlite`）、凭据、provider 配置与设置——会话列表互相可见、并发写同一个
  SQLite、用户改过的设置（如 provider）相互覆盖。
- **UI 与 Agent 分叉**：`apps/zcode-cli` 是 submodule（可能预编译），它自己决定每个
  路径「跟数据根」还是「写死 home」。桌面若自行假设，会出现 UI 看到的技能 / 配置和
  Agent 实际读到的不是同一套。

## 设计决策：以 CLI 真源划边界

桌面**不改 CLI**，每个路径必须与 CLI 实际规则一致，只有两种落法：

- CLI 按数据根读取的 → 桌面用 `getZCodeDataRootDir()`（**隔离**）。
- CLI 硬编码 home 的 → 桌面共享 `join(resolveUserHomeDir(), ".zcode", ...)`（**共享**），
  否则 UI 与 Agent 看到的内容不一致。

## 身份的两层与后缀来源

- `ZCODE_DATA_BASE_DIR`：数据根的**父目录**（用户可以改；bootstrap `setting.json`
  记录的 `dataBaseDir` 就是它）→ 数据根 = `{base}/.zcode{suffix}`。
- `ZCODE_DATA_ROOT`：**数据根本身**，宿主启动 Agent 时下发（外部二进制 CLI 没有
  编译期身份，缺了它会自行推算回官方根）。
- 后缀 `ZCODE_DATA_ROOT_SUFFIX` 是编译期常量（`@zcode/shared`，由 tsup / vite
  define 注入），与远端隔离同源；官方为空串，路径与历史逐字节一致。

## 行为（边界清单）

**隔离（跟随数据根）**

| 路径                                    | 说明                                                                                          |
| --------------------------------------- | --------------------------------------------------------------------------------------------- |
| `{home}/.zcode{suffix}/v2/setting.json` | 设置指针：写入只落身份文件；读取链=身份文件优先、官方共享文件**只读**兜底（旧用户数据根不丢） |
| `{dataRoot}/v2/`                        | `provider_config.json`、`tasks-index.sqlite`、`sessions/`、`credentials.json`、日志           |
| `{dataRoot}/cli/`                       | `config.json`（技能开关 / 用户 hooks 配置）、`db/`、`log/`、`plugins/` 存储、`rollout/`       |

**共享（CLI 写死 home）**

用户 skills `~/.zcode/skills`、commands `~/.zcode/commands`、plugins `~/.zcode/plugins`、
`~/.zcode/AGENTS.md`、轨迹 rollout / debug、hooks 信任库兜底、CUA helper 安装 / 运行根。
依据：`apps/zcode-cli/packages/adapters` 的 skills / commands / context 根常量与
`storage/workspace-hook-trust-store.ts` 兜底逻辑。

## 所有权与不变式

- **路径单一事实源**：`packages/services/src/paths.ts`。service 层禁止再手写 `.zcode`
  拼接（`getUserZCodeDir` 已删除；`ZCODE_USER_DIR_NAME` 仅留给必须按 home 定位且按身份
  区分的描述符，如 MCP 用户目录）。
- **Agent spawn env 单点构造**（`packages/services/src/node.ts`）：
  `ZCODE_DATA_ROOT` 仅在数据根 ≠ `{base}/.zcode` 时下发；
  `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` / `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` 注入
  `{dataRoot}/v2` 下的文件，CLI 优先使用显式值。
- **不变式**：官方（空后缀）时全部路径与改动前完全一致；共享类资产两渠道同源。

## 失败语义

- 身份文件损坏：隔离侧只读不修、按「该候选为空」跳过，继续看共享兜底候选。
- 身份文件存在但字段为空：同样继续读兜底候选（值级回退，见
  `desktopDataBaseDirBootstrap.ts`）。

## 迁移边界

- 历史数据迁移见 `E:\ZCode-dev\README.md`（robocopy 全量 + SQLite `VACUUM INTO` 快照；
  凭据不搬，首次启动重新登录）。`copyDataDirectory` 只迁移 `{base}/.zcode{suffix}/v2`，
  跳过 `setting.json*`（bootstrap 中间态）与符号链接。
- 远端（WSL / SSH）与本地同源：**代码安装根与数据根都按身份后缀隔离**（2026-09-30 起数据根也隔离，
  原先只隔离代码导致共享数据上的 schema 错配炸掉官方 server），见
  `packages/server/spec/remote-runtime-isolation.md`。

## 验证

- 契约测试 `packages/services/test/dataRootIsolation.test.ts`：`ZCODE_DATA_ROOT` 覆盖
  优先、后缀生效、bootstrap 候选链、写入只落身份文件、`copyDataDirectory` 迁移范围。
  用 esbuild `--define` 注入 `-rayn` 后缀复跑通过（官方空后缀与自建后缀两个分支都过）。
- 2026-09-29 覆盖安装实测：自建版启动后设置写入 `~\.zcode-rayn\v2\setting.json`、
  CLI 会话库落在 `~\.zcode-rayn\cli\db`；同时段官方 `~\.zcode` 零改动。
