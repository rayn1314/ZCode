import type { SessionMessageChain } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";

/**
 * 入站防环链的唯一写入点（spec D7）。
 *
 * `undefined` 即清空，语义由调用方决定：命令面输入不带链代表"人重新开了话头"，链深归零；
 * mailbox 的空 drain 绝不能调用它——没有任何来消息不等于人来插话。
 */
export function noteInboundSessionMessageChain(
  this: AgentRuntimeInternal,
  chain: SessionMessageChain | undefined,
): void {
  this.inboundSessionMessageChain = chain;
}
