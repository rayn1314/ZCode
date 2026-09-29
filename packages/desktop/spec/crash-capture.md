# 桌面端崩溃捕获（crash-capture）

> 涉及包：`packages/desktop`（主责）、`packages/shared`（ARMS 闸门常量）。

## 背景与问题

2026-09-29 自建版桌面在托盘点击后主进程无声消失：无 `[app-quit]` 日志、无 render/child-process-gone、
无 WER 事件与 dump、无 crashpad dump。排查确认两个结构性盲区：

1. **主进程 JS 未捕获异常零痕迹**。未注册 `uncaughtException` 处理器时，Node 默认行为是打印到
   无人收集的 stderr 后静默退出；Windows 桌面（打包、自快捷方式启动）不留任何可排查产物。
2. **crashpad 可能整体缺席**。`initializeCrashCapture` 收到 `remoteCrashReporterEnabled=true`
   时跳过本地 crashReporter，前提假设「ARMS 已接管」。但 ARMS 初始化依赖运行时环境变量
   `ZCODE_ARMS_RUM_ENDPOINT`（构建不内嵌，快捷方式启动未设置），SDK 根本不启动——
   于是「以为远端接管了、实际谁都没启动 crashpad」，官方端依赖的
   `~/.zcode/v2/crash/{live,archive}` 归档链路在自建端从未生效。

## 设计决策

- **闸门同源**：shared 新增 `ZCODE_ARMS_RUM_ENABLED`（= `ZCODE_TELEMETRY_ENABLED && ZCODE_ARMS_RUM_ENDPOINT !== ""`），
  作为「ARMS RUM 将初始化」的唯一判定。`appARMSBootstrap`（是否启动远端 SDK）与
  `appCrashCaptureBootstrap`（是否跳过本地 crashReporter）必须消费同一常量，禁止各自展开条件。
- **本地兜底**：`remoteCrashReporterEnabled=false`（即 ARMS 不会启动）时，crash-capture 在启动
  最早阶段启动本地 crashReporter（`uploadToServer: false`），dump 落 `stagingDir/reports`，
  由既有的启动归档链路收进 `crash/archive`。官方端（端点已配置）行为不变：crashpad 由 ARMS 启动。
- **JS 层致命异常语义保持「崩溃即退出」**：注册处理器会接管 Node 的默认退出，因此处理器内
  显式补上等价退出——先同步落盘日志（desktop logger 为 `appendFileSync`，无需 flush 等待），
  `setImmediate` 让出一次事件循环给同进程其它监听者（ARMS jsError 采集），再 `process.exit(1)`。
  不改用 `app.quit()` 做优雅退出：异常后状态未定义，优雅路径可能挂死在 host 清理等待上。

## 行为

- `registerProcessLevelErrorCapture(logger)`（`desktopProcessErrorCapture.ts`）在 main 进程
  启动最早期注册两个监听：
  - `uncaughtException`：`logger.error("[crash-capture] uncaughtException:", error)` 后
    下一轮事件循环 `process.exit(1)`。
  - `unhandledRejection`：`logger.error("[crash-capture] unhandledRejection:", reason)`，
    不退出（维持既有语义）。
  - 进程内幂等，重复注册为空操作。
- 自建/无端点运行态启动后，日志出现
  `[crash-capture] local crashReporter started without remote upload`；
  原生崩溃 dump 会出现在 `crash/live/reports/`，下次启动被归档并打出
  `[crash-capture] restored N local dump(s) from previous runs`。

## 所有权与不变式

- `packages/shared/src/env.ts` 拥有 `ZCODE_ARMS_RUM_ENABLED` 的定义；任何「ARMS 是否可用」
  的判断只允许消费该常量。
- `appCrashCaptureBootstrap.ts` 拥有「远端/本地 crashReporter 由谁启动」的决策；
  `desktopCrashCapture.ts` 只提供机制（配置 dump 路径、启动 crashReporter、归档）。
- `desktopProcessErrorCapture.ts` 拥有 JS 层致命异常的日志与退出语义；不依赖 electron，可单测。
- 不变式：**任一运行态下，进程至少拥有一种崩溃捕获**（本地 crashReporter 或 ARMS crashpad 二选一）。

## 失败语义

- 未捕获异常：保证日志落盘后再退出；若 `process.exit` 前进程因其它原因终止，日志已写完，无丢失窗口。
- `unhandledRejection`：只记录，不改变进程生命周期。
- 本地 crashReporter 启动失败（如 crashpad 初始化异常）：保持 crashReporter API 的既有失败行为，
  不阻断主进程启动；此时退回 WER 兜底。

## 迁移边界

- 官方端（`ZCODE_ARMS_RUM_ENDPOINT` 已配置）：crashReporter 启动方式不变（ARMS 接管），
  行为零变化。
- 自建端/开发态（端点未配置）：新增本地 crashReporter 与 JS 层致命日志；旧日志中的
  `remoteCrashReporterEnabled=false` 行取代原误导性的 `=true`。
- 历史日志中 `unhandledRejection:` 前缀变为 `[crash-capture] unhandledRejection:`，
  排查工具如有字面匹配需同步。
