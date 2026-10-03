// ============================================================
// Session Message Port - 跨会话消息投递边界（bootstrap 实现）
// ============================================================
//
// 投递 owner 是 bootstrap：core 只依赖本端口，不直接触达别的会话 runtime。
// 契约层只描述语义与错误形态，不承载任何 I/O；本文件不实现逻辑。

/** 来源身份：正式会话为独立身份，子代理为附属身份。由发送方填充，接收方只读。 */
export type SessionMessageSenderKind = "session" | "subagent";

// 防环链（spec D7）的形状由协议层单一拥有：`@zcode/shared` 的 `sessionMessageChainSchema`
// 与 `isValidSessionMessageChain` 是同一份定义（跨进程两侧都按它校验）。这里只转出类型，
// 不在契约层另写一份形状——两份会静默漂移（结构赋值不会报错）。
import type { SessionMessageChain } from "@zcode/shared/zcode-protocol-v4";
export type { SessionMessageChain };

/** 链深上限：链首为 1，超过即拒绝；人类输入会重置链深（spec D7）。 */
export const SESSION_MESSAGE_MAX_HOP = 6;

/**
 * 链深超限：发送侧端口在投递前的唯一裁决结果（spec D7）。
 * 面向模型的 `message` 必须可执行——点明链首与深度，并要求停止回信、汇报用户。
 */
export class SessionMessageChainExceededError extends Error {
  readonly hop: number;
  readonly originMessageId: string;
  readonly toSessionId: string;

  constructor(input: { hop: number; originMessageId: string; toSessionId: string }) {
    super(
      `session_message_chain_exceeded: this message would be hop ${input.hop} of a chain that started with message ${input.originMessageId} (max ${SESSION_MESSAGE_MAX_HOP}). ` +
        "Two sessions appear to be replying to each other; stop replying, summarize what you learned, and report to the user instead.",
    );
    this.name = "SessionMessageChainExceededError";
    this.hop = input.hop;
    this.originMessageId = input.originMessageId;
    this.toSessionId = input.toSessionId;
  }
}

/**
 * 会话级入站链读取口：由接收方 runtime 实现并注入工具上下文。
 * 工具侧只能读，不得自行推导链深（链可能在回合中途被 guide 注入，必须读实时值）。
 */
export interface SessionMessageChainReader {
  current(): SessionMessageChain | undefined;
}

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
  /** 防环链（spec D7）：发送侧按本会话入站链计算；缺席即链首由本次输入开启。 */
  sessionMessageChain?: SessionMessageChain;
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
