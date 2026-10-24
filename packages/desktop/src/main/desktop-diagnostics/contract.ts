/**
 * desktop-diagnostics 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：桌面主进程**出事时留下的痕迹**收在两处，两处都是纯函数/纯策略、不依赖 electron：
 * 1. JS 层致命异常（未捕获异常 / 未处理的 rejection）必须落日志而不是无声退出；
 * 2. 「导出日志包里什么能进包」的路径策略（默认拒绝，产物会被用户转发出去）。
 *
 * 规格：packages/desktop/spec/crash-capture.md、packages/desktop/spec/export-log-archive-scope.md。
 */
export {
  isDatabaseArchivePath,
  isExcludedRelativePath,
  shouldApplyLogExportRetention,
} from "#src/main/exportLogArchivePolicy.js";
export { registerProcessLevelErrorCapture } from "#src/main/desktopProcessErrorCapture.js";
export type {
  ProcessErrorCaptureOptions,
  ProcessErrorCaptureTarget,
} from "#src/main/desktopProcessErrorCapture.js";

/**
 * `registerProcessLevelErrorCapture(logger, options)`（`desktopProcessErrorCapture.ts`）在 main 启动
 * 最早期注册两个监听。没有它时，未捕获异常走 Node 默认路径：打印到无人收集的 stderr 后静默退出，
 * Windows 上不留 dump、不留 WER 事件、不留日志，用户只看到「闪退」。
 *
 * 前置：在 main 进程启动最早期调用一次；`logger` 只需实现 `error(...)`（desktop logger 是
 * `appendFileSync` 同步落盘，无需额外 flush）；`target` 默认当前进程，测试注入 EventEmitter 以隔离
 * node:test 的全局兜底；`exit` 默认 `process.exit`，测试注入以断言。
 * 后置（契约要点）：
 * - `uncaughtException` → `logger.error("[crash-capture] uncaughtException:", error)`，随后
 *   **下一轮事件循环** `exit(1)`。让出一次事件循环是为了让同进程其它监听者（如 ARMS SDK 的
 *   jsError 采集）先跑完；desktop logger 是 `appendFileSync` 同步落盘，日志无需额外 flush。
 *   不改用优雅退出：异常后进程状态未定义，优雅路径可能挂死在 host 清理等待上。
 * - `unhandledRejection` → 只 `logger.error("[crash-capture] unhandledRejection:", reason)`，
 *   **不退出**（进程状态未定义，由后续操作自行暴露）。
 * - **进程内幂等**：同一 target 重复注册是空操作（否则同一次崩溃会被记录两遍、退出两次）。
 */

/**
 * `isExcludedRelativePath(relativePath)` / `isDatabaseArchivePath(relativePath)`（`exportLogArchivePolicy.ts`）：
 * 导出包路径策略的**全部**判定（消费方是 `exportLogs.ts` 的收集阶段：按相对路径跳过即不进包；
 * 该文件只做 IO、脱敏与时间窗口保留，不再内联任何路径规则）。
 *
 * 立场是**默认拒绝**：宁可少收也不能漏收凭据。判定按 `/` 边界做路径段匹配（`repo-backup`、
 * `sessions-old` 不能被 `repo`、`sessions` 整目录丢掉），入参的 `\` 先归一成 `/`；
 * 凭据文件名与 `debug` 目录段**折叠大小写**后比对（`CREDENTIALS.JSON`、`Debug/` 同样排除）。
 * 排除族：凭据存储文件（按文件名，不同提供商可能复用同名文件）、数据库文件（`.sqlite`/`.db` 及其
 * `-wal`/`-shm` 旁路，顶层单文件不受目录型规则约束）、非日志状态目录（`crash`：crashpad dump 是
 * 崩溃瞬间的内存快照、凭据与正文会随内存落盘）、高频轨迹（`dev`）、docshot 备份、已退役的 ACP
 * runtime（老用户数据里仍有旧代理证书私钥）、`debug` 目录段、macOS `Library/Caches`。
 *
 * 契约要点：**不改内容、不做内容级判断**——minidump 与 sqlite 的敏感内容不以键值形态存在，
 * 现有脱敏正则的前提就是键值结构；需要导出二进制诊断材料时走显式白名单，默认仍拒绝。
 */

/**
 * `shouldApplyLogExportRetention(archivePath)`：只有 `logs/` 与 `.zcode/cli/log/` 两类**日志**目录
 * 参与导出包的保留（体积）策略；其它路径（含反馈包只取的那几处之外的任何东西）都不走这条。
 * 纯判定，不读盘、不改文件。
 */
