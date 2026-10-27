import type { SourceServerConnectionStateSnapshot } from "@zcode/shared";

/**
 * 启动重连失败后的有界自动补试策略（spec `packages/desktop/spec/source-server-startup-retry.md`）。
 *
 * 背景：启动批次对每个候选只探一次，批次级 10s 超时后该 Source 终局 failed，且没有
 * reconnectInputs、不进 offline probe——WSL 冷启动经常超过 10s，用户开局全断只能手动救。
 *
 * 退避节奏 [15s, 45s, 105s] 的依据：
 * - 首档 15s 盖住「探针刚好超时、WSL 仍在拉起」的紧邻窗口（现场日志 elapsedMs=10018）；
 * - 之后指数放大（×3），三次补试加每次 ≤10s 探针，总窗口约 165s + 40s ≈ 3.4 分钟，
 *   覆盖 WSL 冷启动常见的 1-3 分钟区间；
 * - 严格有限：三次后彻底放弃、回到既有 failed 呈现。不做无限轮询——用户可能刻意不开
 *   WSL，超出冷启动窗口后的反复探测只会把已关停的 VM 反复唤醒。
 */
export const STARTUP_RETRY_DELAYS_MS = [15_000, 45_000, 105_000] as const;

export type StartupRetryPlan =
  | { kind: "retry"; attempt: number; delayMs: number }
  | { kind: "exhausted" }
  | { kind: "skip" };

/**
 * 依据已完成的补试次数与失败后的 Profile 状态，决定补试窗口的下一步。
 * - `skip`：终态/用户意图已接管（在线、显式离线、升级待确认、不可重试失败、Profile 已删等），
 *   不进入或立即终止补试窗口；首次调度时的 skip 保持历史行为（安静放弃，不加日志）。
 * - `exhausted`：全部补试用尽，进入既有 failed 呈现。
 */
export function planStartupRetry(input: {
  /** 已完成的补试次数；0 表示首次连接失败后正在决定第一次补试。 */
  retriesSoFar: number;
  stateAfterFailure: Pick<SourceServerConnectionStateSnapshot, "state" | "retryable">;
}): StartupRetryPlan {
  if (!isStartupRetryEligible(input.stateAfterFailure)) return { kind: "skip" };
  const delayMs = STARTUP_RETRY_DELAYS_MS[input.retriesSoFar];
  if (delayMs === undefined) return { kind: "exhausted" };
  return { kind: "retry", attempt: input.retriesSoFar + 1, delayMs };
}

function isStartupRetryEligible(
  state: Pick<SourceServerConnectionStateSnapshot, "state" | "retryable">,
): boolean {
  // bootstrapping：批次级超时先 reject，被中止 flight 的 failed 落盘在其后的微任务里；
  // 调度判定会撞上这个异步间隙。仍进入补试窗口是安全的——误排的补试会被「手动连接/
  // 断开/删除取消挂起重试」或在途 flight 归并吸收。
  if (state.state === "bootstrapping") return true;
  // 只有「普通失败」才自动补试；retryable === false 与其余状态（在线/离线/升级待确认/
  // 身份待确认/更新中/已删除）都是用户动作或终态，自动重试既修不了也会打扰。
  return state.state === "failed" && state.retryable !== false;
}
