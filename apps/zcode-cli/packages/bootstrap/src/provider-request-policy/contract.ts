// ============================================================
// provider-request-policy 对外契约：per-provider「每分钟请求数」客户端限速的装配面与执行面
// ============================================================
// 意图：服务商侧的配额约束本来就是「每分钟 N 次」，且长在**账号**上（不分主代理 / 子代理 /
// workflow）。本模块把这条约束做成**端口上的一层装饰**——谁拿到端口谁受限，调用方不需要在每个
// 发送点各自记得加限速，只需要记得带端口。
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
// 4. **桶的键是账号指纹**（providerId + 协议 + 端点 + 凭据哈希），不是 providerId：同一个
//    providerId 配了不同 Key 的两个账号本就该各算各的。凭据只进哈希，文件里看不到 Key。
// 5. **限速器自身不抛错、不干预重试**：abort 时等待者立刻摘除并 reject；真撞 429 仍走既有退避。

/** 端口的模型身份：配额键的最小事实。直接复用契约层，避免各调用点自造 providerId/modelId 形状。 */
export type { ModelRequestTarget } from "@zcode/contracts";

// ---- 执行面：配额闸门本身 ----
// 唯一实现是进程单例（`getProviderRateLimiter`），装配点只有 `create-app.ts` 一处。
export {
  createProviderRateLimiter,
  createRateLimitOnlyAdmission,
  getProviderRateLimiter,
  withProviderRateLimit,
} from "../app/provider-rate-limiter.js";
export type {
  ProviderRateLimitPort,
  ProviderRateLimiterOptions,
  ProviderRequestsPerMinuteResolver,
  ProviderSharedQuotaKeyResolver,
} from "../app/provider-rate-limiter.js";

// ---- 装配面：账本位置与桶键 ----
// 「账本落在哪个文件、桶按什么键分」既不属于账本（纯文件语义）也不属于限速器（纯配额语义），
// 只能由装配层决定；单独成函数是为了让这段决策能被单测钉住。
export { createProviderQuotaSharing } from "../app/provider-quota-wiring.js";
export type {
  ProviderConfigReader,
  ProviderQuotaSharing,
  ProviderQuotaSharingInput,
} from "../app/provider-quota-wiring.js";

// ---- 跨进程账本：同机多端的共享余额 ----
// 实现里任何「拿不到账本」都 throw（由限速器降级），绝不用「拿不到就当没限制」的方式返回成功。
export {
  PROVIDER_QUOTA_SHARED_FILE_ENV,
  computeSharedQuotaKey,
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
