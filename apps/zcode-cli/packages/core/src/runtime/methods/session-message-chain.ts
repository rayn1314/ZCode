import { SESSION_MESSAGE_CLIENT_ID } from "@zcode/shared";
import type { SessionMessageChain, TurnInputIntentMetadata } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 入站防环链的唯一写入点（spec D7）。
 *
 * `undefined` 即清空，语义由调用方决定：**只有人类输入才清链**（审计修复 #4）；
 * 会话间消息无链不代表人重新开了话头，清链会让互相回信绕过 hop 计数。
 * mailbox 的空 drain 绝不能调用它——没有任何来消息不等于人来插话。
 */
export function noteInboundSessionMessageChain(
  this: AgentRuntimeInternal,
  chain: SessionMessageChain | undefined,
): void {
  this.inboundSessionMessageChain = chain;
}

/** 命令面输入对入站链的三态动作（set / clear / keep），便于单测直接断言裁决。 */
export type InboundChainIntentAction =
  | { kind: "set"; chain: SessionMessageChain }
  | { kind: "clear" }
  | { kind: "keep" };

/**
 * 命令面输入（`ExecuteTurnOptions.intent` 在场）如何改写入站链（spec D7 修订 + 审计修复 #4）。
 *
 * - 带链 → 记录该链（会话消息的正常传播，不变）；
 * - 无链且提交端是会话消息机器（`session-message-port`：同进程直投、Host 实时投递
 *   与回执）→ **不清链**：回执/无链信封若按"人重新开话头"清链，A↔B 循环里插一条
 *   回执就让 hop 计数归零，cap 失效；
 * - 无链的其它命令面输入（用户 prompt、goal、compact 等）→ 清链，保持"人再说一句话
 *   即重置链深"。core 内部派生轮次不带 intent，压根不会走到这里。
 */
export function inboundChainIntentAction(
  intent: Pick<TurnInputIntentMetadata, "clientId" | "sessionMessageChain">,
): InboundChainIntentAction {
  if (intent.sessionMessageChain) return { kind: "set", chain: intent.sessionMessageChain };
  if (intent.clientId === SESSION_MESSAGE_CLIENT_ID) return { kind: "keep" };
  return { kind: "clear" };
}
