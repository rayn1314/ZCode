// ============================================================
// SessionMessagePort 的协议装配：把 context.sessions / v4 gateway / 冷恢复 /
// mailbox 绑定成 port 的能力窄面（spec D3 的 bootstrap 侧接线）。
// ============================================================
//
// 单一实例、进程级一份：由 ZCodeProtocolAgentServer 构造时创建，注入每个
// createWorkspaceZCodeApp 生成的 runtime（见 workspace-model-runtime.ts）。

import type { SessionMailboxPort, SessionMessagePort } from "@zcode/contracts";
import {
  BootstrapSessionMessagePort,
  SESSION_MESSAGE_CLIENT_ID,
  resolveV4SendResult,
  type SessionMessageDeliveryHost,
  type SessionMessageV4SendInput,
  type SessionMessageV4SendResult,
} from "./session-message-port.js";
import type { ZCodeProtocolAgentServerContext } from "./server-types.js";

/**
 * 进程级跨会话投递端口。mailbox 由调用方（server）按开关解析并注入，与 app 侧的
 * 收件箱适配器指向同一份 root，保证“投递”与“drain”落同一棵树。
 */
export function createBootstrapSessionMessagePort(
  context: ZCodeProtocolAgentServerContext,
  mailbox: SessionMailboxPort,
): SessionMessagePort {
  const host: SessionMessageDeliveryHost = {
    hasResidentSession: (sessionId) => context.sessions.has(sessionId),
    hasActiveTurn: (sessionId) =>
      context.sessions.get(sessionId)?.app.runtime.getActiveTurnInfo() !== undefined,
    ensureSessionResident: async (sessionId) => {
      const gateway = context.v4Gateway;
      if (!gateway) return false;
      await gateway.ensureSessionResident(sessionId);
      return context.sessions.has(sessionId);
    },
    sendViaV4: (input) => sendViaV4(context, input),
    mailbox,
    // 跨进程上报走 v4 sideband 通知（不进 conversation topic / 快照 / replayable）：
    // 源 CLI 触达不到 services 的事件发射器，只能由 Host 侧消费这条通知后再转 main。
    notify: (notification) => context.notify(notification),
    ...(context.logger
      ? { logger: context.logger.child({ module: "bootstrap.session_message" }) }
      : {}),
  };
  return new BootstrapSessionMessagePort(host);
}

/** 构造 sendText 信封交给 v4 命令面：admission/幂等/投影/queue-guide 全走既有语义。 */
function sendViaV4(
  context: ZCodeProtocolAgentServerContext,
  input: SessionMessageV4SendInput,
): Promise<SessionMessageV4SendResult> {
  const gateway = context.v4Gateway;
  if (!gateway) {
    return Promise.resolve({ accepted: false, detail: "fault.command.v4GatewayUnavailable" });
  }
  return gateway
    .handleCommand({
      clientId: SESSION_MESSAGE_CLIENT_ID,
      commandId: input.commandId,
      issuedAt: new Date().toISOString(),
      payload: {
        requestedDelivery: input.requestedDelivery,
        text: input.text,
        // 防环链必须显式进 payload：sendText 的 zod object 会静默剥离未知键。
        ...(input.sessionMessageChain ? { sessionMessageChain: input.sessionMessageChain } : {}),
      },
      sessionId: input.sessionId,
      type: "sendText",
    })
    .then(resolveV4SendResult);
}
