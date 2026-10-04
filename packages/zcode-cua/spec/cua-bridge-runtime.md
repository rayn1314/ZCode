# Computer Use 桥接运行时（路线 B：把占位包改造成开源引擎桥接）

> 涉及其它包：`apps/zcode-cli/packages/node-repl-host`（创建/消费桥接 runtime）、`apps/zcode-cli/packages/core`（REPL 与工具执行）、`packages/ui`（工具调用渲染）。本文档只落一份，主责包为 `packages/zcode-cua`。

## 背景与问题

- 官方 CUA 的 `@zcode/zcode-cua` 包未开源，本仓库随附的是占位实现：`createComputerUseRuntime` 等接口一律 fail closed。
- 路线 A（见 `packages/desktop/spec/cua-open-source-mcp-replacement.md`）已通过"普通 MCP server 配置"（`.mcp.json` 预置 `open-computer-use`）让桌面/CLI 的 agent 获得 `mcp__open-computer-use__*` 工具面。
- 路线 A 的局限：官方 CUA 的 `mcp__zcode-cua__*` 工具面与 node-repl 内建 CUA bridge（REPL cell 里调用）仍不可用。路线 B 的目标是**保留官方工具面与现有集成外壳，把底层执行转发到开源引擎 `open-computer-use`**。

## 设计决策

- 桥接点选在 `createComputerUseRuntime`：它是 CLI/node-repl 侧 CUA 的唯一入口（`node-repl-host` 经 `createNodeReplCuaBroker` 把 REPL 请求转发给 `runtime.execute()`）。
- 桥接 runtime 内部：
  - 按需 spawn 开源 MCP server（`cmd /c open-computer-use mcp`，与路线 A 相同的 Windows 最稳写法）。
  - 使用**自研极简 MCP stdio 客户端**（`bridge-mcp-client.js`，newline-delimited JSON-RPC），不引入外部依赖，保持 `packages/zcode-cua` 零依赖。
  - 把官方 `toolName` 映射到开源工具名，参数做宽松归一化（`app_id`/`application` 等 → `app`）。
- 官方有、开源没有的工具（`request_access`/`status`/`stop_computer_control`/`open_application`）在桥接层做语义化本地处理。
- **不改动** `broker` / `broker/server` / `pip-session` / `frame-contract` 等其它占位接口：它们依赖官方 Helper 生命周期，桥接不涉及，继续保持 fail-closed（桌面端权限 UI / PiP 仍不可用，由路线 A 的 MCP 配置兜底）。
- 启用方式：环境变量 `ZCODE_CUA_BRIDGE_ENABLE=1`（或 options `{ bridge: true }`）。默认仍 fail-closed，避免未安装开源引擎时产生进程开销。

## 行为

### 工具映射（第一版）

| 官方 toolName                                                | 处理                                        |
| ------------------------------------------------------------ | ------------------------------------------- |
| `list_apps`                                                  | → `list_apps`（透传）                       |
| `get_app_state`                                              | → `get_app_state`（参数归一化）             |
| `type`                                                       | → `type_text`                               |
| `click`                                                      | → `click`                                   |
| `key` / `hold_key` / `press_key`                             | → `press_key`                               |
| `scroll` / `drag` / `set_value` / `perform_secondary_action` | → 同名开源工具                              |
| `request_access`                                             | 本地返回 `not_required`（Windows 无需授权） |
| `status`                                                     | 本地返回桥接状态                            |
| `stop_computer_control`                                      | 本地返回 `{ ok: true }`                     |
| `open_application`                                           | 返回 isError（开源无对应，第一版不支持）    |
| 其它未知工具                                                 | 透传同名工具，失败按开源返回                |

- 参数归一化：官方参数里 `app_id`/`application`/`application_id`/`bundle_id` 等字段统一映射为开源 `app`；其余字段原样透传。
- `request_access` 返回结构兼容官方契约：顶层 `accessibility` / `screen_recording` / `permission_request` 各带 `status_after: "not_required"`，使 `packages/ui` 的权限详情渲染为已满足。

### 启用与生命周期

- `createComputerUseRuntime(options)`：
  - `options.bridge === true` 或 `ZCODE_CUA_BRIDGE_ENABLE=1/true` 时返回桥接 runtime；
  - 否则返回原 fail-closed 占位 runtime（保持既有语义）。
- 桥接 runtime 首次 `execute` 时懒连接开源 MCP server，`dispose()` 时关闭子进程。
- `node-repl-host` 的 `captureComputerUseRuntimeFromEnvironment`：在无官方 broker env、且 `ZCODE_CUA_BRIDGE_ENABLE` 开启时，也创建桥接 runtime（原实现此时返回 `undefined`，CUA 永久不可用）。

## 所有权与不变式

- 桥接实现只属于 `packages/zcode-cua` 内部；`node-repl-host` 只增加一个"桥接模式也创建 runtime"的分支，不改变既有 broker 转发协议。
- 官方 CUA 的帧保护、权限 UI、PiP 外壳仍只对官方 Helper 生效；桥接层不伪造官方帧元数据（`frame-contract` 保持占位行为）。
- 不开源引擎（未安装 `open-computer-use`）时，桥接 runtime 的 `execute` 返回可读的启动失败错误，不影响其它功能。

## 失败语义

| 场景                               | 行为                                                     |
| ---------------------------------- | -------------------------------------------------------- |
| 未安装 `open-computer-use`         | spawn 失败 → `execute` 返回 `isError` 文本（含安装提示） |
| 开源 MCP server 启动/连接失败      | 首次调用返回 `isError`；`dispose` 清理子进程             |
| 工具调用失败（参数/权限/目标应用） | 透传开源 `isError` 结果                                  |
| 调用方 abort                       | 简化处理：忽略已发请求的响应，`dispose` 时统一关闭       |
| `open_application` 等未支持工具    | 返回 `isError`，文案说明桥接暂不支持                     |

## 验收场景

1. `ZCODE_CUA_BRIDGE_ENABLE=1` 时，`createComputerUseRuntime({bridge:true})` 的 `execute({toolName:"list_apps"})` 返回当前 Windows 应用列表。
2. `execute({toolName:"request_access"})` 返回 `status_after: "not_required"`，UI 权限详情显示已满足。
3. `execute({toolName:"get_app_state", arguments:{app_id:"..."}})` 返回目标应用 UI 树/截图（参数归一化生效）。
4. 经 `node-repl-host` 的 `createNodeReplCuaBroker` + `createComputerUseBridgeGlobals` 全链路调用 `list_apps` 成功。
5. 未设置桥接开关时，行为与改造前完全一致（fail-closed 占位）。

## 迁移边界

- 本路线只覆盖 CLI / node-repl 场景的官方工具面。桌面端 `mcp__zcode-cua__*` MCP 工具与权限 UI/PiP 仍由官方 Helper 提供，未开源部分继续 fail-closed；桌面端可用能力由路线 A 的 `open-computer-use` MCP 配置兜底。
- 若后续需要桌面端 `mcp__zcode-cua__*` 工具面，可扩展 `createCuaProductMcpServerResolver` 把 zcode-cua server 指向桥接 runtime——这超出本文档范围，留待后续。
