# desktop-diagnostics

意图：主进程「出事时留下的痕迹」。两件事：(1) JS 层致命异常的日志与退出语义；(2) 导出日志包里
「什么能进包」的路径策略。两者都是纯函数/纯策略、不依赖 electron（`exportLogs.ts` 依赖 electron 与
services，路径策略不该被这些依赖绑住，所以独立成模块）。

不变量：

- **未捕获异常必须有痕迹再退出**：先同步落日志（desktop logger 是 `appendFileSync`），让出一轮事件
  循环给同进程其它监听者，再 `exit(1)`；不用优雅退出（异常后状态未定义，优雅路径可能挂在 host 清理上）。
- `unhandledRejection` 只记录、不改进程生命周期。
- 崩溃捕获**进程内幂等**：同一事件目标重复注册是空操作。
- 导出包**默认拒绝**：判不进去就不进包；路径段匹配卡 `/` 边界（`repo-backup` 不是 `repo`）。
  排除族含凭据文件、数据库（含 `-wal`/`-shm` 旁路）、非日志状态目录（`crash`：dump 是崩溃瞬间的
  内存快照）、高频轨迹、docshot、已退役 ACP runtime、`debug` 目录段、`Library/Caches`。
  凭据文件名与 `debug` 目录段**折叠大小写**后比对：`CREDENTIALS.JSON`、`Debug/` 同样排除。
- 策略**只看路径、不看内容**：minidump/sqlite 的敏感内容不是键值形态，脱敏正则的前提就是键值结构。
- 保留（体积）策略只作用于 `logs/` 与 `.zcode/cli/log/`。

交集与 hook 点：

- 路径策略的消费方是 `packages/desktop/src/main/exportLogs.ts` 的收集/复制阶段（按相对路径跳过；
  复制阶段对非文本文件跳过并记 root cause：原样复制会绕过脱敏）。该文件只做 IO、脱敏与时间窗口保留，
  路径判定 import 自本模块；`test/exportLogArchivePolicy.test.ts` 读它的源码挡住规则回流。
- 崩溃捕获在 main 最早期注册（`packages/desktop/src/main/index.ts:316`）；「本地 crashReporter 还是
  ARMS crashpad」的选择由 `appCrashCaptureBootstrap.ts` 拥有，本模块只管 JS 层异常的日志与退出。

规格：`packages/desktop/spec/crash-capture.md`、`packages/desktop/spec/export-log-archive-scope.md`。
