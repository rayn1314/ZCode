# MCP stdio 进程树回收改用连接时记录的 pid

涉及包：`adapters`（本 spec 主责）。

## 背景与问题

`closeClientAndTransport` 关闭 stdio MCP 连接前，会先按进程树回收子进程，理由是
「MCP SDK close 只保证直接子进程退出，npx/npm wrapper 拉起的 server 或
chrome-devtools-mcp watchdog 可能残留」。

实测（2026-10-26，自建版 WSL，当日 CLI 日志）：`mcp.server.closed` 事件 **301 条全部没有
`mcpTransportPid`**，而同一条 `mcpConnectionId` 的 `mcp.server.connected` 事件是带 pid 的。
`terminateMcpStdioProcessTree` 在 pid 为 null 时直接返回，因此**进程树回收从未真正执行**，
实际清理完全依赖 SDK 自己的 close（只杀直接子进程）。

最小复现（基类 `StdioClientTransport` 与仓库的 `ProcessTreeStdioClientTransport` 各一次，
legacy 最小 MCP server，`versionNegotiation: "auto"`）里 pid 从 connect 到 close 一直有效，
**未能复现**生产现象。根因待查，本条只消除「关闭时重新读取一个可能已被清空的值」这个脆弱点。

## 设计决策

pid 是连接成功时已经观测到的事实，随 record 一起保存（`McpServerRecord.transportPid`），
关闭时按以下顺序解析：

1. `transport.pid` 仍可读 → 用它（保持原有行为）。
2. 读不到 → 用连接时记录的 pid，**但仅当 transport 没有报告过退出**。
3. transport 已报告退出（`processExit` 有值）→ 不回收。此时进程已退出，pid 可能被系统复用，
   按旧 pid 杀进程会误伤无关进程。
4. 非 stdio transport → 不回收。

## 行为

- 正常连接/关闭路径行为不变：pid 可读时仍走原路径。
- 只有在「pid 读不到但进程未报告退出」时才新增回收动作。
- 关闭日志补上 `transport` 字段，便于后续对账（原先只有连接日志带）。

## 失败语义

- 进程树回收失败仍按既有 `mcp.stdio.process_tree_cleanup.failed` 上报，不改变连接关闭的成败。
- 解析不到 pid 时行为与改动前完全一致：跳过进程树回收，交给 SDK close。

## 迁移边界

- 不改 SDK 调用顺序、不改 `McpPort` 接口、不改连接池。
- 未解决：生产环境里 `transport._process` 为何在关闭前被清空。若后续定位到根因，应删除
  这里的回退分支，直接修根因（本回退只是让回收在现状下生效）。
