import { CoreErrorType, ModelFailureReason, isCoreError } from "@zcode/contracts";
import { projectExecutionErrorPayload } from "../errors/error-payload.js";

/**
 * 子代理失败的「可续跑性」分类。
 *
 * 为什么需要这一层：子代理终态通知与前台失败回执此前只给父代理一句根因文案
 * （如 `Model request failed.`）。父代理读不出这是「供应商抖动」还是「配置错了」，
 * 也就无从判断 SendMessage 续跑是否值得，默认反应只能是重新派发——已花的 token
 * 与已产出的工作一起作废（spec `subagent-continuation-copy.md`）。
 *
 * 分类不新造事实：reason / retryable / statusCode 都来自 adapter 在归一化边界写进
 * 错误链的既有字段（`toAdapterError` 的 context），`projectExecutionErrorPayload`
 * 本来就会沿 cause 链收集它们。这里只是把它们映射成父代理能直接执行的三档。
 */
export type SubagentFailureKind =
  | "transient"
  | "cancelled"
  | "configuration"
  | "inactive"
  | "unknown";

export interface SubagentFailureRecovery {
  kind: SubagentFailureKind;
  /** adapter 给的原始原因（server_error / rate_limited / auth_failed …），用于如实展示。 */
  reason?: string;
  /** adapter 的判定：这次失败是否值得重试。缺省表示错误链里没带这个事实。 */
  retryable?: boolean;
  statusCode?: number;
  /** 看门狗配置的无活动阈值（`inactive` 才有）：与 `<error>` 里那句「inactive for Nms」同源。 */
  timeoutMs?: number;
}

const TRANSIENT_REASONS: ReadonlySet<string> = new Set([
  ModelFailureReason.RateLimited,
  ModelFailureReason.ProviderOverloaded,
  ModelFailureReason.ServerError,
  ModelFailureReason.NetworkError,
  ModelFailureReason.Timeout,
  ModelFailureReason.StreamIdleTimeout,
  ModelFailureReason.StaleConnection,
  ModelFailureReason.ProxyError,
  ModelFailureReason.OffpeakQueued,
]);

/**
 * 这些原因续跑同一个子代理会撞同一堵墙：配置没修、鉴权没过、上下文还是那么大。
 * 注意 `context_exceeded` 归在这里而不是 transient：续跑会立刻再次超窗，正确动作是
 * 收窄范围或换更小的任务，不是「再试一次」。
 */
const CONFIGURATION_REASONS: ReadonlySet<string> = new Set([
  ModelFailureReason.AuthFailed,
  ModelFailureReason.ContextExceeded,
  ModelFailureReason.InvalidRequest,
  ModelFailureReason.ProviderNotConfigured,
  ModelFailureReason.TlsError,
]);

/**
 * 取消在错误链里有两张面孔：adapter 的 `reason: cancelled`，以及 turn/tool 层的
 * `CoreErrorType`。两者都表示「被停下」，不是「坏掉」——之前只认前一张，父轮取消会掉进
 * `unknown`，还顺带把 `createCoreError` 默认的 `retryable: false` 当成事实展示出来。
 */
const CANCELLED_ERROR_TYPES: ReadonlySet<string> = new Set([
  CoreErrorType.TurnCancelled,
  CoreErrorType.ToolCancelled,
  CoreErrorType.Cancelled,
]);

/** 只在这几个类型上把 CoreError 类型本身当作原因事实；其余类型不猜。 */
const CONFIGURATION_ERROR_TYPES: ReadonlySet<string> = new Set([
  CoreErrorType.ModelContextExceeded,
]);

const TRANSIENT_ERROR_TYPES: ReadonlySet<string> = new Set([
  CoreErrorType.ModelRateLimited,
  CoreErrorType.ModelTimeout,
]);

