// 跨进程会话消息的信封与收件箱契约（Host 侧）。
//
// Host services 与 CLI 共用同一棵 mailbox 目录树（`~/.zcode/mailbox`，可由
// ZCODE_MAILBOX_ROOT 覆盖）：源 CLI 落盘持久副本 → main 路由到目标 Host →
// 目标 Host 实时投递命中后按 messageId 消费掉信封，避免 live 注入 + 下次 drain 重复投递。
// 文件名 / 根目录规则由 @zcode/shared 的 session-mailbox 统一，两个进程不再各写一套。

import type { SessionMessageChain } from "@zcode/shared/zcode-protocol-v4";

export type SessionMessageSenderKind = "session" | "subagent";

export interface SessionMessageSendRequested {
  content: string;
  createdAt: string;
  fromSessionId: string;
  messageId: string;
  requestId: string;
  toSessionId: string;
  /**
   * 来源身份（独立会话 / 附属子代理）。跨进程链路必须保留它，否则目标侧回写信封或注入
   * 文本会退化成 `session`，接收方无法区分来源（spec D4 身份不变式）。
   */
  senderKind?: SessionMessageSenderKind;
  /**
   * 防环链（spec D7）：跨进程原样透传。接收侧**不做** cap 裁决——拒绝只发生在发送方端口，
   * 这里因链深丢消息等于静默吞消息。
   */
  sessionMessageChain?: SessionMessageChain;
}

export interface SessionMessageDeliveryResult {
  error?: string;
  messageId: string;
  requestId: string;
  sessionId: string;
  status: "success" | "failed";
}

/** mailbox 信封的 Host 侧形状；字段与 CLI 契约层 `SessionMailboxEnvelope` 一致。 */
export interface SessionMessageMailboxEnvelope {
  version: 1;
  messageId: string;
  fromSessionId: string;
  toSessionId: string;
  content: string;
  createdAt: string;
  senderKind?: SessionMessageSenderKind;
  /** 防环链（spec D7）：落盘信封必须保住它，否则目标 CLI drain 时链在接收侧断掉。 */
  chain?: SessionMessageChain;
}

/**
 * 目标侧收件箱的窄面：只做落盘与按 messageId 消费，不判断可达性
 * （可达性分档由交付层决定）。目录不可写时抛错，不假装成功。
 */
export interface SessionMessageMailboxPort {
  deliver(envelope: SessionMessageMailboxEnvelope): Promise<void>;
  /** 幂等：命中并删除返回 true，信封已不在返回 false；真实 IO 故障向上抛。 */
  consume(input: { sessionId: string; messageId: string }): Promise<boolean>;
}
