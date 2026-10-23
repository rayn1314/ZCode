/**
 * session-messaging 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 最常见的一次完整投递：拿到进程级投递端口，把一封跨会话消息交给它，按返回的 status 判断落地方式。
 */
import type { SessionMessageDeliveryRequest, SessionMessageDeliveryResult } from "./contract.js";
import type { SessionMessagingContract } from "./contract.js";

export function exampleSessionMessaging(
  port: Pick<SessionMessagingContract, "deliver">,
  request: SessionMessageDeliveryRequest,
): Promise<SessionMessageDeliveryResult> {
  // 不传 requestId：跨进程路由的关联键缺省时由 messageId 派生，和 v4 幂等键同源。
  return port.deliver(request);
}
