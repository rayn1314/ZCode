// ============================================================
// provider-request-policy 对外契约：per-provider 请求策略（RPM 限速 + 并发硬上限）的装配面与执行面
// ============================================================
// 意图：服务商侧的节奏约束本就长在**账号**上（不分主代理 / 子代理 / workflow）。本模块把约束做成
// **端口上的一层装饰**——谁拿到端口谁受限，调用方不需要在每个发送点各自记得加限速，只需要记得
// 带端口。两个旋钮见 schema：`requestsPerMinute`（令牌桶）与 `maxConcurrent`（治理器的 provider
// 闸门，见 workflow-concurrency-governor）。
//
// 调用方必须知道的不变量（完整语义见本目录 CONTRACT.md 与
// `bootstrap/spec/provider-request-rate-limit.md`）：
//
// 1. **等待顺序是载荷性的**：`awaitRateLimit` 必须在抢并发槽**之前**。反了会形成「持槽者等令牌 →
//    令牌要等已发出的请求 → 别人在排队等槽」的三方互等环。限速层只读自己的令牌桶，不碰任何槽。
// 2. **绝不 fail-open**：跨进程账本（共享文件锁）不可达时退回**进程内**限速，不是「不限制」。
//    代价只是合计可能超配额；反过来会让一次挂载失败变成完全不限速。
// 3. **非法配额等于不限速**：0 / 负数 / 非有限数一律按「不限制」处理（0 会让配额永远补不满，
//    那是把所有请求永久挂起）。不限速的 provider 不建桶、不排定时器、不留任何状态。
// 4. **桶的键是 providerId**：一条 provider 配置 = 一份策略 = 一个桶，Windows 桌面与 WSL 远端
//    同名即共享。同一家供应商的不同 Key 合用一个桶——要各算各的就多建 provider 配置。
// 5. **限速器自身不抛错、不干预重试**：abort 时等待者立刻摘除并 reject；真撞 429 仍走既有退避。
// 6. **共享的并发读数是收敛的，不是严格配额**：两端各广告自己的在飞数，对方按 `N − 别人` 收窄上限。
//    读数有刷新间隔（对方保活 1s、本地重读 ≥150ms），窗口内可能短暂超发，最坏退到「各限各的」，
//    稳态收敛到 N。它没有可泄漏的共享状态——进程崩了、报告过期即止。

/** 端口的模型身份：配额键的最小事实。直接复用契约层，避免各调用点自造 providerId/modelId 形状。 */
export type { ModelRequestTarget } from "@zcode/contracts";

// ---- 执行面：配额闸门本身 ----
// 唯一实现是进程单例（`getProviderRateLimiter`），装配点只有 `create-app.ts` 一处。
export {
  createProviderRateLimiter,
  getProviderRateLimiter,
  withProviderRateLimit,
} from "../app/provider-rate-limiter.js";
export type {
  ProviderRateLimitPort,
  ProviderRateLimiterOptions,
  ProviderRequestsPerMinuteResolver,
} from "../app/provider-rate-limiter.js";

// ---- 装配面：账本位置 ----
// 「账本落在哪个文件」既不属于账本（纯文件语义）也不属于限速器（纯配额语义），只能由装配层决定；
// 单独成函数是为了让这段决策能被单测钉住。桶键是 providerId，由限速器直接取用。
export { createProviderQuotaSharing } from "../app/provider-quota-wiring.js";
export type {
  ProviderQuotaSharing,
  ProviderQuotaSharingInput,
} from "../app/provider-quota-wiring.js";

// ---- 跨进程账本：同机多端的共享余额 ----
// 实现里任何「拿不到账本」都 throw（由限速器降级），绝不用「拿不到就当没限制」的方式返回成功。
export {
  PROVIDER_QUOTA_SHARED_FILE_ENV,
  createFileProviderQuotaStore,
  resolveProviderQuotaSharedFilePath,
} from "../app/provider-quota-shared-store.js";
export type {
  FileProviderQuotaStoreOptions,
  ProviderQuotaConsumeOutcome,
  ProviderQuotaSharedStore,
} from "../app/provider-quota-shared-store.js";

// ---- 令牌桶的纯数学 ----
// 进程内限速器与共享账本共用同一套公式（单源），所以「同一份额度」只有一种节奏。
export {
  MINUTE_MS,
  msUntilNextQuotaToken,
  normalizeRequestsPerMinute,
  refillQuotaState,
} from "../app/provider-quota-math.js";
export type { QuotaState } from "../app/provider-quota-math.js";

// ---- 跨进程并发读数：同机两端分同一份并发额度 ----
// 「广告 + 收敛」：每个进程只写自己的在飞数，对方按 `N − 别人` 收窄自己的上限。无锁、无租约、
// 没有可泄漏的槽位；读不到就退回「各限各的」。进程级单例——一个进程里多个 app 共用一份读数，
// 否则对方会把同一批请求数重复加一遍。
export {
  CONCURRENCY_SHARED_DIR_NAME,
  createProviderConcurrencySharedView,
  getProviderConcurrencySharedView,
} from "../app/provider-concurrency-shared.js";
export type {
  ProviderConcurrencySharedView,
  ProviderConcurrencySharedViewOptions,
} from "../app/provider-concurrency-shared.js";
