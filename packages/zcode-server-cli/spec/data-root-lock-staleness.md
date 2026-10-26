# data-root 单实例锁的陈旧判定

主责包：`packages/zcode-server-cli`。涉及其它包：无（仅本包 `src/runtime/lock.ts` 与其调用方 `src/cli.ts`、`src/supervisor/supervisor.ts`、`src/runtime/uninstallGuard.ts`、`src/runtime/shutdownWait.ts`、`src/runtime/updateHandoff.ts`）。

## 背景与问题

`<data-root>/server-<id>/run/server.lock` 是 Supervisor 的单实例锁，只在正常退出路径上清理。主机/VM 被强杀或重启时锁文件会残留，而 pid 随后会被复用：

- 2026-10-27 现场：锁记录 `pid=889`（上一次开机 18:39 获取），WSL 于 00:17 重启后 889 被一个无关的 node 进程占用。`process.kill(889, 0)` 成功 ⇒ 旧实现判 active ⇒ `acquire()` 抛 `Another ZCode Server instance is already running`，Supervisor 立刻以退出码 1 结束（`stdio: "ignore"`，日志外看不到原因），桌面端只看到 `daemon exited before ready (code=1)`。
- 故障不会自愈：pid 一直存活 ⇒ 永远不判陈旧 ⇒ 每次重连都失败，必须人工删锁；这在内存压力导致 WSL 反复重启的机器上反复发生。
- `inspect()` 用的是同一套「按 pid 存活」判据，因此 `stop` / `uninstall` / update handoff 的 fail-closed 分支同样被这个错误结论污染。

## 设计决策

pid 不是身份。锁记录增加随锁落盘的持有者身份证据，并在存活探测**之前**排除「持有者进程已不存在」：

1. `bootId`：Linux `/proc/sys/kernel/random/boot_id`，每次开机唯一。与当前值不一致即证明锁来自上一次开机（精确，无平台歧义）。
2. `pidStartTime`：Linux `/proc/<pid>/stat` 第 22 列 `starttime`（自开机起的 tick）。同一 boot 内区分 pid 的不同代次；读到且与记录不一致即 pid 已被回收（精确，覆盖「没重启但 pid 被回收」）。
3. `acquiredAt`（原有字段）与 `os.uptime()` 比较：`acquiredAt < 开机时刻 - 1s` 即锁早于本次开机。这是**唯一跨平台**的判据，也是现场故障的直接修复点——现场锁记录只有 `pid` + `acquiredAt`，因此升级前留下的锁也能被接管。

三条判据任一成立即充分；读不到信息（非 Linux、文件缺失、权限不足）只跳过该条，最终退回 `process.kill(pid, 0)`。精确判据（1、2）优先：一旦 boot_id 或进程启动时刻证明「就是同一次开机 / 同一个进程代次」，就不再采信判据 3——系统时钟被向前大幅调整时判据 3 会误判，而精确判据在同一开机内一定给出反例。不引入原生依赖，不引入超时兜底。

平台依据：Linux 的 `/proc/uptime` 计入挂起时间；Windows 的 `os.uptime()` 来自 `GetTickCount64`（MSDN 指明“工作状态时长”要用 `QueryUnbiasedInterruptTime`，即该值包含挂起时间）。因此判据 3 不会因机器休眠而误判在跑的持有者。

## 行为

- `inspect()` 与 `acquire()` 共用同一套判据；`stop` / `uninstall` / update handoff 读到的 active/stale 结论随之变准确，代码无需改动。
- `acquire()` 的回收流程（recovery gate、quarantine rename、ownerToken 校验、重试窗口）保持不变，只是「陈旧」的输入更准确。
- `tryAcquireOnce()` / recovery gate 写入的记录都带上 `bootId` 与 `pidStartTime`（平台不支持时字段缺省）。

## 所有权与不变式

- 同一 data-root 的 `server.lock` 同一时刻只有一个持有者；判 stale 是抢锁的唯一授权来源。
- 只有「充分证据」才能判 stale：证据缺失一律判 active（fail-closed），宁可人工排查，也不抢走真正在跑的持有者的锁。
- 平台降级只影响判据数量，不影响方向：任何读失败都收敛到保守路径，不会 fail-open。

## 失败语义

- 平台不支持 / 读不到 `/proc` / 权限不足：退回 pid 存活探测，最坏等于今天的行为（可能需要人工删锁）。
- 系统时钟被向前大幅调整：判据 3 可能多判，但只在精确判据都读不到时生效；Linux 上 boot_id 证明同一开机后即不再采信该判据（回拨只会让它少判，属安全方向）。
- 旧版本写入的锁（仅 `pid` + `acquiredAt`）在新版本下按判据 3 处理；新版本写入的锁在回滚到旧版本后只能按 pid 判断，退化为旧行为（一次性风险，重启一次即恢复）。

## 迁移边界

- 锁文件是 JSON，新增字段对旧读取方透明（旧实现只读 `pid` / `ownerToken`）。
- 本次不改 `status.json` 的「陈旧就绪」快照：远端 probe 已用 `kill -0` 校验 `status.json` 的 pid（`packages/server/src/source-server/sourceServerProbe.ts`），且该问题不是本故障的必要条件。

## 验证

`packages/zcode-server-cli/test/lock.test.ts`：pid 被无关存活进程复用（锁早于开机）仍接管、上一次开机（boot_id 不一致）仍接管、同一次开机内 pid 回收（starttime 不一致）仍接管、持有者确实活着仍拒绝启动。
