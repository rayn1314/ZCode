# 远程 workspace 打开竞态：让位与复用，不再互相回收

涉及包：`packages/ui`（主责）。相关实现：`packages/desktop/src/host/index.ts` 的 bind/attach、`packages/desktop/src/main/desktopRemoteSessions.ts` 的 route/dispose（本轮未改动）。

## 背景与问题

同一台 Source 上的同一个 workspace，可能被多个入口同时打开：侧栏行点击（`useProjectTaskNavigation` →
`attachRemoteProjectWorkspace`）、手机远控的 task 打开（`useWebRemoteControlTaskOpen`）、自动恢复
（`reconnectRemoteWorkspaceHistoryEntry`）、会话/远控桥接的挂载。每次打开都会 `connect()` 新建一个
logical session，再由 `bind` 把身份换代成权威 scope `remote:server:<sourceServerId>:<path>`。

现场证据（2026-10-27 06:58:50–06:59:10，pid 8612，`C:\Users\rayn\.zcode-rayn\v2\logs\2026-10-27.log`）：

| 时刻                | 事件                                                                                                                             |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 06:58:57.273        | `[rpc:call] remote-projects.connectHost OK`（第 1 次打开开始）                                                                   |
| 06:58:57.609        | `connecting window-scoped remote source requestId=93912d96`                                                                      |
| 06:58:58.391        | 第 2 次 `connectHost`（更晚的入口）                                                                                              |
| 06:58:58.451        | `renderer attachment ready sessionId=d3e9e463 reason=connect`（第 1 次的连接此刻才可用）                                         |
| 06:58:58.462        | 第 2 次 `connecting window-scoped remote source`                                                                                 |
| 06:58:58.475        | `detached service port` + `remote-session-disposed`（第 1 次的 session 被回收，**没有 bind 过**）                                |
| 06:58:59.308–59.594 | 第 2 次的 session `0512401c` attach → `bound remote workspace context` → `reason=workspace-context-bound` attach（一次完整成功） |
| 06:58:59.609        | 第 3 次 `connectHost`                                                                                                            |
| 06:58:59.612–59.614 | `0512401c` 被 detach + `remote-session-disposed`（成功后 20ms 被回收）                                                           |
| 06:59:00.699–01.624 | 第 4 次的 session `8562b487` 走完 connect → attach → bind → attach，**此后没有第 5 次点击，它存活**                              |

- `remote-session-disposed` 只有 `packages/desktop/src/host/index.ts` 的
  `DisposeRemoteWorkspaceSession` 处理函数会打印，而该消息只由
  `desktopRemoteSessions.disposeRemoteWorkspaceSession`（`DetachServicePort` 紧随其后）发出；窗口内
  没有任何 `remote-connection-closed`。即：这些 session 不是被传输层判死，而是被**主动 dispose**。
- 每个周期 ≈ 1.05–1.2s，正好等于一次 WSL connect 到 renderer attachment 就绪的时间（期间
  `Environment sync completed ... durationMs=718`）；最后一次之后没有新的打开请求，循环立即停止。
  因此这是**反应式**的（由下一次打开推动），不是定时器。
- 删除的 session 里既有「尚未 bind」的（`d3e9e463`、`388439fb`），也有「已经 bind 成功」的
  （`0512401c`）：被回收的不是失败连接，而是**已经可用的连接**。

同一份日志的 00:29 窗口给出另一半证据：`failed to prepare bound remote workspace,
remoteSessionId=d887c06c ... WindowRemoteConnectCancelledError: 远程连接已取消`——一个正在 bind 的
connect 被取消；随后 `v4 conversation store connect failed
errorMessage=ZCODE_REMOTE_WORKSPACE_DISCONNECTED`（订阅方看到的是「会话被换掉」）。

## 设计决策

- **所有权**：一次打开创建的 session 属于 **workspace 的权威 scope**，不属于某一次点击。让位（让更晚的
  入口接管导航）与回收（销毁连接）是两件事，不能绑在一起。
- **被取代只让位**：`project.navigation-cancelled` 表示「本次点击已被更晚的入口取代」，不是连接失败。
  过去在这里 `cancel(sessionId)`，等于每次点击都把上一次已经建好（甚至已经 bind 好）的连接销毁，后到的
  点击只能从 WSL 重连开始——这正是现场那个 1.1s 一拍的循环。
- **已有 live owner 就复用**：bind 返回的权威 scope 上如果已经登记了 session，说明这个 workspace 已经有
  活着的所有者。过去把「另一个实例已经拥有该 workspace」判成 `project.workspace-identity-mismatch` 并把
  本次新建的 session 一起回收；现在改为 adopt 它（幂等 re-bind 拿回 renderer attachment），只回收本次调用
  自己新建的重复 session。与 `packages/desktop/src/host/windowRemoteConnectionRegistry.ts` 的
  workspace-owner join、以及 `remote-workspace-identity-authority.md` 的「bind 是身份换代点」保持同一方向。
- **不新增兜底**：不引入重试定时器、不引入跨模块的工作区占用表。复用靠 `attachRemoteProjectWorkspace`
  既有的 `findSession(input.workspaceIdentity)`（被取代的连接不再被回收，后到的入口就能按同一 identity
  找到并复用它），adopt 靠 bind 返回的权威 scope。真实失败仍如实抛出并回收。

## 行为

- 连接等待期间导航被取代：抛 `project.navigation-cancelled`，不 bind、**不回收**本次创建的 session。
- bind 之后权威 scope 上已有别的 live session：幂等 re-bind 那个 session，回收本次新建的重复 session，
  返回既有 sessionId（调用方成功打开项目，而不是收到一个失败）。
- bind 之后权威 scope 上没有任何登记（bind 没有生效）：仍抛 `project.workspace-identity-mismatch`
  并回收本次创建的 session（保持 `remote-workspace-identity-authority.md` 的验收断言）。
- 复用调用方身份命中的 session：失败时一律不回收（既有语义不变）。

## 所有权与不变式

- `attachRemoteProjectWorkspace` 只回收**本次调用自己新建**的 session（`existing` 为空且不是被取代）。
- 权威 scope 上同时至多一个被 adopt 的 session；adopt 成功后本次新建的重复 session 立即回收，不留双活。
- 被取代的 session 不再由本函数回收，它要么被后到的入口按同一 identity 复用并 bind，要么随调用方的
  tab 生命周期/远端断开路径清理。这是本轮**已知残留**：没有第 5 次打开的极端情况下，被取代的
  connected session 会多存活一段时间（不再是 1.1s 一拍的销毁）。

## 失败语义

- `project.host-identity-changed` / `remote-project.host-removed` / `project.not-found` / bind 抛错：
  不变——如实抛错，并且回收本次新建的 attachment。
- `project.navigation-cancelled`：只让位，不回收。
- 不把任何失败静默降级成成功：adopt 只在「权威 scope 上确实存在已登记 session」时发生。

## 迁移边界

- 无持久化变更，无协议变更；`packages/desktop` 未改动。
- 若后续要消除上一节的残留，正确边界在 Host 侧（按 scope 的 live owner 做空闲回收），不在 UI 侧加定时器。
