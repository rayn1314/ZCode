# Source Server 启动重连有界自动补试（startup retry window）

## 背景与问题

启动批次对每个 Source 候选只探一次，批次级 10s 超时后该 Source 终局 failed，且失败路径不写
`reconnectInputs`、不进 offline probe，UI 侧自动恢复也只覆盖「已有断连 tab」的工作区——
「从未连上的设备」从此只能手动救。现场证据（2026-10-27 06:54:15）：
`startup reconnect timeout diagnostic profile=f8d04ddb transport=wsl phase=probe elapsedMs=10018`
→ `startup reconnect failed` → `finished, online=0, failed=1`。WSL 冷启动经常超过 10 秒，
用户开局项目全断。

## 设计决策

- **所有者**：补试编排放进 `SourceServerConnectionManager`（与 `scheduleOnlineRetry` /
  `enterOfflineProbe` 同属一个重试家族），复用同一条 `connectForSource` 连接路径与启动批次的
  并发门禁（global 3 / docker 1）；不另起第二条并行链路。成功后自然汇入既有 online 路径
  （`connectOnce` 发布 → 写 `reconnectInputs` → 之后断线走 online retry / offline probe）。
- **节奏**：退避 [15s, 45s, 105s]（`sourceServerStartupRetryPolicy.ts`）。首档盖住「探针刚超时、
  WSL 仍在拉起」的紧邻窗口；×3 指数放大；三次补试加每次 ≤10s 探针，总窗口约 165s + 40s ≈
  3.4 分钟，覆盖 WSL 冷启动常见的 1-3 分钟区间。
- **严格有限**：三次后彻底放弃，进入既有 failed 呈现；不做无限轮询。用户可能刻意不开 WSL，
  超窗后的反复探测只会把已关停的 VM 反复唤醒。
- **补试键**：按 `profileId`（从未握手成功的 Source 没有 sourceServerId 归属，只有 Profile 是
  稳定身份）；已知 Source 的 `profile.sourceServerId` 记录在案，供断开按设备取消。
- **进行中呈现**：调度补试时发布既有 `retrying` 状态（含 `recoveryAttempt` / `recoveryLimit`），
  复用 UI 对在线恢复家族的既有语义；`connectOnce` 失败落盘在挂起补试存在时跳过 failed 写入，
  避免批次超时与被中止 flight 落盘的异步间隙把 retrying 闪回 failed。
- **资格判定**：抽成纯函数 `planStartupRetry({ retriesSoFar, stateAfterFailure })`，只有
  `failed`（且 `retryable !== false`）与瞬态 `bootstrapping`（超时先于失败落盘的间隙）可补试；
  在线 / 离线 / absent / updating / needs-install / needs-upgrade / identity-change-pending /
  `failed && retryable === false` 一律 skip。首次调度时的 skip 保持历史行为（安静放弃，不加日志）。

## 行为

- `reconnectOnStartup` 首次尝试失败的候选，在批次返回前结算补试窗口：
  - 资格通过 → 发布 `retrying`（attempt 1/3）+ info 日志
    `startup reconnect retry scheduled profile=<profileId> attempt=N/3 delayMs=<delay>`，
    计时器到点后经同一 `attemptStartupReconnect`（门禁 + 批次级超时）重探。
  - 补试成功 → 既有 online 发布路径 + info 日志 `... retry succeeded profile=... attempt=N/3`。
  - 补试失败 → 结算下一档；`exhausted` 时 warn
    `... retry window exhausted profile=... attempts=3` 并保持既有 failed 呈现；中途 skip
    （用户动作/终态接管）时 warn `... retry stopped profile=... state=<state>`。窗口中途结束
    的事件每个 Source 至多一条。
- **取消（用户意图优先）**：
  - 手动连接（`connect()` 公共入口，含管理服务 connectProfile / confirmIdentityChange 与
    connectSourceServerTarget）：取消该 Profile 的挂起补试。手动连接并入在途补试 flight 时
    （connectFlights 去重），该次尝试的结果归补试家族结算；手动操作完成后窗口按剩余预算继续。
  - 手动断开（`disconnectSource`）：取消按 sourceServerId 匹配的挂起补试，并把对应 Profile
    纳入 offline 终态收尾（否则该行会停在 retrying）。
  - 删除 Profile（`removeProfile`）：按 profileId 取消。
  - 更新（`updateServerOnce` 经 `clearRecoveryTimers`）与发布在线（同经 `clearRecoveryTimers`）：
    按设备取消。
  - 宿主关闭（`dispose`）：取消全部挂起补试，不再触发任何探测。
- 生命周期日志统一走 `logWarn` / 新增的 `logInfo` 选项，携带 profileId、attempt、delayMs。

## 所有权与不变式

- 补试计时器唯一所有者是 `SourceServerConnectionManager`（`startupRetryTimers`，按 profileId）；
  与 `retryTimers` / `offlineProbeTimers` 互斥：持有 `reconnectInputs` 的 Source 不可能同时
  挂有补试记录（补试只在「从未连上」的窗口内存在，成功即写入 reconnectInputs）。
- 同一 Profile 同时至多一个挂起补试；计时器触发先摘记录再尝试，在途尝试由 connectFlights
  归并，不与手动连接互相取消。
- `attemptStartupReconnect` 合同不 reject：失败一律归约为 `status: "failed"` 结果。

## 失败语义

- 补试尝试沿用批次级超时（默认 10s）+ abort + transport cancel；超时诊断 warn 与首试相同。
- 窗口结束后：状态为既有 failed（含 normalized error / errorCode / retryable），无任何 timer，
  无进一步探测；手动连接仍是唯一出路。
- 策略判 skip 的终态（升级待确认、身份待确认、安装待确认、不可重试失败）由既有终态呈现接管。

## 迁移边界

- 无持久化变更：补试窗口是宿主内存态，应用重启后由下一次启动批次重新评估。
- 仅覆盖 `SourceServerConnectionManager.reconnectOnStartup` 候选（ssh / wsl / docker）；
  index.ts 中 URL Server（`kind === "server"`）的启动批次走 `IRemoteProjectService.connectHost`
  链路，不在本 spec 范围。
- `remoteStartupAutoReconnectEnabled === false` 的门禁不变（`runStartupReconnectBatch` 整批跳过，
  补试随批次不存在）。
