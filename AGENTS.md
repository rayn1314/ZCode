## 核心原则

- 新增或修改行为前，先更新对应 spec；目录不存在时按需创建。先明确产品规则、状态所有者、接口和验收场景，再实现代码。
- 以当前检出的源码、`package.json` 和架构策略为准。说明中只保留当前仓库提供的功能、命令和文件；删除功能时同步清理指令和技能中的引用。
- 定位问题时，未明确要求修改代码就先调查原因。结合源码、日志和运行时证据，区分已确认原因与待验证假设。
- 保留与任务无关的本地改动，不自行恢复已移除的模块或内部依赖。

## 常用命令

开工前运行 `node scripts/check-workspace-freshness.mjs` 检查基线。Node 版本以 `mise.toml` 为准。

以下命令从仓库根目录执行；向脚本传参统一写成 `pnpm <script> -- <args>`（与 `verify:pre-push` 保持一致）：

| 用途                     | 命令                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------- |
| 类型检查（根 workspace） | `pnpm typecheck`                                                                            |
| 类型检查（Agent CLI）    | `pnpm typecheck:cli`                                                                        |
| Lint                     | `pnpm lint` / `pnpm lint:fix`                                                               |
| 格式检查                 | `pnpm fmt:check`                                                                            |
| 桌面开发                 | `pnpm dev:desktop`（test 环境：`pnpm dev:desktop:test`）                                    |
| Web 开发                 | `pnpm dev:web`（只起服务端：`pnpm dev:server`）                                             |
| 提交前检查               | `pnpm verify:pre-push`（Lint、架构检查、格式检查、类型检查）                                |
| 架构检查（仅改动）       | `pnpm architecture:check -- --changed`                                                      |
| 架构报告                 | `pnpm architecture:report`                                                                  |
| 架构基线更新             | `pnpm architecture:baseline:update`（会改写 `.architecture-baseline.json`）                 |
| 模块阅读包               | `pnpm architecture:context -- <module-id>`                                                  |
| 依赖图                   | `pnpm dep:graph`                                                                            |
| 未使用依赖与导出         | `pnpm knip`                                                                                 |
| 导出引用查询             | `pnpm dep:refs <file>:<symbol>`；列出文件全部导出：`pnpm dep:refs -- --list-exports <file>` |

覆盖范围：

- 根 `pnpm typecheck` 只覆盖其 `tsconfig` 列表内的项目（rpc / provider / provider-node / shared / services / client / server / zcode-server-cli / ui / web 与 desktop host），**不含** `packages/formal-proof`、`packages/zcode-cua` 与 `apps/zcode-cli`。
- `apps/zcode-cli` 是独立的 pnpm + turbo workspace（自带 `pnpm-lock.yaml`、`turbo.json`）；根级 Lint 与类型检查不覆盖它，必须单独执行。
- 架构检查以 `.architecture-baseline.json` 为基线，`--changed` 只检查改动范围；遇到基线内的既有违规，不要顺手改动无关代码。

测试入口以目标包当前的 `package.json` 和实际测试文件为准，不假定存在统一的单测或 E2E 命令。

## 仓库导航图

顶层结构：

- `packages/*`：根 workspace 的可复用包。
- `apps/zcode-cli`：Agent CLI 与运行时，独立 workspace（子包职责见下）。
- `scripts/*`：构建、开发启动、架构检查、发行与内置 provider 配置生成。
- `config/provider/zcode-builtin.json`：内置 provider 配置源，参与 CLI 构建。
- `harness/remote`、`third-party`、`patches`、`public`：远端测试 harness、第三方清单、依赖补丁与静态资源。
- `CONTEXT.md`：领域词汇表；`DESIGN.md`：UI 设计规范；`architecture-policy.yaml`：架构规则来源。

`packages/` 各包职责：

