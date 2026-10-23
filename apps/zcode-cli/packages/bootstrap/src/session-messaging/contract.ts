/**
 * session-messaging 对外契约
 * （spec: apps/zcode-cli/packages/core/spec/session-message-audit-fixes.md、
 *  apps/zcode-cli/packages/core/spec/subagent-session-messaging.md、
 *  packages/ui/spec/session-message-envelope-rendering.md）。
 *
 * 模块意图：让一个会话能给另一个会话投递一条消息，并在目标不可达时把消息落进 mailbox 等它下次自醒
 * drain。投递只有**一条写路径**——统一经 v4 命令面（CommandInbox 幂等 / revision 门 / 投影 /
 * queue-guide 语义），不在 core 或本层另造 steerTurn 直调。三档落地方式由目标可达性决定。
 *
 * 类型表达不了的不变量：
 * - 链深上限与「目标不存在」都是**拒绝**而不是**降级**：不写 mailbox、不唤醒、不改动目标
 *   （不存在的会话没有 drainer，落 mailbox 就是死信）。唯一裁决点是投递端口本身。
 * - v4 幂等键只由消息的稳定身份 `messageId` 派生（`sessionMessageV4CommandId`）；调用方给的
 *   `requestId` 只服务跨进程路由与结果关联，两侧各推导一次就会漂移，不能当幂等键。
 * - 投递档恒为 `guide`，不按发送时刻的活动回合切换：`startNow` 会抢占并 abort 目标可能刚起的轮，
 *   而 `hasActiveTurn` 只是快照，竞态窗口在发送侧关不掉。
 * - 入站防环链只有**人类输入**才清空；`session-message-port` 提交的无链输入（同进程直投、Host 实时
 *   投递与回执）一律 keep，否则 A↔B 互相回信时插一条回执就能把 hop 计数归零、cap 失效。
 * - mailbox 落盘本身失败必须抛出（不假装成功）；因可达性不足落 mailbox 属预期降级，返回 `stored`
 *   并带 `detail`。
 * - 来源身份由发送方填充、接收方只读：子代理是附属身份（`sess_subagent_*`），不得伪造正式会话身份。
 */
import type {
  SessionMailboxEnvelope,
  SessionMailboxPort,
  SessionMessageChain,
  SessionMessageChainReader,
  SessionMessageDeliveryRequest,
  SessionMessageDeliveryResult,
  SessionMessageDeliveryStatus,
  SessionMessagePort,
  SessionMessageSenderKind,
} from "@zcode/contracts";
import {
  SESSION_MESSAGE_MAX_HOP,
  SessionMessageChainExceededError,
  SessionMessageUndeliverableError,
} from "@zcode/contracts";
import { SESSION_MESSAGE_CLIENT_ID, sessionMessageV4CommandId } from "@zcode/shared";
import {
  BootstrapSessionMessagePort,
  resolveV4SendResult,
  type SessionMessageDeliveryHost,
  type SessionMessageV4SendInput,
  type SessionMessageV4SendResult,
} from "../zcode-protocol/session-message-port.js";
import { createBootstrapSessionMessagePort } from "../zcode-protocol/session-message-wiring.js";

export type {
  SessionMailboxEnvelope,
  SessionMailboxPort,
  SessionMessageChain,
  SessionMessageChainReader,
  SessionMessageDeliveryRequest,
  SessionMessageDeliveryResult,
  SessionMessageDeliveryStatus,
  SessionMessagePort,
  SessionMessageSenderKind,
};
export {
  SESSION_MESSAGE_CLIENT_ID,
  SESSION_MESSAGE_MAX_HOP,
  SessionMessageChainExceededError,
  SessionMessageUndeliverableError,
  BootstrapSessionMessagePort,
  createBootstrapSessionMessagePort,
  resolveV4SendResult,
  sessionMessageV4CommandId,
};
export type { SessionMessageDeliveryHost, SessionMessageV4SendInput, SessionMessageV4SendResult };

/**
 * 模块对外契约面。真实实现：进程级投递端口 `BootstrapSessionMessagePort`
 * （`../zcode-protocol/session-message-port.js`，由 `createBootstrapSessionMessagePort` 装配）。
 */
export interface SessionMessagingContract {
  /**
   * 投递一封跨会话消息。这是本模块唯一的写侧入口，三档落地语义都经它。
   *
   * 前置：`request.messageId` 是稳定身份（幂等键由它派生）；`request.sessionMessageChain` 缺席即
   * 本次输入开启新链。`opts.signal` 用于放弃等待（不影响已落盘的信封）。
   * 后置：返回的 `status` 如实反映落地方式——`steered`（目标本回合在运行，作为引导注入）/
   * `woken`（目标空闲或已冷，先拉起再开新轮）/ `stored`（目标不可达，只写 mailbox）。
   * 拒绝语义：链深超过 `SESSION_MESSAGE_MAX_HOP` 抛 `SessionMessageChainExceededError`；
   * 冷恢复失败且 store 证明目标不存在时抛 `SessionMessageUndeliverableError`——两者都不落 mailbox。
   * 幂等：同一 `messageId` 的重复投递经 CommandInbox 去重（`duplicate` ack 视为已落地）。
   * 事件：降级落盘后经 `notify`（v4 sideband 通知）上报 `sessionMessageSendRequested`，供 Host 转
   * 实时路由；上报失败不影响本次结果。
   * 持久化：仅 `stored` 档等待 mailbox 落盘完成；另外两档不等持久化。
   */
  deliver(
    request: SessionMessageDeliveryRequest,
    opts?: { signal?: AbortSignal },
  ): Promise<SessionMessageDeliveryResult>;

  /**
   * 读本会话当前的入站防环链（工具侧只读口，由接收方 runtime 实现并注入工具上下文）。
   *
   * 前置：调用方处于该会话的运行时上下文（链可能在回合中途被 guide 注入，必须读实时值）。
   * 后置：返回当前链；无链返回 `undefined`（`undefined` 不等于「链首」——是否清链由写入侧裁决）。
   * 幂等：纯读。不产生事件、不持久化。
   */
  currentInboundChain(): SessionMessageChain | undefined;
}
