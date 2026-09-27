import type {
  ModelAdmissionWaitReason,
  ModelRequestAdmission,
  ModelRequestAdmissionTicket,
  ModelRequestTarget,
} from "@zcode/contracts";

/**
 * 一次尝试的准入。
 *
 * runner 在每次尝试**发出前** `admitAttempt`，拿到票据后才发请求；尝试结束（成功、失败、抛出、消费者
 * 提前放弃流）即 `release`——退避 sleep 期间不持票，所以进程级 cap 约束的是 provider 真正看到的在飞
 * 请求数。票据同时是该尝试的状态事件汇：`publishModelStatus` 把该尝试的事件也投递给它（见
 * `statusPublishOptions`），治理器据此判定结果；`release` 只是兜底，幂等。
 *
 * 请求没有 `modelRequestAdmission` 时返回一个空实现：调用点不必分叉，runner 行为逐字不变。
 */
export interface AttemptAdmission {
  /** 准入票据；请求没有准入端口时缺席（此时 publish 不转投）。 */
  readonly ticket?: ModelRequestAdmissionTicket;
  /** 归还槽位；幂等（finally 与「退避 sleep 之前」两处都会调）。 */
  release(): void;
}

const NO_ADMISSION: AttemptAdmission = { release() {} };

/**
 * 等待准入。**顺序载荷**：先过速率配额，再抢并发槽。
 *
 * 限速等待绝不能放在 `tryAcquire` 之后：并发槽是稀缺资源，而令牌只能靠已发出的请求补充。持槽
 * 等令牌时，槽被一个「等令牌的人」占着，令牌要等别人发请求，别人在排队等槽——三者互等即死锁。
 * 限速层只读自己的令牌桶、不碰任何槽，所以先它后槽不存在环。
 *
 * 速率层缺席（`awaitRateLimit` 未实现）时本函数逐字等于从前：快路径 `tryAcquire`，未命中才排队
 * `acquire`，并在两端回调 `onQueued` / `onAdmitted`。没有快路径的端口分不清「排了队」与「立即
 * 放行」，所以不回调。`signal` 被 abort 时 reject（以 `signal.reason`，与 `sleep` 的 abort 错误
 * 同一形状，由调用方按 cancelled 归类）。
 */
export async function admitAttempt(input: {
  admission?: ModelRequestAdmission;
  model: ModelRequestTarget;
  signal?: AbortSignal;
  onQueued?: (reason: ModelAdmissionWaitReason) => Promise<void>;
  onAdmitted?: (queuedMs: number, reason: ModelAdmissionWaitReason) => Promise<void>;
}): Promise<AttemptAdmission> {
  if (input.admission === undefined) return NO_ADMISSION;
  // 只在**真的等了**配额时才报等待：不限速的 provider 每个请求都发一对 queued/admitted，
  // 只会把「在等并发」这条真信号淹掉。
  if (typeof input.admission.awaitRateLimit === "function") {
    const rateLimitWaitedMs = await input.admission.awaitRateLimit({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (rateLimitWaitedMs > 0) {
      await input.onQueued?.("rate_limit");
      await input.onAdmitted?.(rateLimitWaitedMs, "rate_limit");
    }
  }
  const hasFastPath = typeof input.admission.tryAcquire === "function";
  let ticket = hasFastPath ? input.admission.tryAcquire!({ model: input.model }) : undefined;
  if (ticket === undefined) {
    const queuedAt = Date.now();
    if (hasFastPath) await input.onQueued?.("concurrency");
    ticket = await input.admission.acquire({
      model: input.model,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    if (hasFastPath) await input.onAdmitted?.(Date.now() - queuedAt, "concurrency");
  }
  let released = false;
  return {
    ticket,
    release() {
      if (released) return;
      released = true;
      ticket.release();
    },
  };
}