| 包                 | 职责                                                                                                     |
| ------------------ | -------------------------------------------------------------------------------------------------------- |
| `shared`           | 跨包共享协议与类型；`src/zcode-protocol/` 是协议 schema 的单一导出入口，`src/platform.ts` 是平台能力接口 |
| `rpc`              | VS Code 风格 IPC 抽象框架：channel、proxy、协议与日志/遥测中间件                                         |
| `client`           | 客户端接入层：websocket、messageport、remoteServiceAccess                                                |
| `provider`         | Provider 领域与配置服务：registry、resolver、config-service、模型选择                                    |
| `provider-node`    | Provider 的 Node 端实现：配置仓储、内置 provider 物化与远端同步、运行时路径                              |
| `model-option-map` | 模型选项映射 DSL：tokenizer、parser、compiler、evaluator、merge-patch                                    |
| `services`         | 业务服务集合：settings、skills、subagents、mcp-sync、plugin-sync、credential、file、zcode-agent 等       |
| `server`           | 服务端主体：`entry-stdio.ts` 与 `entry-http.ts` 两个入口，`remote/` 承载远端连接与部署                   |
| `zcode-server-cli` | 远端/后台 Server 的安装、supervisor、release 管理与 CLI 命令（`bin: zcode`）                             |
| `ui`               | 共享 React 组件、hooks 与 Zustand store                                                                  |
| `web`              | Web 客户端入口（`src/main.tsx`，复用 `ui`）                                                              |
| `desktop`          | Electron 桌面端：`src/` 下 main、host、preload、renderer、scheduler                                      |
| `formal-proof`     | 独立 Vite 页面，形式化证明模型的可视化                                                                   |
| `zcode-cua`        | Computer Use 的 API 兼容占位包：当前构建不含 Computer Use，运行时表面一律报告不可用并 fail closed        |

`apps/zcode-cli/packages/` 子包归类：

- 核心运行时链路：`core`、`bootstrap`、`adapters`、`contracts`、`shared-types`。
- V4 协议网关与命令串行 admission 位于 `bootstrap/src/zcode-protocol-v4/`。
- 旁支能力：`cli`、`i18n`、`debug`、`node-repl-host`、`dynamic-workflow`、`dynamic-workflow-runtime`、`bundled-skills`、`swift-bridge`、`browser-use-plugin`、`superpowers-plugin`。

入口与关键数据流：

