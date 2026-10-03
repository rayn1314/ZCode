import {
  HookEventName,
  type SessionId,
  type SessionMailboxEnvelope,
  type SessionMailboxPort,
  type SessionMessageChain,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRegistration } from "./types.js";

const MAILBOX_DRAIN_LIMIT = 20;

export function createSessionMailboxHookRegistrations(options: {
  enqueuePendingInput?: (input: string, traceContext: TraceContext) => Promise<void>;
  mailbox: SessionMailboxPort;
  sessionId: SessionId;
  /**
   * 把本批 drain 出的入站防环链交回 runtime（spec D7）。只在 **drain 出 ≥1 条** 时调用，
   * 且取本批最后一条带链消息的链；空 drain 绝不能调用——没收到消息不等于人重新开话头，
   * 误清链会让互相回信绕过计数。
   */
  noteInboundSessionMessageChain?: (chain: SessionMessageChain | undefined) => void;
}): HookRegistration[] {
  const callback: HookRegistration["callback"] = async (input, context) => {
    const messages = await options.mailbox.drainUnread(
      { sessionId: options.sessionId, limit: MAILBOX_DRAIN_LIMIT },
      { signal: context.signal },
    );
    if (messages.length === 0) return undefined;
    options.noteInboundSessionMessageChain?.(resolveDrainedSessionMessageChain(messages));

    if (input.hookEventName === HookEventName.PostToolUse && options.enqueuePendingInput) {
      for (const message of messages) {
        await options.enqueuePendingInput(formatMailboxMessages([message]), {
          sessionId: options.sessionId,
          traceId: input.traceId,
          turnId: input.turnId,
        });
      }
      return undefined;
    }

    const additionalContext = formatMailboxMessages(messages);
    return {
      ...(input.hookEventName === HookEventName.Stop ? { continue: true } : {}),
      hookSpecificOutput: {
        additionalContext,
        hookEventName: input.hookEventName,
      },
    };
  };

  return [HookEventName.UserPromptSubmit, HookEventName.PostToolUse, HookEventName.Stop].map(
    (event) => ({
      callback,
      descriptor: {
        clientVisible: false,
        commandDisplay: "Session mailbox",
        executionMode: "foreground",
        executionType: "process",
        sourceKind: "internal",
        timeoutMs: 60_000,
      },
      event,
      source: "builtin.sessionMailbox.drain",
    }),
  );
}

function formatMailboxMessages(
  messages: Awaited<ReturnType<SessionMailboxPort["drainUnread"]>>,
): string {
  return messages
    .map((message) =>
      [
        `<session-message source="mailbox" message_id="${escapeAttr(message.messageId)}" from_session="${escapeAttr(message.fromSessionId)}"${senderKindAttribute(message.senderKind)}${chainAttributes(message.chain)} created_at="${escapeAttr(message.createdAt)}">`,
        "For reference only. Verify against raw source before acting.",
        "",
        message.content,
        "</session-message>",
      ].join("\n"),
    )
    .join("\n\n");
}

/**
 * 入站链属性（spec D7 行为 7）：让模型自己也能看到链深。信封没有链时不输出，
 * 注入文本与旧版逐字节一致。
 */
function chainAttributes(chain: SessionMessageChain | undefined): string {
  return chain === undefined
    ? ""
    : ` hop="${chain.hop}" origin="${escapeAttr(chain.originMessageId)}"`;
}

/**
 * 本批 drain 的入站链取"最后一条带链的消息"：同一批里可能混有历史信封（无链），
 * 但最新一条才代表链当前所在位置。整批都没有链则返回 undefined——调用方按"来人没带链"
 * 处理（等于人重新开话头，链深归零），所以只有**空批**才是"什么都不做"。
 */
export function resolveDrainedSessionMessageChain(
  messages: readonly SessionMailboxEnvelope[],
): SessionMessageChain | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const chain = messages[index]?.chain;
    if (chain) return chain;
  }
  return undefined;
}

/**
 * 来源身份属性。旧信封没有 senderKind，此时不输出该属性，注入文本与旧版逐字节一致。
 */
function senderKindAttribute(senderKind: SessionMailboxEnvelope["senderKind"]): string {
  return senderKind === undefined ? "" : ` sender_kind="${escapeAttr(senderKind)}"`;
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
