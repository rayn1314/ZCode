import { ZCODE_ARMS_RUM_ENABLED } from "@zcode/shared";
import { logger } from "./logger.js";
import { initializeCrashCapture, type CrashCapturePaths } from "./desktopCrashCapture.js";

// 须在 appARMSBootstrap 之前完成：先由 desktopEarlyDataBaseDirBootstrap 注入 dataBaseDir，再配置 crashDumps。
// remoteCrashReporterEnabled 必须与 ARMS 的初始化闸门（ZCODE_ARMS_RUM_ENABLED）同源：
// 端点未配置时 ARMS 根本不会启动 crashpad，若这里仍假设「远端已接管」而跳过本地 crashReporter，
// 整个进程就处于零崩溃捕获状态（原生崩溃只剩 WER、JS 异常零痕迹，见 spec/crash-capture.md）。
export const crashCapturePaths: CrashCapturePaths = initializeCrashCapture(
  logger,
  ZCODE_ARMS_RUM_ENABLED,
);