| 环节                            | 位置                                                                       |
| ------------------------------- | -------------------------------------------------------------------------- |
| Desktop main 进程               | `packages/desktop/src/main/index.ts`                                       |
| window-scoped Local Host        | `packages/desktop/src/host/index.ts`                                       |
| Desktop renderer 入口           | `packages/desktop/src/renderer/src/main.tsx`                               |
| Web 客户端入口                  | `packages/web/src/main.tsx`                                                |
| 服务端 stdio / http 入口        | `packages/server/src/entry-stdio.ts`、`packages/server/src/entry-http.ts`  |
| 协议 schema 单一入口            | `packages/shared/src/zcode-protocol/index.ts`                              |
| V4 网关                         | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/v4-gateway.ts`    |
| busy/running 输入串行 admission | `apps/zcode-cli/packages/bootstrap/src/zcode-protocol-v4/command-inbox.ts` |
| 远端 connection 唯一 owner      | `packages/desktop/src/host/windowRemoteConnectionRegistry.ts`              |
| 权限协议 schema                 | `packages/shared/src/zcode-protocol/index.ts`（`zcodePermission*Schema`）  |

两条实时链路的 `clientMode` 必须区分，改动 stream / snapshot / queue / 重连时同时验证：

- `desktop-continuous`：桌面本地与 relay 链路，配套 role `trusted-host-relay`。
- `web-remote-replayable`：手机远控的可恢复链路。

两者在 `packages/server/src/stdio.ts`、`packages/server/src/http.ts`、`packages/zcode-server-cli/src/server-core/http.ts`、`packages/desktop/src/host/index.ts` 按 `clientMode` 分支。

## spec 与文档落盘

- 行为改动的 spec 就近放在主责包内：`packages/<包名>/spec/<主题>.md`（已有先例 `packages/server/spec/`）。目录不存在时按需创建。
- 跨包变更只在主责包落一份，文首列出涉及的其它包，不要在多处复制同一份 spec。
- spec 至少覆盖：背景与问题、设计决策、行为、所有权与不变式、失败语义、迁移边界。
- 领域词汇统一写进 `CONTEXT.md`，UI 规范统一写进 `DESIGN.md`，不为同类内容另起文档。

## 实现与验证

- 代码改动使用 `.agents/skills/architecture-governance/SKILL.md`，先运行架构检查，再读取目标模块的受控上下文。
- 避免重复状态和多条写入路径。明确唯一所有者、接口、依赖方向、事件顺序与幂等边界，不能用超时掩盖同步问题。
- 有行为改动时先补充对应测试；交互改动需要 E2E 场景。检查测试与实现是否一致，并实际执行可用的验证。未执行或环境受限时如实说明。
- 修复 bug 时用中文注释说明原因和修复依据。发现设计缺陷时先与用户对齐，不不断增加兜底分支。
- 涉及状态、时序、远端或异步同步的方案，用图展示所有者及事件顺序。
- 必须执行 `pnpm typecheck` 和 `pnpm lint`，报告真实结果，不将已有失败写成通过。
- 使用异步文件和网络 IO；跨包导入使用公开入口，遵守现有路径别名。
- 禁止 UI 直接调用 Repo、Service 引用 Runtime 具体实现、跨域导入实现细节及循环依赖。

## UI 与平台边界

- 遵守 `DESIGN.md`，复用已有组件，兼顾桌面与手机 Web 的布局、交互、主题和国际化。
- 组件通过 `packages/ui/src/hooks/` 访问服务；平台操作通过 `IPlatformService`（`packages/shared/src/platform.ts`），不直接调用 `window.zcode`。
- 通过依赖注入处理 Desktop、Web、本地和远程环境的差异，并兼顾 Windows、macOS 和 Linux。
- Zustand 状态位于 `packages/ui/src/store/`。广播同步的主题、语言等字段需要防止回环；UI 局部状态不应被误当作服务端事实。
- hooks 中含 JSX 的文件使用 `.tsx`。

## 进程、协议与远程控制

- Desktop app 通过 stdio 与 Agent 通信。协议改动同步更新 `packages/shared/src/zcode-protocol/index.ts`，提供严格类型与运行时校验。
- Main 负责窗口、原生操作、进程调度和消息转发，不承载 task/session 业务状态。
- 每个窗口使用一个 window-scoped Local Host；本地 workspace 共享该 Host。远程 workspace 由窗口内的连接注册表管理，不另建 Desktop Remote Host。
- 手机远控连接桌面已有 Host attachment，复用会话运行时；不为手机另起 Agent、Local Host 或远程会话。
- Desktop 的 `desktop-continuous` 实时链路与手机的 `web-remote-replayable` 恢复链路必须明确区分。修改 stream、snapshot、queue 或重连时，同时验证两种语义。
- 外部 relay 与 Main 只做鉴权、配对、心跳、转发及 attachment 调度，不保存任务队列、快照等业务状态。
- 已接受的 busy/running 输入由 CLI/runtime `CommandInbox` 串行 admission；Renderer 只保留未提交草稿与 pending optimistic overlay，Host owner/lease 负责路由。
- 保留 owner/lease、跨 Host 路由和 stale run 防护，不能仅根据单一路径删除边界判断。

## Workspace Identity

- `workspaceIdentity` 用于身份隔离，`workspacePath` 用于文件操作、命令 cwd、Git 和路径展示。
- 身份 key 统一为 `workspaceIdentity?.trim() || workspacePath`，适用于去重、绑定、缓存、队列、持久化和请求关联。
- 远程链路贯穿传递 `workspaceIdentity` 与 `remoteSessionId`，不得仅按路径匹配。
- 新接口保留本地路径 fallback；远程 identity 复用现有构造和解析工具，不在业务代码中手写格式。

## 日志

- UI 使用 `packages/ui/src/logger.ts`，不直接使用 `console.log` 或 `window.zcode?.log`。
- Agent/session/runtime 相关服务日志使用 `createServiceLogger(scope)`（`packages/services/src/logger/serviceLogger.ts`）。
- `debug` 用于协议原始数据、流式 chunk 和逐条工具更新等高频诊断，生产环境不落盘。
- `info` 用于进程和会话生命周期、权限结果、一次性初始化等生产可用事件。
- `warn` 用于可恢复异常；`error` 用于崩溃、握手失败、鉴权丢失等不可恢复错误。
- 不在日志、示例或提交中写入凭据、真实用户数据和内部服务地址。
