# 远端 Server 运行时按产品身份隔离（spec）

## 背景与问题

远端（WSL / SSH / Docker）Server 的**代码安装根**原先写死为 `~/.zcode/server`，与产品身份无关。
同一台机器上并排存在的两个产品身份（官方 / 自建）会共用同一份远端 `node`、`zcode-server.cjs`、
`agents`、`tools`、`asset-cache` 与部署锁，导致两类问题：

- **互相覆盖**：先连的一方部署的构建被后连的一方替换。
- **能力错配**：自建版把带新字段（如 provider 的 `requestPolicy`）的配置推给官方构建的远端 Server，
  远端严格校验拒绝，表现为 `Provider Provisioning 首次同步失败 (failed)`。

### 2026-09-30 事故：代码隔离后数据共享仍然炸掉官方 Server

代码隔离（`server-rayn`）落地后，两客户端在远端仍共用数据根 `~/.zcode`。实测事故链：

1. 自建版连 WSL，provisioning apply 把含 `requestPolicy` 的 provider 配置写进**共享**的
   `~/.zcode/v2/provider_config.json`（自建 server 认识该字段，写入成功）。
2. 官方版连 WSL，官方 server 读取同一份文件，strict zod 校验抛 `unrecognized_keys`，
   provisioning 首次同步失败 —— **官方版从此连不上 WSL**，且 server 配置轮询持续报错。
3. 手工清理该字段只维持到自建版下一次连接（会重新写回），无法收敛。

根因：**数据共享要求读写双方 schema 永远兼容，而 fork 的意义就是会改 schema**。
"只隔离代码"的前提（同一套代码读写同一份数据）在双产品并存的场景下不成立。

## 设计决策：代码与数据根都隔离（2026-09-30 起）

- **代码隔离**（原有）：远端 Server 安装根按产品身份后缀隔离，保证「连过去跑的一定是与客户端匹配的构建」。
- **数据根隔离**（本决策）：远端 server / agent 进程按产品身份注入 `ZCODE_DATA_ROOT`，
  自建版远端数据根为 `~/.zcode{suffix}`（如 `~/.zcode-rayn`）。两个产品的远端会话、凭据、
  provider 配置、设置各自独立，任何一方的 schema 演进不再影响另一方。
- **官方零行为变更**：后缀为空串时不注入 `ZCODE_DATA_ROOT`，远端启动命令逐字节与历史一致，
  数据根保持 `~/.zcode`。

原「数据共享」的动机（远端历史是「该环境」的属性，换客户端不丢历史）在此场景让位于
schema 兼容性：上游官方只有一套代码，production / preview 共享 `~/.zcode` 依然成立且不受影响；
只有「多套分叉代码并存」才走隔离。

## 行为

- 复用与本地数据根同源的编译期常量 `ZCODE_DATA_ROOT_SUFFIX`（含前导 `-`，官方为空串）：
  - `REMOTE_BASE = ~/.zcode/server${ZCODE_DATA_ROOT_SUFFIX}`
    - 官方（空后缀）→ `~/.zcode/server`，与改动前**逐字节一致**（零行为变更）。
    - 自建（如 `-rayn`）→ `~/.zcode/server-rayn`。
  - `REMOTE_SERVER_RUNTIME_ROOT = $HOME/.zcode/server${ZCODE_DATA_ROOT_SUFFIX}`，供启动命令注入
    `ZCODE_SERVER_RUNTIME_ROOT`（双引号内 `~` 不展开，故必须用 `$HOME` 形式）。
  - `REMOTE_DATA_ROOT_ENV_ASSIGNMENT = ZCODE_DATA_ROOT="$HOME/.zcode${ZCODE_DATA_ROOT_SUFFIX}"`
    （仅自建非空后缀；由 `deriveRemoteDataRootEnvAssignment(suffix)` 纯函数派生，可测）。
- `buildRemoteServerCommand` 的 env 赋值段：`SERVICE_AUTHORITY_MODE_ENV`、`ZCODE_SERVER_RUNTIME_ROOT`
  之后，自建后缀追加 `ZCODE_DATA_ROOT=...`。SSH / WSL / Docker 三种 backend 共用同一构造。
- **agent 继承**：server spawn agent 时全量继承进程 env（`zcodeAgentProcessManager` 在
  `process.env` 之上合入额外变量），agent 内 `resolveZCodeDataRoot()` 读到同一值，
  agent 的会话库 / 配置解析与 server 落到同一数据根。无需在 agent 侧新增注入。
- 远端所有**代码/资产**路径（node、server bundle、agents、tools、asset-cache、`.deploy.lock`、pty.node）
  统一由 `REMOTE_BASE` 派生；远端 agent wrapper 的 bundle 路径走运行时根。

## 所有权与不变式

- **产品身份单一来源**：编译期常量 `ZCODE_DATA_ROOT_SUFFIX`（`@zcode/shared`），与本地数据根同源，不新增第三套后缀规则。
- **env key 单一来源**：`ZCODE_DATA_ROOT_ENV` 常量定义在 `@zcode/shared`（services 的 paths.ts re-export），
  本地 spawn env 与远端启动命令同源拼写，禁止两处硬编码字符串。
- **数据根所有权变更**：自建版远端数据根为 `~/.zcode{suffix}`，与本地侧 `{dataBaseDir}/.zcode{suffix}` 同源；
  官方（空后缀）远端数据根仍为 `~/.zcode`。
- **不变式**：官方（空后缀）时，所有远端路径、env 注入与改动前完全一致。

## 失败语义

- 若「部署基址」与「启动/运行解析基址」不一致，会表现为远端找不到 node 或 agent。
  由**单点派生 + 同一常量**保证二者一致，不引入第二处拼接。
- 若自建版远端启动命令缺失 `ZCODE_DATA_ROOT`（部署基址与命令构造不同源时可能发生），
  server 会静默回退共享 `~/.zcode`，重新引入串台风险。由 derive 函数单点派生 +
  契约测试（官方不注入 / 自建注入）双重防护；不在运行时做兜底分支。

## 迁移边界

- 已有远端 `~/.zcode/server`（官方）保持不变；自建部署到 `~/.zcode/server-rayn`，不覆盖官方。
- **远端存量数据零自动迁移**：`~/.zcode`（远端）内的历史会话留在原地，归属官方环境；
  自建版远端数据根 `~/.zcode-rayn` 首次使用时为空。
- provider 配置与凭据无需手工搬运：自建版连接后 provisioning 会把桌面侧配置同步到新数据根。
- 会话历史如需在自建版远端可见，参照 Windows 侧先例（`copyDataDirectory`，robocopy +
  SQLite `VACUUM INTO`）做一次性手动搬迁；本轮不自动化。
- 手工 SSH 部署 / `zcode-server-cli` 直启远端 server 的场景不经 `buildRemoteServerCommand`，
  需要自设 `ZCODE_DATA_ROOT`（文档行为，不在本轮代码范围）。
- agent wrapper 模板文本变化会触发一次远端 agent 重传（官方与自建各一次），语义不变。
