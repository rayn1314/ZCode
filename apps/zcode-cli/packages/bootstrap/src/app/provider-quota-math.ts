// ============================================================
// 令牌桶的纯数学：进程内限速器与跨进程共享账本共用同一套公式
// ============================================================
// 抽出来是为了**单源**：共享账本要在文件里补算令牌，进程内限速器要在内存里补算令牌，两边若各写
// 一遍公式，迟早会漂移成「同一份额度、两种节奏」。这里只吃三个标量，不碰任何 IO 与定时器。

export const MINUTE_MS = 60_000;

/** 令牌桶的最小状态：余额 + 上次补算时刻。进程内的桶在此之上还有等待者队列与唤醒定时器。 */
export interface QuotaState {
  requestsPerMinute: number;
  /** 令牌余额（浮点，按经过时间补齐）。 */
  tokens: number;
  /** 上次补算的时刻。 */
  updatedAtMs: number;
}

/** 配出来的值是否可用。0 与负数会让配额永远补不满——那不是限速，是把所有请求永久挂起。 */
export function normalizeRequestsPerMinute(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : undefined;
}

/** 按经过时间补令牌。桶容量 = 每分钟请求数（满桶即允许一次 N 连发）。 */
export function refillQuotaState(state: QuotaState, nowMs: number): void {
  const elapsed = nowMs - state.updatedAtMs;
  // 时钟回拨（系统改时间、NTP 校正、跨环境的时钟偏差）不该凭空造出令牌：负的时间差当作没经过。
  if (elapsed <= 0) {
    state.updatedAtMs = nowMs;
    return;
  }
  state.updatedAtMs = nowMs;
  state.tokens = Math.min(
    state.requestsPerMinute,
    state.tokens + (elapsed * state.requestsPerMinute) / MINUTE_MS,
  );
}

/** 距下一个令牌还有多少毫秒（至少 1ms，向上取整——0 会让定时器空转烧 CPU）。 */
export function msUntilNextQuotaToken(state: QuotaState): number {
  const missing = 1 - state.tokens;
  if (missing <= 0) return 1;
  return Math.max(1, Math.ceil((missing * MINUTE_MS) / state.requestsPerMinute));
}
