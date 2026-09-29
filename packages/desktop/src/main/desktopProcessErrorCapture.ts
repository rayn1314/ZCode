/**
 * 主进程 JS 层异常捕获。
 *
 * 没有注册 uncaughtException 处理器时，未捕获异常走 Node 默认路径：
 * 打印到无人收集的 stderr 后静默退出——Windows 上不留 dump、不留 WER 事件、不留日志，
 * 用户只看到「闪退」（2026-09-29 自建版托盘点击后无声消失的死亡签名，见 spec/crash-capture.md）。
 * 注册处理器后 Node 的默认退出被接管，这里必须补上等价的退出语义，只把「无声」变成「有据可查」：
 * desktop logger 是 appendFileSync 同步落盘，日志无需额外 flush；
 * 让出一次事件循环，让同进程其它监听者（如 ARMS SDK 的 jsError 采集）先跑完，再以致命码退出。
 * unhandledRejection 维持既有语义：记录但不退出（进程状态未定义，由后续操作自行暴露）。
 */

interface ProcessErrorCaptureLogger {
  error: (...args: unknown[]) => void;
}

export interface ProcessErrorCaptureTarget {
  on(eventName: "uncaughtException", listener: (error: Error) => void): unknown;
  on(eventName: "unhandledRejection", listener: (reason: unknown) => void): unknown;
}

export interface ProcessErrorCaptureOptions {
  /** 事件目标默认为当前进程；测试注入 EventEmitter 隔离，避免触发 node:test 的全局兜底。 */
  target?: ProcessErrorCaptureTarget;
  /** 注入退出函数仅供测试断言；生产走 process.exit。 */
  exit?: (code: number) => void;
}

const guardedTargets = new WeakSet<ProcessErrorCaptureTarget>();

export function registerProcessLevelErrorCapture(
  logger: ProcessErrorCaptureLogger,
  options: ProcessErrorCaptureOptions = {},
): void {
  // 显式收窄为目标接口类型：与 NodeJS.Process 的联合会让 on() 重载解析失败。
  const target: ProcessErrorCaptureTarget = options.target ?? process;
  if (guardedTargets.has(target)) {
    return;
  }
  guardedTargets.add(target);

  const exitProcess = options.exit ?? ((code: number) => process.exit(code));

  target.on("uncaughtException", (error) => {
    logger.error("[crash-capture] uncaughtException:", error);
    setImmediate(() => exitProcess(1));
  });

  target.on("unhandledRejection", (reason) => {
    logger.error("[crash-capture] unhandledRejection:", reason);
  });
}
