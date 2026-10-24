# Windows 进程树清理预算分配

主责包：`packages/services`（`src/zcode-agent/zcodeStdioTransport.ts`、`src/process/processTreeTerminator.ts`、`src/process/processTreeWaiter.ts`）。
涉及但不改动：`packages/desktop`（Host 的 `service-dispose` phase 3.5s 是本节预算的上界来源）。

## 背景与问题

Windows 关闭 agent 时，`ZCodeStdioTransport.disposeAndWaitOnce` 在固定的一段绝对预算内依次做四件事：抓进程树快照（CIM/PowerShell）、发 stdin EOF 等 agent 自然收尾、`taskkill` 强杀进程树、观察退出。这段预算必须有界——`packages/desktop/src/host/index.ts` 的 `service-dispose` phase 超时是 3500ms，超过就记一条关闭失败。

fork 硬化提交 `03702350` 把预算切成 `forceAfter 2000 + taskkill 1000 + 宽限 250 = 3250`，并让 EOF 等待最多用到「deadline 减去强杀窗口」，保证每个 attempt 都会真的走到强杀阶段。该修改解决了「强杀从不触发」，但留下一条边：

**强杀命令的 1000ms 上限低于这条命令在本机的真实耗时，于是强杀命令被自己的 `execFile` timeout 掐断，进程根本没被回收，waiter 到绝对 deadline 上报残留并抛错（`zcodeStdioTransport.ts` 的 `runtime process tree cleanup incomplete; remaining pid=…`），生产表现为「关闭时清理失败的告警 + 无意义重试」。**

实测（本机 Windows 11，2026-10-24，见「证据」）：

- 收口一棵最小的进程树（`node -e "setInterval(...)"` + 其 conhost 子进程）单次 `taskkill /PID x /T /F` 需要 **0.64–1.4s**；2–4 个 workspace 并发清理时 **1.2–1.9s**。
- 不带 `/F` 的礼貌命令 `taskkill /PID x /T` 对无窗口的 console agent **必然失败**，但要 **0.64–1.9s** 才返回（taskkill 会等进程树响应窗口消息）。
- 两者并发时强杀命令被拖到 **1.9s**（probe：2 agent 并发，混合 1883/1988ms vs 只发强杀 1216/1309ms）。
- taskkill 成功后 PID 立即可见为已退出，`ChildProcess` 的 exit 事件在 0–25ms 内投递。

因此失败不是「偶发时序抖动」，而是**每个阶段的固定上限与命令真实耗时不相容**：一个 attempt 里 graceful `/T` 与 force `/F` 几乎同时发出（礼貌预算已被 EOF 等待吃光，`forceAfterMs≈0`），各自吃满自己的 1000ms 上限被 SIGTERM，残留判定随即发生。实测日志：两条 taskkill 都在第 1000ms 被 `signal: SIGTERM` 掐掉，69ms 后 waiter 报残留，进程直到测试兜底 SIGKILL 才退出。

## 设计决策

1. **总预算不变（3250ms），只重切**：强杀阶段的窗口从「taskkill 1000 + 宽限 250」扩到「1500 + 250」，礼貌窗口从 2000 收到 1500。`I1`。
2. **强杀窗口只在「命令粒度」上被保证**：`runWindowsTaskkill` 的命令窗口从绝对 deadline 推导（见第 3 条），且礼貌命令被限制在 force 触发点之前（第 4 条），因此**只要走到强杀阶段，它就有完整的 1750ms**。前置的快照查询不给它让路——原因见下。
3. **命令窗口从绝对 deadline 推导**：`runWindowsTaskkill` 每次取 `min(该阶段上限, 绝对 deadline − 现在 − 退出观察窗口)`；窗口不再有执行意义时**不发命令**（debug 日志）。旧实现完全不读 `windowsCleanupDeadlineAtMs`，每条命令都能吃满自己的上限。
4. **礼貌阶段只能用「force 触发前剩下的礼貌预算」**：`min(礼貌命令上限, 剩余礼貌预算)`，两者并发关系被消除；剩余礼貌预算为 0 时**跳过礼貌命令**并记 debug 日志（`I3`）——而不是发一条注定失败的 `/T` 去和 `/F` 抢时间。旧实现下第二次 cleanup attempt（`forceBudgetMs=0`）注释写着「直接进入 force」，但 graceful 命令仍然照发。
5. **快照不能收窄到「deadline − 强杀窗口」**：Windows 强杀以「快照里核对过的 root 身份」为前提，拿不到身份时整轮 fail closed、一条 taskkill 都不发（`processTreeOwnership` 判 `childStillOwned=false`，防止误杀复用的 PID）。实测把快照收窄到 1500ms 会让硬成本 ~1.35s 的 PowerShell/CIM 查询在被掐断后变成「谁都不杀」，比慢快照更糟。**因此本设计选择让慢快照正常吃掉预算，只把礼貌阶段作为让步方。**
6. **Windows 与 POSIX 分开**：预算重切只影响 Windows（只有 Windows 需要给 taskkill 让路）。POSIX 的礼貌窗口、EOF 等待、force 触发时刻逐位不变。

