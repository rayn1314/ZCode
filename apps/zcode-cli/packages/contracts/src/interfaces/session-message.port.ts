// ============================================================
// Session Message Port - 跨会话消息投递边界（bootstrap 实现）
// ============================================================
//
// 投递 owner 是 bootstrap：core 只依赖本端口，不直接触达别的会话 runtime。
// 契约层只描述语义与错误形态，不承载任何 I/O；本文件不实现逻辑。

/** 来源身份：正式会话为独立身份，子代理为附属身份。由发送方填充，接收方只读。 */
export type SessionMessageSenderKind = "session" | "subagent";

/**
 * 消息实际落地方式，三档由目标会话可达性决定（见 spec D3）：
 * - `steered`：目标本回合在运行，消息作为引导注入当前回合；
 * - `woken`：目标空闲或已冷（先拉起），消息开启新一轮回合；
 * - `stored`：目标不可达，只写 mailbox，等目标下次自醒 drain。
 */
export type SessionMessageDeliveryStatus = "steered" | "woken" | "stored";

export interface SessionMessageDeliveryRequest {
  /** 目标会话主键，恒为 `sess_*`；子代理即 `sess_subagent_*`，与正式会话同构。 */
  toSessionId: string;
  content: string;
  messageId: string;
  /** 发送方会话 id；子代理为 `sess_subagent_*`，不得伪造正式会话身份。 */
  fromSessionId: string;
  senderKind: SessionMessageSenderKind;
  createdAt: string;
  /** 跨进程幂等键：同一 requestId 的重复投递只应落地一次。 */
  requestId?: string;
}

export interface SessionMessageDeliveryResult {
  toSessionId: string;
  messageId: string;
  /** 如实反映实际落地方式，不因调用未抛错就报 `steered`。 */
  status: SessionMessageDeliveryStatus;
  detail?: string;
}

export interface SessionMessagePort {
  deliver(
    request: SessionMessageDeliveryRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionMessageDeliveryResult>;
}
