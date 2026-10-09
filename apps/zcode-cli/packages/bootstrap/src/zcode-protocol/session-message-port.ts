// ============================================================
// SessionMessagePort 的 bootstrap 实现：进程内跨会话投递（spec D3/D4）
// ============================================================
//
// 单一 owner、单条写路径：跨会话投递统一经 v4 命令面（CommandInbox 幂等 /
// revision 门 / 投影 / queue-guide 语义），不在 core 或本层另造 steerTurn 直调。
// `steerTurn` 对无活动回合只会回 `no_active_turn`，唤醒不走 steerTurn——
// guide 档在目标空闲时由 sendText → startPromptTurn → admitPrompt 空闲分支开新轮。
//
// 可达性分三档：
//   1. 常驻（不论忙闲） → sendText(requestedDelivery=guide) → steered/woken
//   2. 不在进程内先冷恢复，恢复后同上
//   3. 不在进程内且冷恢复失败 / v4 投递被拒 → mailbox deliver → stored
//
// 恒用 guide 而不按活动回合切换（审计修复 #1）：`hasActiveTurn` 是发送时刻的快照，
// 目标可能在快照之后刚起轮；startNow 分支会 preemptActiveTurnAndWait 把它 abort 掉
// （session-flow.ts）。guide 由目标自己的 admission 裁决：忙且可引导 → steered、
// 忙不可引导 → 排队、空闲 → startPromptTurn 的 guide 路由开新轮（admitPrompt 空闲分支
// 不看 queueDelivery，直接 reserve+入队唤醒），既不抢占也不饿死空闲目标。
// Host 跨进程路径已刻意恒用 guide（zcodeTaskServiceAdapter），此处与它对齐。
//
// 失败语义（spec）：不丢、不假装成功。mailbox 落盘本身失败时直接抛出，让调用方看到
// 真实原因；因可达性不足而落 mailbox 属预期降级，返回 stored 并带 detail。
//
// 本文件依赖被收窄成 SessionMessageDeliveryHost，装配层把 context.sessions /
// gateway / 冷恢复 / mailbox 绑进闭包，因此三档语义可以脱离协议服务器做单测。

import type {
  Logger,
  SessionId,
  SessionMailboxEnvelope,
  SessionMailboxPort,
  SessionMessageChain,
  SessionMessageDeliveryRequest,
  SessionMessageDeliveryResult,
  SessionMessagePort,
} from "@zcode/contracts";
import { SESSION_MESSAGE_MAX_HOP, SessionMessageChainExceededError } from "@zcode/contracts";
import { sessionMessageV4CommandId } from "@zcode/shared";
import { V4_NOTIFICATIONS, type CommandAck } from "@zcode/shared/zcode-protocol-v4";

/** v4 命令面投递结果：accepted 是否被接收，detail 记录被拒原因。 */
export interface SessionMessageV4SendResult {
  accepted: boolean;
  detail?: string;
}

/** v4 写路径入参；commandId 与 messageId 同源，借 CommandInbox 做同会话幂等。 */
export interface SessionMessageV4SendInput {
  sessionId: string;
  commandId: string;
  text: string;
  /**
   * 投递档恒为 guide（审计修复 #1）：startNow 的抢占语义与"投递消息"冲突，
   * 空闲目标由 guide 路由开新轮完成唤醒，不再区分忙闲。
   */
  requestedDelivery: "guide";
  /** 防环链（spec D7）：随 payload 结构化到达接收方 runtime，投递层只透传不裁决。 */
  sessionMessageChain?: SessionMessageChain;
}

/** 装配层注入的能力窄面（便于单测与解耦具体协议实现）。 */
export interface SessionMessageDeliveryHost {
  /** 目标是否已在进程内常驻（`context.sessions` 有 record）。 */
  hasResidentSession(sessionId: string): boolean;
  /**
   * 目标是否有活动回合；**只用于回执状态（steered/woken）的近似判定**，
   * 不再参与投递档选择（审计修复 #1：档位恒为 guide）。
   */
  hasActiveTurn(sessionId: string): boolean;
  /** 冷恢复入口：把持久化会话拉回常驻。失败应抛出，由本层降级 mailbox。 */
  ensureSessionResident(sessionId: string): Promise<boolean>;
  sendViaV4(input: SessionMessageV4SendInput): Promise<SessionMessageV4SendResult>;
  /** 不可达时兜底落盘；不可写时抛出，不假装成功。 */
  mailbox: SessionMailboxPort;
  /**
   * CLI→Host 侧带出口：跨进程目标写完 mailbox 后上报，由 Host services 转 main 实时路由。
   * 缺省（没有 Host 订阅者，例如 headless CLI）时只留 mailbox，等目标下次自醒 drain。
   */
  notify?: (notification: { method: string; params: unknown }) => void;
  logger?: Logger;
}