## 预算分配表（Windows，单次 attempt）

| 阶段                                      | 上限                                                          | 依据                                                                                                                                                                                              |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程树快照（CIM/PowerShell）              | 受同一个绝对 deadline 约束（查询自身上限 2500ms）             | 全量进程表查询实测硬成本 ~1.35s（1.28–1.40s，597 个进程），其中单 PowerShell 启动就 775ms；改属性投影 / CSV / 定向 filter 都不低于 1.3s。**它是强杀的前提**（核对 root 身份），不能为强杀窗口让路 |
| 礼貌 EOF 等待（stdin EOF → 期望自然收尾） | `min(1800, deadline − 1750 − 已耗时)`，最坏 `1500 − 快照耗时` | `STDIO_EOF_EXIT_WAIT_MS=1800` 是配置上限（POSIX 全额生效）；Windows 的可用量由 deadline 扣掉强杀窗口决定（`I2`）                                                                                  |
| 礼貌 taskkill `/PID x /T`                 | `min(1000, force 触发前剩余礼貌预算)`；≤0 跳过                | 实测该命令对无窗口 agent 必然失败且需 0.64–1.9s 返回：给它超过礼貌窗口的时间只会和强杀抢进程创建/内核时间                                                                                         |
| 强杀 taskkill `/PID x /T /F`              | 1500，再被 `deadline − 250` 夹住                              | 实测单树 0.64–1.4s、2–4 路并发 1.2–1.9s；1500 覆盖并发典型值并留余量                                                                                                                              |
| 退出观察宽限                              | 250                                                           | 实测 taskkill 成功后 PID 立即消失、exit 事件 0–25ms 投递，250ms 是事件循环延迟余量                                                                                                                |

合计 `1500 + 1500 + 250 = 3250`（与修改前相同），落在 Host `service-dispose` 的 3500ms 内。

`force` 触发点固定在「清理起点 + 礼貌窗口」，因此从触发点到绝对 deadline 恒有 `1500 + 250 = 1750ms`：**只要走到强杀阶段，它就拿到这个窗口**（`I2`）。前提是快照能在收口线内返回——见下面的「遗留」，慢快照会先吃掉窗口。

第二次 attempt（app quit 的最终重试，`cleanupAttemptCount > 1`）：总预算 1750ms，礼貌预算 0 ⇒ 不等 EOF、不发礼貌命令，全部预算留给强杀命令（修改前是 1250ms）。快照仍会重跑（它才是能不能杀的前提），预算为 `min(2500, 1750)`。

POSIX：无绝对 deadline、无 taskkill 窗口，礼貌窗口保持 2000ms，EOF 等待保持 1800ms，force 触发时刻不变。

### 这条预算线为什么不能再放大

实测本机硬成本：快照 ~1.35s（PowerShell 启动 775ms 已是下限）+ 一次真实 `taskkill /T /F` 1.2–1.4s + 退出观察 0.25s ≈ 2.9–3.0s。3250ms 的封套里只剩 250–350ms 留给「等 agent 自己退出」的礼貌窗口，因此 Windows 上礼貌窗口必然被压到几百毫秒以内。要同时拿到「完整快照 + 完整礼貌窗口 + 可靠强杀」需要更大的封套（Host 的 3.5s service phase）或换掉 PowerShell 快照（改用原生 PPID / 创建时间来源），两者都是跨包/跨模块改动，不在本节范围内。

## 行为

- 正常路径（agent 响应 EOF）：EOF 等待在 child exit 事件上立即结束，随后 waiter 按 OS 存活事实与 exit 事件判定完成。退出等待与判定的行为、顺序、日志均不变（`I4`）。
- 压力路径（agent 无视 EOF）：礼貌预算被快照/EOF 等待用完 ⇒ 跳过礼貌 taskkill（debug 日志）⇒ 强杀命令拿到完整 1750ms 窗口并真的收口进程树。
- 根进程已退出、detached 后代仍存活：礼貌预算完整保留 ⇒ 礼貌 taskkill 照旧发出（上限 `min(1000, 剩余礼貌预算)`，正常路径与修改前一致），force 在礼貌窗口结束时触发。
- 快照查询在预算内完成：拿到后代身份，强杀按已验证身份执行（与修改前一致）。
- 快照查询失败/超时（高负载下 PowerShell/CIM 超过各自上限）：本设计**不**为这种情况兜底——`processTreeOwnership` 拿不到 root 身份就 fail closed，一条 taskkill 都不发，waiter 按绝对 deadline 报残留。这是既有的安全取舍（宁可漏杀也不误杀复用 PID），不属于本节重切范围；见「遗留」。

