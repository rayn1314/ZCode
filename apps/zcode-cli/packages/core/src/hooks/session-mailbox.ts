import {
  HookEventName,
  type Logger,
  type SessionId,
  type SessionMailboxEnvelope,
  type SessionMailboxPort,
  type SessionMessageChain,
  type TraceContext,
} from "@zcode/contracts";
import type { HookRegistration } from "./types.js";

const MAILBOX_DRAIN_LIMIT = 20;

/**
 * steer/入队被 runtime 拒绝（`TurnSteerResult.kind === "rejected"`）。
 * 必须以异常上抛给 hook（审计修复 #2）：只写 warn 的旧实现让正文停在 `read/` 永不重试；
 * hook 捕获本错误后把该信封回滚到 `unread/`，下一轮 drain 重读恰一次。
 */
export class SessionMailboxEnqueueRejectedError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(`Session mailbox input was not queued: ${reason}`);
    this.name = "SessionMailboxEnqueueRejectedError";
    this.reason = reason;
  }
}

export function createSessionMailboxHookRegistrations(options: {
  /**
   * 把单条 drain 出的信封 steer 进当前回合；投递成功正常返回，
   * 被拒抛 `SessionMailboxEnqueueRejectedError`（审计修复 #2，hook 据此回滚该信封）。
   */
  enqueuePendingInput?: (input: string, traceContext: TraceContext) => Promise<void>;
  mailbox: SessionMailboxPort;
  sessionId: SessionId;
  /**
   * 把本批 drain 出的入站防环链交回 runtime（spec D7 + 审计修复 #4）。
   * 只在 **本批存在带链消息** 时调用一次（取最后一条带链消息的链）：
   * mailbox 信封只可能来自会话（session/subagent），永远不是人类插话——
   * 整批无链不清链（旧实现把无链批次当"人重新开话头"清链，一条无链回执就能把
   * A↔B 循环的 hop 计数归零）；空 drain 同样不调用（没收到消息不等于人来插话）。
   */
  noteInboundSessionMessageChain?: (chain: SessionMessageChain) => void;
  /** 回滚失败等可恢复异常的告警出口；缺省不落日志，回滚行为照常执行。 */
  logger?: Logger;
}): HookRegistration[] {
  /**
   * 回滚失败信封到 `unread/`（审计修复 #2）：drain 是"先归档再交出"，交出失败若不回滚，
   * 正文已离开 unread、永不重试。回滚后下轮重读恰一次；单条回滚失败不拖垮整批
   * （与坏档隔离同思路），只留日志暴露。
   */
  const restoreEnvelopes = async (
    envelopes: readonly SessionMailboxEnvelope[],
    reason: string,
  ): Promise<void> => {
    for (const envelope of envelopes) {
      try {
        await options.mailbox.restoreToUnread({ sessionId: options.sessionId, envelope });
      } catch (error) {
        options.logger?.warn("Session mailbox envelope could not be restored to unread", {
          error: error instanceof Error ? error.message : String(error),
          event: "session.mailbox.restore_failed",
          messageId: envelope.messageId,
          module: "core.hooks.session_mailbox",
          reason,
          sessionId: String(options.sessionId),
        });
      }
    }
  };

  const callback: HookRegistration["callback"] = async (input, context) => {
    const messages = await options.mailbox.drainUnread(
      { sessionId: options.sessionId, limit: MAILBOX_DRAIN_LIMIT },
      { signal: context.signal },
    );
    if (messages.length === 0) return undefined;
    const drainedChain = resolveDrainedSessionMessageChain(messages);
    if (drainedChain) options.noteInboundSessionMessageChain?.(drainedChain);

    if (input.hookEventName === HookEventName.PostToolUse && options.enqueuePendingInput) {
      for (let index = 0; index < messages.length; index += 1) {
        const message = messages[index]!;
        try {
          await options.enqueuePendingInput(formatMailboxMessages([message]), {
            sessionId: options.sessionId,
            traceId: input.traceId,
            turnId: input.turnId,
          });
        } catch (error) {
          if (error instanceof SessionMailboxEnqueueRejectedError) {
            // steer 被拒：这一条没被投递，回滚 unread 让下轮重读；其余信封继续处理。
            options.logger?.warn("Session mailbox input was not queued; envelope restored", {
              event: "session.mailbox.queue_rejected",
              messageId: message.messageId,
              module: "core.hooks.session_mailbox",
              reason: error.reason,
              sessionId: String(options.sessionId),
            });
            await restoreEnvelopes([message], "steer_rejected");
            continue;
          }
          // 意外异常：当前及尚未交出的后续信封一并回滚再上抛——它们没有被投递，
          // 留在 read/ 就是静默丢失（审计修复 #2）。
          await restoreEnvelopes(messages.slice(index), "enqueue_threw");
          throw error;
        }
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
 * 但最新一条才代表链当前所在位置。整批都没有链返回 undefined——调用方**不清链**
 * （审计修复 #4：mailbox 来信不是人类插话），空批同样不调用（没消息不等于人来插话）。
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
