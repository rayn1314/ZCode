# 自建版 Computer Use 开源替代接入（路线 A：open-computer-use MCP）

> 涉及其它包：`packages/services`（MCP 解析/注入）、`packages/shared`（MCP server 配置类型）、`apps/zcode-cli/packages/core`（工具执行）、`packages/ui`（MCP 设置界面）。本文档只落一份，其余包不复制。

## 背景与问题

- 官方 Computer Use（CUA）实现位于闭源包 `@zcode/zcode-cua`，本仓库随附的是 API 兼容占位实现：所有运行时表面（runtime、broker RPC、Helper 安装/启动/校验、PiP、帧断言）一律 fail closed，返回 "Computer Use is not available in this build."。
- 自建版需要可用的桌面级电脑操作能力，但拿不到官方闭源实现。
- 开源生态调研结论：系统级 CUA 已有成熟开源实现。其中 `open-computer-use`（npm 包 `open-computer-use`，GitHub `iFurySt/open-codex-computer-use`，MIT）与 ZCode 官方 CUA 工具面最接近（native 九工具，兼容 Codex Computer Use 工具契约），支持 Windows / macOS / Linux。

## 设计决策

- **路线 A（本文档）**：以普通 MCP server 方式接入开源 CUA，**不修改 ZCode 源码**。
  - MCP server：`open-computer-use`，安装 `npm i -g open-computer-use`（要求 Node ≥ 18；实测 Node 22 可用）。
  - 目标平台：Windows（本仓库已实测：自带 `dist/windows/amd64/open-computer-use.exe`，经 UI Automation + Win32 window-message bridge 工作，无需额外权限授予）。
  - 配置形态：stdio MCP server。
- **明确不做**：
  - 不修改 `packages/zcode-cua` 占位包（那是路线 B 的工作，见"迁移边界"）。
  - 不复刻官方权限弹窗 UI / PiP / 帧保护外壳——它们只对 `zcode-cua` MCP server 生效，不覆盖本路线。

## 行为

### MCP 配置（三选一）

1. **用户/全局设置**：ZCode 设置 → MCP 服务器 → 新增服务器：

   | 字段 | 值                                                                |
   | ---- | ----------------------------------------------------------------- |
   | 名称 | `open-computer-use`                                               |
   | 命令 | `open-computer-use`（Windows 上若启动失败改用 `cmd`）             |
   | 参数 | `mcp`（改用 `cmd` 时参数为 `["/c", "open-computer-use", "mcp"]`） |
   | 类型 | stdio                                                             |

2. **工作区级**：项目根目录 `.mcp.json`：

   ```json
   {
     "mcpServers": {
       "open-computer-use": {
         "command": "cmd",
         "args": ["/c", "open-computer-use", "mcp"]
       }
     }
   }
   ```

   `command: "cmd"` 是 Windows 上最稳的写法（npm 全局命令是 `.cmd` 包装器，经 `cmd /c` 启动可避免 spawn 解析问题）。

3. **从外部 Agent 导入**：`open-computer-use` 自带 `install-claude-mcp` / `install-codex-mcp` 等安装器；ZCode 设置页支持扫描导入，但手动填写 command/args 更可控。

### 工具面

- agent 通过 `mcp__open-computer-use__*` 工具操作电脑，native 九工具与 Codex Computer Use 兼容，包括 `list_apps`、`get_app_state`、`type`、`open_application` 等（以实际 `tools/list` 返回为准）。
- Windows 无需额外权限步骤（macOS 才需要 Accessibility / Screen Recording 授权）。

### 模型路由（自建版中文 skill）

- 官方版靠闭源英文 CUA skill 指引模型在合适时机调用 node_repl；自建版在 `.agents/skills/computer-use/SKILL.md` 提供中文"电脑控制"skill，description 含中文触发词（电脑控制/控制电脑/操作桌面/读取屏幕/打开应用/点击/输入），使用户说"电脑控制"时模型能路由到 `mcp__open-computer-use__*` 工具。
- 该 skill 是自建版特有产物，随仓库分发；官方闭源包不含它。skill 正文给出工具面、工作流程与安全注意事项。

## 所有权与不变式

- MCP 配置归属用户/工作区，不属于 `packages/zcode-cua` 的职责。
- **不修改任何 `@zcode/zcode-cua` 相关源码**。官方 CUA 的帧保护、权限 UI、PiP、broker 凭据注入只作用于被 `isZCodeCuaMcpCommand` 识别的 `zcode-cua` server。
- 新 server 是普通 MCP server，**不进入** `zcode-cua` 识别逻辑，因此不会获得 broker 凭据注入，也不受其 fail-closed 逻辑约束——这是特性，不是缺陷。
- `runtimeEnv.ts` 的 env 清洗（`sanitizeZCodeRuntimeEnv`）不会把 CUA broker 凭据泄漏给本 server，本 server 也不需要那些凭据。

## 失败语义

| 失败场景                          | 现象                                        | 处理                                                             |
| --------------------------------- | ------------------------------------------- | ---------------------------------------------------------------- |
| `open-computer-use` 未安装        | MCP server 启动失败（process_start_failed） | `npm i -g open-computer-use`                                     |
| 不在 PATH / `.cmd` 无法 spawn     | 启动失败                                    | 改用 `command: "cmd", args: ["/c", ...]`；或填写 `.exe` 绝对路径 |
| MCP 子进程退出                    | ZCode stdio 传输层按既有策略重连/报错       | 无需额外处理                                                     |
| 工具调用失败（权限/目标应用拒绝） | MCP 返回 `isError: true`                    | agent 可见错误信息，按 open-computer-use 的 doctor 诊断          |

## 验收场景

1. 配置后 ZCode 的 MCP 服务器列表显示 `open-computer-use` 且连接状态可用。
2. agent 能调用 `mcp__open-computer-use__list_apps`，返回当前 Windows 桌面真实应用列表。
3. agent 能调用 `mcp__open-computer-use__get_app_state`（或 `snapshot`）读取目标应用 UI 快照。
4. 手动确认后，agent 能调用 `type` / `click` 等操作工具执行真实桌面操作。
5. 关闭/重启 ZCode 后 MCP server 能自动重连。

## 迁移边界

- **路线 B（后续）**：把 `packages/zcode-cua` 占位包替换为桥接实现——保留官方 `mcp__zcode-cua__*` 工具面与帧保护外壳，底层执行转发到开源引擎（如 open-computer-use 或底层自动化库）。届时本路线 A 的 MCP 配置可保留作为兜底，或整体移除。
- 若官方 CUA 未来开源，或自建实现成熟到覆盖权限 UI / PiP，可整体移除本配置。
