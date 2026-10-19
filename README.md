# ZCode

<div align="center">
  <img src="public/logo/icons/1024x1024.png" alt="ZCode" width="128" height="128" />
</div>
<p align="center">
  <a href="https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=47ag983c-8fcb-4d6d-814b-5395193a712c&amp;qr_code=true">飞书社群</a> ·
  <a href="https://discord.gg/z9aBcQXZQ3">Discord</a>
</p>
<p align="center">
  简体中文 | <a href="README.en.md">English</a>
</p>

ZCode 是 AI 编程工作台，提供桌面应用、浏览器界面和终端 Agent。本仓库包含客户端、后端服务、共享 UI，以及 Agent CLI 与运行时源码。

## 相对上游的增强

本仓库在上游 [zai-org/ZCode](https://github.com/zai-org/ZCode) 基础上持续增强，重点改动如下；完整提交历史见 `git log origin/main..main`。

### 新增功能

- **上下文压缩可控**：新增「上下文压缩」设置分区，提供安全余量阈值、局部压缩、轮末压缩（独立阈值）与模型降档提前压缩四类开关，全部默认关闭；上下文容量面板新增手动压缩入口。
- **压缩摘要可开关 + 以当前状态分叉**：压缩标记（时间线上的分隔线）升级为可展开的摘要块，展开即按 ref 懒加载落库的结构化摘要，默认折叠、不展开不发请求；消息行的分叉按钮在上下文被压缩过后变成二级菜单，「以当前状态分叉」新建的分支复制的是**当前模型可见上下文**（从最后一次压缩边界起），另一条「从这一轮完整回溯分叉」才是把压缩前的历史原样带过去。
- **Hook 框架扩展**：事件扩充至 17 个并单源收敛，接入 PreCompact（可阻断）/ PostCompact（含失败回执）/ SubagentStart / SubagentStop / SessionEnd 等事件的全链路，支持 `http` 与 `mcp_tool` 两类 handler 及配套安全模型，附插件样例；子会话与主会话同形执行工具级 hook。
- **子代理一等会话**：子会话升级为正式会话 record——启动规格落库、冷恢复认领身份、关停沿子代理树级联；输入面按角色策略开闸（含受限子会话关闭输入）；左栏父条目下新增子代理子区块与运行计数角标。
- **跨会话消息体系**：Agent 默认后台派发即返回句柄，支持调用级模型选型；消息投递贯通 CLI 与 Host，支持普通/引导/立即三档投递与队列项提升，具备防环与跨重启恢复。
- **多 Agent 运行时治理**：后台子代理带活动看门狗（卡死自动落失败，不再永久占用父会话），进程级 FIFO 座位闸门控制并发上限（默认 10、可配置，超限排队停驻不报错），命令准入增加执行超时兜底（挂死命令 ≤60s 收口），WebSocket 出口接通背压，慢消费者不再拖垮服务端内存。
- **Computer Use 开源替代**：以开源 open-computer-use 替代官方闭源 Computer Use（桥接 runtime + 预置 MCP 配置 + 「电脑控制」技能）。
- **API Key 多预设切换**：同一供应商可预存多把 Key（带自定义备注名），设置页下拉一键切换，切换与手动改 Key 走同一条自动保存链。
- **用量账本**：使用统计页加入用量账本，展示更全面实用的信息，包括调用次数，缓存读取，输出，预估费用等等，支持多种筛选方式；会话明细按父子层级折叠展示，每行合计自身与全部后代的用量，fork 分支断边避免来源会话重复计费，跨数据源以「来源 + 会话 id」识别层级关系；价格基准支持手动同步，模型×供应商明细分页查看。
- **Provider 限速**：可按服务商配置每分钟请求数上限，从源头避免配额型 429。
- **按产品身份隔离数据**：客户端数据根与应用标识按产品身份隔离（含远端注入与远端身份归并），支持按域从另一身份迁移数据，双客户端不再共用同一数据根互相串台。
- **任务面板与目标截止时间**：新增 workspace 级「任务」主视图，跨项目集中查看、新建、编辑、暂停、恢复与清除各会话的持续目标；目标支持墙钟截止时间，到点前有一次性预警与收敛提示，到点后先放行一轮收尾再硬性停止，停止原因（到点 / 预算耗尽）在目标状态中可辨；新建时可选「保存」（不运行）或「保存并运行」。
- **工作流与任务增强**：手动启动工作流可前置选择会话与子代理模型；设置页新增立即归档旧任务按钮；资源管理器新增会话信箱清理类别，可按类别查看占用并一键清理。
- **拉取模型**：设置页供应商卡片支持从供应商 API 批量拉取可用模型并一键加入模型列表，避免手工填写模型名出错。
- **工具调用可观测性**：工具调用卡片显示读取范围（文件行区间、分页）与截断种类徽标，部分读取结果一目了然。
- **项目行操作增强**：侧边栏项目行支持一键复制路径；项目更多菜单新增「全部标为已读」，未读会话的计数不必逐个展开清理。

### 重构与工程治理

- 事件名单下沉 `@zcode/shared` 单源并全量派生全部消费站点；子代理启动期磁盘解析抽出共用。
- 提交门禁接入 oxfmt 格式化与静态检查，钉死换行符与格式化契约。
- 升级 axios / undici / form-data / ws / nanoid 等依赖，修掉对外网络层与运行时依赖漏洞。
- 后台任务等待由忙轮询改为终态事件驱动（共享 ticker，空闲自动停表）。

### 问题修复（摘选）

- 会话切换后首次上滑滚动跳变、空 completion 误判、AskUserQuestion 答案回写工具行。
- 浮层与顶栏拖拽热区重叠时的点击穿透；辅助对话不续父任务并识别引用块。
- 日志导出不再夹带崩溃 dump 与任务索引库；主进程未捕获异常留痕并兜底捕获。
- 子会话授权与主代理一致并支持超时自动拒绝；远端 workspace 子会话输入面统一；目标会话不存在时跨会话消息硬失败可见；插件市场列表解析兼容 `userConfig` 的 `options` 字段。

## 更新

- 2026-10-10：更新至 ZCode v3.15.1 版本。
- 2026-9-23：更新至 ZCode v3.14.3 版本。

## 初始化

准备 Git、Node.js **24.14.0** 和 pnpm **10.33.2**，版本以 [mise.toml](mise.toml) 为准。以下开发和打包命令均在仓库根目录执行。

```bash
pnpm bootstrap
```

`pnpm bootstrap` 安装 workspace 依赖、准备桌面本地运行资源，再执行 `build:bootstrap`。

Agent CLI 与运行时源码位于 [apps/zcode-cli/](apps/zcode-cli/)，作为普通目录随本仓库一起克隆，无需单独拉取或初始化 Git submodule。

根据需要选择其他初始化或构建入口：

| 命令                           | 用途                                                              |
| ------------------------------ | ----------------------------------------------------------------- |
| `pnpm install`                 | 安装依赖                                                          |
| `pnpm prepare:desktop-runtime` | 准备桌面运行资源，默认包含远程资源准备                            |
| `pnpm prepare:remote-assets`   | 单独准备远程运行资源                                              |
| `pnpm bootstrap:with-remote`   | 初始化依赖、本地与远程资源，并串行构建相关包；跳过桌面应用 bundle |
| `pnpm build`                   | 递归执行各 workspace 包的构建脚本，包括包内的资源准备步骤         |

默认 `bootstrap` 跳过远程资源准备，适合本地桌面开发。使用远程工作区或验证远程发行资源时，再运行对应准备命令。

## 开发与运行

### 桌面版

```bash
pnpm dev:desktop

# 使用测试环境
pnpm dev:desktop:test
```

`pnpm dev:desktop` 默认等同于 `pnpm dev:desktop:prod`，使用生产服务配置。启动脚本会准备本地运行资源、构建桌面 Agent，再启动 Electron 和源码监听。

需要独立开发数据目录时，可设置 `ZCODE_DATA_BASE_DIR`。例如在 macOS / Linux 中：

```bash
ZCODE_DATA_BASE_DIR="$HOME/.zcode-dev-home" pnpm dev:desktop:test
```

### 远程功能（SSH/WSL）

先执行 `pnpm bootstrap:with-remote` 准备远程资源（mock-cdn），再 `pnpm dev:desktop`；连接远程项目时资源选择「本地下载后上传」。开发态资源取自本地 `packages/desktop/mock-cdn` 和本地构建产物，经 SFTP 上传到远程，不访问 CDN。

### Web 开发

修改 Web 或后端源码时，使用开发模式：

```bash
pnpm dev:web

# 指定后端工作区（macOS / Linux）
ZCODE_SERVER_WORKSPACE=/path/to/project pnpm dev:web
```

该命令同时启动 Web 开发服务器（默认 `http://localhost:5173`）和后端（默认 `http://localhost:3030`）；浏览器访问前者。`/ws` 和一般 `/api` 请求代理到本地后端，`/api/v1/oauth/token` 单独代理到当前配置的产品服务。

Agent 源码修改后，执行 `pnpm --filter @zcode/cli... build` 并重启服务。需要验证完整发行包时，按下方“ZCode 命令行版”打包章节解压运行。

### ZCode 命令行版

命令行发行包包含 TUI、Web 和 Agent，统一使用 `zcode` 启动：无参数进入 TUI；第一个参数为 `--web` 时启动 Web；其他参数交给现有 Agent CLI 处理。两种模式都在本机运行，无需 Electron。

```bash
# 默认进入终端交互界面
zcode

# 启动 Web 界面
zcode --web

# 指定项目和端口，不自动打开浏览器
zcode --web --workspace /path/to/project --port 3030 --no-open

# 查看 CLI 或 Web 参数
zcode --help
zcode --web --help
```

Web 模式默认工作目录为当前目录，监听 `127.0.0.1`，默认不启用访问令牌，自动选择空闲端口并打开浏览器。访问终端输出的地址，按 `Ctrl+C` 停止服务。局域网访问可使用 `--host 0.0.0.0`；监听非本机地址时默认生成访问令牌，使用终端输出的带令牌链接。可通过 `--token` 指定令牌或 `--no-token` 关闭令牌认证。

直接启动通用 Web 服务的 HTTP 入口时，通过 `ZCODE_SERVER_AUTH_TOKEN` 配置 API／WebSocket 认证；通过程序接口创建服务时，使用 `authToken` 选项。

构建方式见下方打包章节。`pnpm build:zcode` 只生成发行包，不会替换 `PATH` 中已有的 `zcode`。如果命令仍指向旧安装或其他源码目录，macOS / Linux 可用 `command -v zcode` 检查，Windows 可用 `where.exe zcode` 检查。

### CLI 源码开发

直接开发 TUI 或 Agent 时，运行源码入口：

```bash
pnpm --filter @zcode/cli dev --help
pnpm --filter @zcode/cli dev

# 构建 CLI 及其 workspace 依赖
pnpm --filter @zcode/cli... build
node apps/zcode-cli/packages/cli/dist/zcode.cjs --help
```

这个入口直接运行 Agent CLI，不经过发行包的 `--web` 分流。开发 Web 用 `pnpm dev:web`；验证统一的 `zcode` 命令，用下方解压后的 `bin/zcode.mjs`。

### UI Plugin 开发

参见 [UI Plugin：能力、API 与调试](UI_PLUGIN.md)，从 Excalidraw 的画布协作示例开始，了解插件安装更新、页面 API 和宿主联调入口。

**向 `zcode-plugins` 提交插件 PR 时，必须在 PR 模板中声明是否为 UI Plugin，并填写插件名称。** 判断标准见[提交 PR 时声明插件类型](UI_PLUGIN.md#提交-pr-时声明插件类型)。

## 配置

根目录 [.env.example](.env.example) 提供服务地址与构建配置示例，可按需复制到 `.env`，本地覆盖放入 `.env.local`。Desktop 的开发环境通过 `dev:desktop:test` / `dev:desktop:prod` 选择。

| 配置                                 | 用途                                             |
| ------------------------------------ | ------------------------------------------------ |
| `ZCODE_DATA_BASE_DIR`                | 应用数据基目录，数据写入其下的 `.zcode/`         |
| `ZCODE_SERVER_WORKSPACE`             | Web 后端的工作区路径                             |
| `ZCODE_BUILTIN_PROVIDER_CONFIG_FILE` | 本地 Provider 配置文件路径；未设置时使用内置配置 |
| `ZCODE_DIST_BASE_URL`                | 命令行安装脚本使用的下载根地址                   |

运行时变量可在启动命令的环境中显式设置。随客户端发布的默认配置见 [config/README.md](config/README.md)。

## 打包

第三方声明生成、发行校验流程及声明在发行物中的位置见 [third-party/README.md](third-party/README.md)。

### 桌面版

```bash
pnpm bundle:desktop

# 指定目标平台与 CPU 架构
pnpm bundle:desktop -- --os win --arch x64

pnpm bundle:desktop -- --help
```

默认目标为 macOS arm64，默认输出目录为 `packages/desktop/dist/`。`--os` 支持 `mac`、`win`、`linux`，`--arch` 支持 `x64`、`arm64`；实际打包与签名需要目标平台对应的工具和配置。

安装：双击打开产物 DMG，将 ZCode 拖入"应用程序"。本地构建未签名，首次打开若被 macOS 拦截，执行：

```bash
sudo xattr -rd com.apple.quarantine /Applications/ZCode.app
```

### 自建版（fork 产物，Windows）

从本 fork 构建「ZCode Rayn」自建客户端：独立产品名 / AppId / 数据根 `~/.zcode-rayn`，与官方客户端并排共存、可同时打开。

**照做版——全程就两条命令**

第一次，构建：

```bash
pnpm package:desktop
```

构建结束会打印产物路径，并**自动建好**开始菜单和桌面的「ZCode Rayn」快捷方式。双击即用——本地会话和 WSL/SSH 远控都正常。

以后改了代码要更新自建版：

```bash
# 1. 先退出正在运行的自建版：右键托盘图标 → 退出（注意：关窗口只是隐藏到托盘）
# 2. 重新构建：
pnpm package:desktop
# 3. 再双击「ZCode Rayn」快捷方式
```

快捷方式指向仓库里的启动器、始终命中最新构建产物，重建后不需要重装快捷方式。

**细节与开关**

- 不想自动建快捷方式：设 `ZCODE_SKIP_SHORTCUTS=1`；之后手动建——把快捷方式指向 `wscript //nologo <仓库>\packages\desktop\scripts\launch-packaged-app.vbs`。
- 为什么快捷方式不直接指 exe：自建版连接 WSL/SSH 时需要 `ZCODE_REMOTE_ASSET_LOCAL_DIR` 指向本仓库的 `packages/desktop/mock-cdn`，否则会回落官方 CDN——官方 bundle 不认 fork 的新协议字段，首次同步必然失败。启动器负责注入该变量。
- `pnpm package:desktop` 依次执行：bootstrap（安装依赖 + 构建各包）→ 远端资产（WSL/SSH 部署用）→ electron-builder 打包 + exe 版本信息回填，产物在 `packages/desktop/dist/win-unpacked/`（解压即用，不写注册表）。打包前会自动重建 agent bundle 暂存并检查没有进程占用产物目录，步骤顺序不对也打得出完整的包。
- 身份默认值（产品名 / AppId / preview 身份 / 后端环境）集中在 `scripts/fork-build-env.mjs`，均可用同名环境变量覆盖；身份后缀是构建期烧录的，所以整条构建链共用这一份默认值。
- 开发模式（源码改动即时生效）需带同一套身份环境变量启动，默认值见 `scripts/fork-build-env.mjs`；开发模式与打包版共用数据根，避免同时打开。

### ZCode 命令行版

构建入口为 `pnpm build:zcode`。脚本会依次构建 CLI/TUI、后端和 Web，收集 TUI 的原生库、worker 与运行时依赖，再组装发行包；运行发行包仍需要 Node.js，版本以 `mise.toml` 为准。

打包前必须设置下载根地址 `ZCODE_DIST_BASE_URL`（可放在 `.env`、`.env.local` 或环境变量中），也可以通过 `--base-url` 传入。以下地址是占位示例，发布时替换为实际托管地址：

```bash
pnpm build:zcode --base-url https://downloads.example.com/zcode/

# 已配置 ZCODE_DIST_BASE_URL 时
pnpm build:zcode

# 仅重新组包，复用已有的 Agent、后端和 Web 构建产物
pnpm build:zcode --skip-build

# 查看版本、输出目录等可选参数
pnpm build:zcode --help
```

默认版本取根目录 `package.json`，输出目录为 `dist/zcode/`：

- `releases/<version>/zcode-<version>.tar.gz`：运行包。
- `releases/<version>/sha256.txt`：校验摘要。
- `latest.json`、`install.sh`：版本索引和安装脚本。

完整目录可上传到配置的下载根地址。安装脚本从该地址下载运行包，默认安装到 `~/.zcode/runtime`，并在 `~/.local/bin` 创建 `zcode` 命令。安装目录可通过 `ZCODE_DIST_HOME` 修改，命令目录可通过 `ZCODE_DIST_BIN_DIR` 修改。

旧 Lite 用户需要改用上述构建命令、环境变量和新的安装脚本。新安装不会删除旧 Lite 目录，也不会迁移或删除已有会话数据。

本地调试打包产物时，可直接解压运行，无需上传或安装：

```bash
zcode_version=$(node -p "require('./dist/zcode/latest.json').version")
mkdir -p dist/zcode/debug
tar -xzf "dist/zcode/releases/$zcode_version/zcode-$zcode_version.tar.gz" \
  -C dist/zcode/debug
# 默认启动 TUI
node dist/zcode/debug/zcode/bin/zcode.mjs

# 启动 Web
node dist/zcode/debug/zcode/bin/zcode.mjs --web \
  --workspace "$PWD" --port 3030 --no-open
```

浏览器打开 `http://127.0.0.1:3030`，即可验证同一后端服务托管 Web 页面和 Agent 的完整链路。该端口需要空闲；如正在运行 `pnpm dev:web`，可改用其他 `--port`。

## 仓库结构

| 目录                                                 | 职责                                       |
| ---------------------------------------------------- | ------------------------------------------ |
| `packages/desktop`                                   | Electron Main、Host、Renderer 与桌面打包   |
| `packages/web`                                       | Web 客户端                                 |
| `packages/server`                                    | HTTP / WebSocket 服务与远程连接            |
| `packages/zcode-server-cli`                          | 独立 Server 启动与进程管理                 |
| `packages/ui`                                        | 共享 React 组件、hooks 与 Zustand 状态     |
| `packages/services`                                  | 业务服务与持久化                           |
| `packages/shared`、`packages/rpc`、`packages/client` | 共享协议和类型、RPC 框架、Agent 客户端 SDK |
| `packages/provider`、`packages/provider-node`        | Provider 公共能力与 Node 实现              |
| `apps/zcode-cli`                                     | Agent CLI、TUI、运行时与工具               |
| `scripts`、`config`、`third-party`                   | 构建维护脚本、内置配置与第三方声明材料     |

## 项目声明

功能与优惠范围、维护规则、执行与数据风险，以及许可和第三方版权说明，详见 [NOTICE.md](NOTICE.md)。