## 所有权与不变式

- 预算的唯一所有者是 `zcodeStdioTransport`（它构造绝对 deadline 并把各阶段上限显式传给 terminator/waiter）；terminator 只做「不超过调用方给的窗口、且不超过绝对 deadline」的夹取，不再自行假设阶段时长。
- waiter 仍只预留**一条**命令槽（强杀命令）：礼貌命令已被限制在 force 触发点之前，不可能与强杀并发。
- `I1` 总预算不增加：3250ms ≤ Host service-dispose 3500ms。
- `I2` 强杀阶段始终有真实窗口：触发点到 deadline 恒为 `1500 + 250`。
- `I3` 预算不足时跳过礼貌阶段，并留 debug 日志（`zcode-agent-process-tree` scope）。
- `I4` 常见路径逐位不变：POSIX 全部不变；Windows 正常 EOF 退出路径不变。
- `I5` 语义可被不依赖负载的用例钉住：见「验证」中的 fake-timer 用例。

## 失败语义

- 命令窗口不足（`≤ 0`）或礼貌预算为 0：跳过并记 debug，不产生「命令被自己掐断」的假象；最终判定仍由 waiter 按 PID 存活 + child exit 事实给出。
- 强杀命令仍在窗口内完成不了（例如 >1.4s 的极端负载）：waiter 在绝对 deadline 报残留，transport 抛 `runtime process tree cleanup incomplete`，manager 保留快照并在 app quit 时重试（重试把 1750ms 全给强杀命令，且复用上一轮快照，不再重跑查询）。此处不引入任何新的静默成功路径。
- 快照越线被截断：只影响「后代身份」的完整度，不影响强杀是否发生；截断时按活着的 child 句柄打根 PID。
- 绝不为了「看起来成功」放宽残留判定或延长总预算。

## 迁移边界

- 对既有行为的影响：正常关闭（agent 响应 EOF）无变化；POSIX 无变化；快照路径逐位不变（快照的调用参数、上限与 fail-closed 语义都没动）。
- 有意改变的两处，均发生在「agent 无视 EOF」这条异常路径：
  1. Windows 礼貌窗口由最坏 ~2000ms 收到最坏 ~1500ms（且要先扣掉 ~1.35s 的快照耗时，实际往往只剩一百多毫秒）。若某个 agent 在 EOF 后需要更久才能收尾，现在会被强杀而不是自然退出——这是 `I1`（总预算不涨）+ `I2`（强杀必须可靠）在 3250ms 内的必然取舍。
  2. 之前会发出去的、注定失败的礼貌 `/T` 在预算为 0 时不再发出（只留 debug 日志）。
- 不动跨包内容：Host 的 3.5s phase 不变，`zcodeAgentProcessManager` 行为不变，快照/身份核对实现不变。

## 验证

- `packages/services/test/processTreeTerminator.windows.test.ts`（fake timer + 注入 runner，不 spawn 真进程，不依赖负载）：
  - 礼貌预算为 0 时只发强杀命令（`force: true`）且不发礼貌命令；
  - 礼貌命令窗口被夹在剩余礼貌预算内（不占用强杀窗口）；
  - 强杀命令窗口被绝对 deadline 减去退出观察窗口后夹住；
  - 绝对预算耗尽到无法为观察留窗口时不发命令。
- `packages/services/test/zcodeStdioTransport.processTree.test.ts`：绝对 deadline 仍为 3250ms，各阶段上限（1500/1000/250）显式落在传给 terminator 的选项里。
- `packages/services/test/zcodeAgentProcessManager.test.ts`：`protocol close 后仍回收 Host 已启动的全部 agent 进程`（真实进程，连跑 5 次）。

## 遗留（需要你定，或另立任务）

**本轮改动的定位（不要误读为"彻底解决"）**：本次只在**现有 3250ms 封套内**保证「强杀阶段真的拿到一个够用的窗口」，让 `taskkill /T /F` 不再被自己的 `execFile` timeout 掐断。它没有消除下面第 1 项的根因——封套（Host `service-dispose` 3.5s）本身小于本机的真实硬成本，Windows 上不存在一个「完整快照 + 完整礼貌窗口 + 可靠强杀」都能装下的切法；只要快照在高负载下触顶，清理仍会 fail closed。第 1、2 项均**本轮不改**（已裁决：跨包/另立任务），登记如下。

