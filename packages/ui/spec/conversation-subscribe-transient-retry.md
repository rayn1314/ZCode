# 会话订阅瞬态失败的有界退避

涉及包：`packages/ui`（主责）。

## 背景与问题

`ConversationProjectionStore.connect()` 的 subscribe 失败若定格为 `status="error"`，面板只能靠用户再点一次「重新连接」。此前只有 runtime 换代一类瞬态错误被纳入有界退避（CUA Helper 冷启动 recycleUntilStable 场景）；远程 workspace 断开重连的「连接换代窗口」不在名单内：

设置页重连会 dispose 旧 remote session（session.dispose 以 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` reject 在途 RPC），旧 connectionScope 同时 closed / 新 scope 握手未完成（`fault.connection.closed`、`fault.connection.handshakeRequired` fail-fast）。用户在窗口内点开历史会话，点击落在旧 proxy 上，订阅立即失败落红字；自愈只能靠新 session services 挂载后的**下一次用户点击**触发渲染链（activateRemoteService → transport replace → transportReplaced 重订）——纯等待不自愈，表现为「头几回点必报错，等几秒再点才行」。

## 设计决策

- 瞬态判定按**结构化错误码收窄**：新增 `isRemoteWorkspaceHandoverError`，只认 `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` / `fault.connection.closed` / `fault.connection.handshakeRequired` 三个码。不按错误文案模糊匹配业务失败，不把任何普通失败拉进重试。
- `fault.subscription.transportReplaced` **刻意不进名单**：它抛出时 replace 已触发立即重连，catch 的代际防护保证不落 error；纳入反而会重复排队。
- 复用既有退避机制（常量泛化为 `TRANSIENT_CONNECT_RETRY_DELAYS_MS`，节奏 [250ms, 1s, 3s]），单一所有者，不另起第二条重试路径。

## 行为

- 命中瞬态码的订阅失败：`status="connecting"`（UI 转圈），按退避表自动重订；重订成功后 `lastError` 清空。
- 退避额度耗尽：如实落 `status="error"`，`lastError` 保留真实错误串（「重新连接」按钮仍可用）。
- 设备真离线：`remoteAvailable=false`，SessionPane 的 errored 分支本就不渲染该红面板，有独立的离线呈现；退避不掩盖真实失败。

## 所有权与不变式

- 重试状态与额度唯一归 `ConversationProjectionStore`；`retry()`（手动重连入口）与 runtime available 到达都会复位额度并取消遗留 timer。
- 代际防护：timer 到期时若 store 已关闭或代际已推进（如退避期间 transport 被替换并立即重订成功），遗留 timer 不得再开第二条订阅。
- 呈现层只读状态，不自行判错；SessionPane 不感知错误分类。

## 失败语义

- 「正在来」（换代窗口）与「真失败」（设备离线、业务拒绝）的边界就是上面的结构化码名单；名单之外的失败一律立即落 error，不被等待掩盖。
- 运行时证据：2026-10-27 dev 日志 00:29:44-45（点击订阅 → host detached service port → `ZCODE_REMOTE_WORKSPACE_DISCONNECTED` → 红面板）。

## 迁移边界

无数据迁移。`apps/zcode-cli` 侧同族错误 `fault.attachment.sessionNotFound`（attachment 未水合）不在本 spec 范围，属 CLI 侧边界，另立任务。