/** v4 命令面的来源标识；常量单源在 `@zcode/shared`（Host 转投与回执共用同一值）。 */
export { SESSION_MESSAGE_CLIENT_ID } from "@zcode/shared";
const MAILBOX_SOURCE = "session-message";

export class BootstrapSessionMessagePort implements SessionMessagePort {
  constructor(private readonly host: SessionMessageDeliveryHost) {}

  async deliver(
    request: SessionMessageDeliveryRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionMessageDeliveryResult> {
    const target = request.toSessionId;

    // cap 的唯一裁决点（spec D7）：发送方进程里唯一的写侧入口就是这里（三档都经过它）。
    // 超限是"拒绝"不是"降级"——不落盘、不唤醒、不改动目标，并把原因交回调用方/模型。
    // 接收侧（Host adapter、目标 runtime）不得因 hop 大而丢消息。
    const chain = request.sessionMessageChain;
    if (chain && chain.hop > SESSION_MESSAGE_MAX_HOP) {
      throw new SessionMessageChainExceededError({
        hop: chain.hop,
        originMessageId: chain.originMessageId,
        toSessionId: target,
      });
    }
    // 档 2 前置：不在进程内先尝试冷恢复；恢复不出 record 即落盘。
    if (!this.host.hasResidentSession(target)) {
      const resumed = await this.tryEnsureResident(target);
      if (!resumed) {
        return await this.storeToMailbox(
          request,
          opts,
          "target not resident; cold resume unavailable",
        );
      }
    }

    // 投递档恒用 guide（审计修复 #1）：startNow 会抢占并 abort 目标可能刚起的轮，
    // 而 hasActiveTurn 只是发送时刻的快照，竞态窗口无法在发送侧关闭。详见文件头注释。
    const active = this.host.hasActiveTurn(target);

    let outcome: SessionMessageV4SendResult;
    try {
      outcome = await this.host.sendViaV4({
        sessionId: target,
        // 幂等键只由 messageId 派生（审计修复 #3）：与 Host 转投路径同源，
        // 两键共享 CommandInbox 去重，ACK 丢失重投不会产生第二条消息。
        commandId: sessionMessageV4CommandId(request.messageId),
        text: formatDeliveryText(request),
        requestedDelivery: "guide",
        ...(chain ? { sessionMessageChain: chain } : {}),
      });
    } catch (error) {
      return await this.storeToMailbox(request, opts, `v4 delivery failed: ${errorText(error)}`);
    }
    if (!outcome.accepted) {
      return await this.storeToMailbox(
        request,
        opts,
        `v4 delivery not accepted: ${outcome.detail ?? "unknown"}`,
      );
    }

    // 落地方式如实反映：投递档恒为 guide，目标当时有活动回合即 steered（guide 注入），
    // 空闲即 woken（guide 路由开新轮）。判定只用发送时刻的活动回合快照，不从 ACK 的
    // admitted delivery 反推——steerTurn 的 admission receipt 也用 `queued` 表达"已接受"，
    // 按它判定会把引导误报成入队；忙但不可引导时此处会把 queued 近似报成 steered，
    // 属既有近似（与 Host 侧投影口径一致），不影响"不抢占"的核心约束。
    return {
      toSessionId: target,
      messageId: request.messageId,
      status: active ? "steered" : "woken",
    };
  }

  private async tryEnsureResident(sessionId: string): Promise<boolean> {
    try {
      const resumed = await this.host.ensureSessionResident(sessionId);
      if (!resumed) {
        this.host.logger?.warn("Session message cold resume found no persisted session", {
          event: "session.message.cold_resume_empty",
          module: "bootstrap.session_message",
          sessionId,
        });
      }
      return resumed;
    } catch (error) {
      // 冷恢复失败不是投递失败：降级 mailbox，保留原因供排查（spec 失败语义）。
      this.host.logger?.warn("Session message cold resume failed; falling back to mailbox", {
        error: errorText(error),
        event: "session.message.cold_resume_failed",
        module: "bootstrap.session_message",
        sessionId,
      });
      return false;
    }
  }

  private async storeToMailbox(
    request: SessionMessageDeliveryRequest,
    opts: { signal?: AbortSignal } | undefined,
    detail: string,
  ): Promise<SessionMessageDeliveryResult> {
    const envelope: SessionMailboxEnvelope = {
      version: 1,
      messageId: request.messageId,
      // 契约的 delivering request 用裸字符串寻址；mailbox 信封用品牌化 SessionId。
      fromSessionId: request.fromSessionId as SessionId,
      toSessionId: request.toSessionId as SessionId,
      content: request.content,
      createdAt: request.createdAt,
      senderKind: request.senderKind,
      // mailbox 是链的结构化载体：drain 时 hook 会把 chain 交回 runtime（spec D7）。
      ...(request.sessionMessageChain ? { chain: request.sessionMessageChain } : {}),
    };
    await this.host.mailbox.deliver(envelope, opts);
    this.host.logger?.info("Session message stored in target mailbox", {
      event: "session.message.stored",
      module: "bootstrap.session_message",
      reason: detail,
      sessionId: request.toSessionId,
      senderKind: request.senderKind,
    });
    // 持久副本已落盘，可以安全上报：Host 实时路由失败也只是退回这封信封，
    // 不会丢消息（spec 失败语义）。上报失败不影响本次 deliver 的结果。
    this.notifySendRequested(request);
    return {
      toSessionId: request.toSessionId,
      messageId: request.messageId,
      status: "stored",
      detail,
    };
  }

  /**
   * requestId 只服务跨进程路由与结果关联（main 的 pending 表按它对账），缺省时用
   * `session-message:<messageId>` 兜底保证稳定。**它不再是 v4 幂等键**——Host 转投的
   * commandId 与本层直投一样只由 messageId 派生（审计修复 #3，见 sessionMessageV4CommandId）。
   */
  private notifySendRequested(request: SessionMessageDeliveryRequest): void {
    if (!this.host.notify) return;
    this.host.notify({
      method: V4_NOTIFICATIONS.sessionMessageSendRequested,
      params: {
        request: {
          content: request.content,
          createdAt: request.createdAt,
          fromSessionId: request.fromSessionId,
          messageId: request.messageId,
          requestId: request.requestId ?? sessionMessageV4CommandId(request.messageId),
          toSessionId: request.toSessionId,
          ...(request.senderKind ? { senderKind: request.senderKind } : {}),
          // 跨进程 main 路由原样透传；链在目标 Host 落地（live 或 mailbox）后必须连续。
          ...(request.sessionMessageChain
            ? { sessionMessageChain: request.sessionMessageChain }
            : {}),
        },
      },
    });
  }
}

/**
 * v4 直投内容：把来源身份（fromSessionId/senderKind）写进 `<session-message>` 信封，
 * 与 mailbox 注入格式同属性名，接收侧模型无需区分两种通路（spec D4）。
 */
function formatDeliveryText(request: SessionMessageDeliveryRequest): string {
  const chain = request.sessionMessageChain;
  return [
    `<session-message source="${MAILBOX_SOURCE}" message_id="${escapeAttr(request.messageId)}" from_session="${escapeAttr(request.fromSessionId)}" sender_kind="${escapeAttr(request.senderKind)}"${chain ? ` hop="${chain.hop}" origin="${escapeAttr(chain.originMessageId)}"` : ""} created_at="${escapeAttr(request.createdAt)}">`,
    request.content,
    "</session-message>",
  ].join("\n");
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 把 v4 CommandAck 映射成本层的投递结果（accepted/duplicate 视为已落地）。 */
export function resolveV4SendResult(ack: CommandAck): SessionMessageV4SendResult {
  // duplicate = 同一 commandId 的幂等重放，消息已经落地，不能当成未投递。
  if (ack.status === "accepted" || ack.status === "duplicate") return { accepted: true };
  return {
    accepted: false,
    detail: ack.reasonCode ? `${ack.status}:${ack.reasonCode}` : ack.status,
  };
}