export function classifySubagentFailure(error: unknown): SubagentFailureRecovery {
  // 看门狗最先认：它构造的 CoreError 带 `retryable: true`，但那是「可以再跑」的授权，
  // 不是「供应商抖动」的事实。不先拦下来，文案会把「十分钟没动静」说成 provider 请求失败。
  const watchdogTimeoutMs = readWatchdogTimeoutMs(error);
  if (watchdogTimeoutMs !== undefined) {
    return { kind: "inactive", timeoutMs: watchdogTimeoutMs };
  }

  const attribution = projectExecutionErrorPayload(error).attribution;
  const reason = attribution?.reason;
  const retryable = attribution?.retryable;
  const statusCode = attribution?.statusCode;
  const facts = {
    ...(reason ? { reason } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };

  if (reason === ModelFailureReason.Cancelled || hasErrorType(error, CANCELLED_ERROR_TYPES)) {
    return { kind: "cancelled", ...facts };
  }
  if (
    (reason !== undefined && CONFIGURATION_REASONS.has(reason)) ||
    hasErrorType(error, CONFIGURATION_ERROR_TYPES)
  ) {
    return { kind: "configuration", ...facts };
  }
  // retryable 是 adapter 的权威判定，优先于 reason 白名单：新供应商的未知 reason 只要
  // 标了可重试，就该按瞬时故障处理，而不是掉进 unknown 让父代理自己猜。
  if (
    retryable === true ||
    (reason !== undefined && TRANSIENT_REASONS.has(reason)) ||
    hasErrorType(error, TRANSIENT_ERROR_TYPES)
  ) {
    return { kind: "transient", ...facts, retryable: true };
  }
  return { kind: "unknown", ...facts };
}

/**
 * 沿 cause 链找看门狗的超时错误：`ToolTimeout` + `context.idleMs`（`idleMs` 只有
 * `runner.ts` 的活动看门狗会写，用它把通用的 ToolTimeout 排除掉），取配置的 `timeoutMs`。
 * 用阈值而不是实测 `idleMs`：后者与 `<error>` 里那句「inactive for Nms」不是同一个数，
 * 同一份通知里出现两个数只会让父代理困惑。
 */
function readWatchdogTimeoutMs(error: unknown): number | undefined {
  return walkCauseChain(error, (frame) => {
    if (!isCoreError(frame) || frame.type !== CoreErrorType.ToolTimeout) return undefined;
    const { idleMs, timeoutMs } = frame.context ?? {};
    if (typeof idleMs !== "number" || typeof timeoutMs !== "number") return undefined;
    return timeoutMs;
  });
}

function hasErrorType(error: unknown, types: ReadonlySet<string>): boolean {
  return walkCauseChain(error, (frame) =>
    isCoreError(frame) && types.has(frame.type) ? true : undefined,
  ) === true;
}

function walkCauseChain<T>(
  error: unknown,
  read: (frame: object) => T | undefined,
): T | undefined {
  const seen = new Set<object>();
  let current: unknown = error;
  for (let depth = 0; depth < 12; depth += 1) {
    if (current === null || typeof current !== "object" || seen.has(current)) return undefined;
    seen.add(current);
    const found = read(current);
    if (found !== undefined) return found;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

function describeFailure(recovery: SubagentFailureRecovery): string {
  const facts = [
    recovery.reason,
    // 只展示正向的 retryable：`createCoreError` 会把未指定的 retryable 默认成 false，
    // 那不是 adapter 的判断，写出来就是假精确。
    recovery.retryable === true ? "retryable" : undefined,
    recovery.statusCode === undefined ? undefined : `HTTP ${recovery.statusCode}`,
  ].filter((fact): fact is string => Boolean(fact));
  return facts.length > 0 ? ` (${facts.join(", ")})` : "";
}

/**
 * 前台失败时塞进 CoreError context 的模型面指引：父代理在工具结果里只看到根因
 * message，既没有 agentId 也没有失败类型，根本无从续跑。这段文本补的正是这两件事。
 */
export function formatSubagentFailureGuidance(
  recovery: SubagentFailureRecovery,
  agentId: string,
): string {
  const handle = `SendMessage with to: '${agentId}'`;
  switch (recovery.kind) {
    case "transient":
      return `Failure kind: transient provider error${describeFailure(recovery)} — the provider request failed, not the agent's work. Resume it with ${handle}; do not re-dispatch.`;
    case "configuration":
      return `Failure kind: configuration error${describeFailure(recovery)} — a resume hits the same wall. Fix what the error names or ask the user; do not retry or re-dispatch.`;
    case "cancelled":
      return `Failure kind: cancelled${describeFailure(recovery)} — cancelled, not broken. Resume it with ${handle} only if that cancellation was not the user's.`;
    case "inactive":
      return `Failure kind: inactivity timeout${recovery.timeoutMs === undefined ? "" : ` (no activity for ${recovery.timeoutMs}ms)`} — the run was cut off mid-work, not failed. Resume it with ${handle}; if it goes inactive again, narrow the task.`;
    case "unknown":
      return `Failure kind: unclassified${describeFailure(recovery)}. If it interrupted work the agent already did, resume it with ${handle} instead of re-dispatching; otherwise fix what the error names or re-scope.`;
  }
}
