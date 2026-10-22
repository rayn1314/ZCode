import { ModelFailureReason } from "@zcode/contracts";
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
export type SubagentFailureKind = "transient" | "cancelled" | "configuration" | "unknown";

export interface SubagentFailureRecovery {
  kind: SubagentFailureKind;
  /** adapter 给的原始原因（server_error / rate_limited / auth_failed …），用于如实展示。 */
  reason?: string;
  /** adapter 的判定：这次失败是否值得重试。缺省表示错误链里没带这个事实。 */
  retryable?: boolean;
  statusCode?: number;
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

export function classifySubagentFailure(error: unknown): SubagentFailureRecovery {
  const attribution = projectExecutionErrorPayload(error).attribution;
  const reason = attribution?.reason;
  const retryable = attribution?.retryable;
  const statusCode = attribution?.statusCode;

  if (reason === ModelFailureReason.Cancelled) {
    return {
      kind: "cancelled",
      ...(reason ? { reason } : {}),
      ...(retryable === undefined ? {} : { retryable }),
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }
  if (reason !== undefined && CONFIGURATION_REASONS.has(reason)) {
    return {
      kind: "configuration",
      reason,
      ...(retryable === undefined ? {} : { retryable }),
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }
  // retryable 是 adapter 的权威判定，优先于 reason 白名单：新供应商的未知 reason 只要
  // 标了可重试，就该按瞬时故障处理，而不是掉进 unknown 让父代理自己猜。
  if (retryable === true || (reason !== undefined && TRANSIENT_REASONS.has(reason))) {
    return {
      kind: "transient",
      ...(reason ? { reason } : {}),
      retryable: true,
      ...(statusCode === undefined ? {} : { statusCode }),
    };
  }
  return {
    kind: "unknown",
    ...(reason ? { reason } : {}),
    ...(retryable === undefined ? {} : { retryable }),
    ...(statusCode === undefined ? {} : { statusCode }),
  };
}

function describeFailure(recovery: SubagentFailureRecovery): string {
  const facts = [
    recovery.reason,
    recovery.retryable === undefined
      ? undefined
      : recovery.retryable
        ? "retryable"
        : "not retryable",
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
      return [
        `Failure kind: transient provider error${describeFailure(recovery)}. The task itself did not fail — this agent's session, its completed tool calls, and everything it already produced are preserved.`,
        `Resume it instead of dispatching a new agent: call ${handle} and tell it to pick up where it stopped and report what it has. Re-dispatching repeats the work it already did.`,
      ].join(" ");
    case "configuration":
      return [
        `Failure kind: configuration error${describeFailure(recovery)}. Resuming the same agent will hit the same error — this is not a transient fault.`,
        "Fix what the error names (provider, credentials, model, or context size) or ask the user. Do not dispatch a new agent for the same task, and do not simply retry.",
      ].join(" ");
    case "cancelled":
      return [
        `Failure kind: cancelled${describeFailure(recovery)}. The agent was stopped rather than broken.`,
        `If the work is still wanted, resume it with ${handle}; otherwise leave it stopped and do not dispatch a replacement.`,
      ].join(" ");
    case "unknown":
      return [
        `Failure kind: unclassified${describeFailure(recovery)}.`,
        `If this looks like it interrupted work the agent had already done, resume it with ${handle} instead of re-dispatching; otherwise fix what the error names, or change the scope and dispatch a new agent.`,
      ].join(" ");
  }
}
