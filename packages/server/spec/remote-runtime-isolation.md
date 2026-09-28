# 远端 Server 运行时按产品身份隔离（spec）

## 背景与问题

远端（WSL / SSH / Docker）Server 的**代码安装根**原先写死为 `~/.zcode/server`，与产品身份无关。
同一台机器上并排存在的两个产品身份（官方 / 自建）会共用同一份远端 `node`、`zcode-server.cjs`、
`agents`、`tools`、`asset-cache` 与部署锁，导致两类问题：

- **互相覆盖**：先连的一方部署的构建被后连的一方替换。
- **能力错配**：自建版把带新字段（如 provider 的 `requestPolicy`）的配置推给官方构建的远端 Server，
  远端严格校验拒绝，表现为 `Provider Provisioning 首次同步失败 (failed)`。

## 设计决策：只隔离代码，不隔离数据

- **代码隔离**：远端 Server 的安装根按产品身份后缀隔离，保证「连过去跑的一定是与客户端匹配的构建」。
- **数据共享**：远端数据根保持 `~/.zcode`（会话库 `cli/db`、`v2` 凭据/设置/历史）。历史是「该环境」的属性，
  共享才连续；隔离数据会导致「换客户端就看不到历史」。

## 行为

- 复用与本地数据根同源的编译期常量 `ZCODE_DATA_ROOT_SUFFIX`（含前导 `-`，官方为空串）：
  - `REMOTE_BASE = ~/.zcode/server${ZCODE_DATA_ROOT_SUFFIX}`
    - 官方（空后缀）→ `~/.zcode/server`，与改动前**逐字节一致**（零行为变更）。
    - 自建（如 `-rayn`）→ `~/.zcode/server-rayn`。
  - `REMOTE_SERVER_RUNTIME_ROOT = $HOME/.zcode/server${ZCODE_DATA_ROOT_SUFFIX}`，供启动命令注入
    `ZCODE_SERVER_RUNTIME_ROOT`（双引号内 `~` 不展开，故必须用 `$HOME` 形式）。
- 远端所有**代码/资产**路径（node、server bundle、agents、tools、asset-cache、`.deploy.lock`、pty.node）
  统一由 `REMOTE_BASE` 派生。
- 远端 agent wrapper 的 bundle 路径改用运行时根 `$runtime_root/agents/...`，不再硬编码 `$HOME/.zcode/server`。
- 远端进程内的 agent 运行时解析优先读 `ZCODE_SERVER_RUNTIME_ROOT`；未设置时回退历史默认 `~/.zcode/server/agents`
  （保持官方/本地行为）。

## 所有权与不变式

- **产品身份单一来源**：编译期常量 `ZCODE_DATA_ROOT_SUFFIX`（`@zcode/shared`），与本地数据根同源，不新增第三套后缀规则。
- **数据根所有权不变**：远端 `~/.zcode` 继续承载全部会话/凭据/设置数据。
- **不变式**：官方（空后缀）时，所有远端路径与 `ZCODE_SERVER_RUNTIME_ROOT` 赋值与改动前完全一致。

## 失败语义

- 若「部署基址」与「启动/运行解析基址」不一致，会表现为远端找不到 node 或 agent。
  由**单点派生 + 同一常量**保证二者一致，不引入第二处拼接。

## 迁移边界

- 已有远端 `~/.zcode/server`（官方）保持不变；自建首发会部署到全新的 `~/.zcode/server-rayn`，不覆盖官方。
- 数据零迁移：远端 `~/.zcode` 原样复用，历史/凭据无需搬运。
- agent wrapper 模板文本变化会触发一次远端 agent 重传（官方与自建各一次），语义不变。