1. **封套偏小：快照是强杀的前提，却也是最脆弱的一环**（本轮不改，待立项）：PowerShell/CIM 全量进程表查询实测硬成本 ~1.35s，高负载下超过自身上限（2500ms，且受 3250ms deadline 约束）会被 SIGTERM；此时 `processTreeOwnership` 拿不到 root 身份就 fail closed，一条 taskkill 都不发，cleanup 报残留并重试（重试同样拿不到身份 ⇒ 同样不杀）。实测证据见下面第二段日志。两条候选路线及代价：
   - **换掉 PowerShell 快照**（`packages/services/src/process/windowsProcessListAsync.ts`；单是 PowerShell 启动就 775ms）→ 改用原生 PPID / 创建时间来源，或对「本进程自己 spawn 的 root」直接信任 `child.pid`。代价：省下约 1s（是唯一能同时保住三方需求的路），但要重新评估 fail-closed 的防误杀前提（当前不信任裸 PID 就是为了防 PID 复用），属独立任务。
   - **放大封套**（Host `packages/desktop/src/host/index.ts` 的 `service-dispose` 3.5s → ~4.5s）→ 跨包改动，且改的是应用关闭语义（用户可感知的关闭变慢），需单独立项评估。
2. **兄弟用例在高负载下的 fail-closed 偶发**（本轮不改）：`zcodeAgentProcessManager.test.ts` 全量跑（同文件多进程并用）时，CIM 查询更容易超上限，于是「无视 EOF 的假 agent」类用例会以不同名字偶发失败（实测：全量 3 次里 1 次失败，失败用例每次不同，均为 `runtime process tree cleanup incomplete`）。**与本次改动的边界**：触发点在快照查询 + `processTreeOwnership` 身份核对，这两处代码不在本次 diff 内（本次只改 taskkill 命令窗口与礼貌阶段门控），改动前后该偶发的成因与表现一致；单独跑该用例 3/3 通过。
3. **测试观测性**：`zcodeAgentProcessManager.test.ts` 的 `beforeEach` 会清掉 `ZCODE_RUNTIME_ENV`，因此用例里看不到本模块的 debug 级预算日志（跳过礼貌阶段、命令窗口被夹取等）。若以后要按日志断言预算决策，需要给测试一个显式的日志通道或注入 logger。

## 证据（2026-10-24 本机实测）

`taskkill` 单命令耗时（同机、同会话、串行探测脚本）：

| 场景                                    | 耗时                                      |
| --------------------------------------- | ----------------------------------------- |
| `taskkill /PID x /T /F`，单树           | 638ms / 710ms / 753ms / 928ms / 1101ms    |
| `taskkill /PID x /T /F`，2–4 路并发     | 1216 / 1309 / 1367 / 1376 / 1873 / 1907ms |
| `taskkill /PID x /T`（无 /F，必然失败） | 640–1010ms（并发时 1516–1926ms）          |
| 混合（礼貌+强杀并发，2 agent）          | 强杀 1883 / 1988ms                        |

进程树快照（`Get-CimInstance Win32_Process` 全量枚举，含单个 PowerShell 启动）耗时 8 次采样 1277–1402ms（中位 1368ms，597 个进程）；单 PowerShell 启动就要 775ms；改成属性投影 / `ConvertTo-Csv` / 定向 `-Filter` 都在 1.3s 以上，属平台硬成本。

失败用例日志（修改前，`pnpm exec vitest run packages/services/test/zcodeAgentProcessManager.test.ts -t "protocol close 后仍回收"`）：

```
07:12:33.587 请求 runtime 进程树退出失败 pid=21560  taskkill /PID 21560 /T     (killed: SIGTERM, 满 1000ms)
07:12:33.619 强制清理 runtime 进程树退出失败 pid=21560 taskkill /PID 21560 /T /F (killed: SIGTERM, 满 1000ms)
07:12:33.688 runtime 进程树绝对 deadline 后仍有残留 pid=21560
07:12:33.705 ZCode agent process cleanup retrying during protocol close
```

高负载下另一种成因（修改前后都会发生，机器上有三个 node 进程因内存不足崩溃的同一时段）：

```
07:42:22.959 查询 Windows runtime 进程表失败（异步）: Command failed: powershell.exe … Get-CimInstance Win32_Process …
             killed: true, signal: 'SIGTERM'      ← 快照查询吃满自己的 2500ms 上限
07:42:23.397 runtime 进程树绝对 deadline 后仍有残留 pid=45160   ← 强杀窗口只剩 ~180ms，命令被掐断，进程存活
```
