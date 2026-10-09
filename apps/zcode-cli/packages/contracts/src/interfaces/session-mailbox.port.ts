import type { SessionId } from "./shared.js";
import type { SessionMessageChain, SessionMessageSenderKind } from "./session-message.port.js";

export interface SessionMailboxEnvelope {
  version: 1;
  messageId: string;
  fromSessionId: SessionId;
  toSessionId: SessionId;
  content: string;
  createdAt: string;
  /**
   * 来源身份（独立会话 / 附属子代理）。旧信封没有该字段，读取方按缺省
   * `"session"` 处理，因此新增该可选字段不破坏向后兼容。
   */
  senderKind?: SessionMessageSenderKind;
  /**
   * 防环链（spec D7）。信封是 mailbox 通路的结构化载体：drain 时必须把链交回 runtime，
   * 否则"实时投递被降级为落盘"会让链在接收侧断掉，互相回信失去计数。
   */
  chain?: SessionMessageChain;
}

export interface SessionMailboxPort {
  drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]>;

  /**
   * 写侧：把信封落到目标会话 `unread/`，供其下次 drain 消费。
   * 只负责落盘，不判断目标可达性——可达性分档由 SessionMessagePort 决定。
   * 目录不可写时抛错，不假装成功。
   */
  deliver(envelope: SessionMailboxEnvelope, opts?: { signal?: AbortSignal }): Promise<void>;

  /**
   * 消费（删除）目标会话 `unread/` 下属于该 `messageId` 的信封。
   * 实时投递命中后用它清掉持久副本，否则同一条消息会被 live 注入 + 下次 drain 投递两次。
   * 幂等：命中并删除返回 true，信封已不在（已被 drain/并发消费）返回 false，不抛错。
   * 目录读取等真实 IO 故障向上抛，不假装成功。
   */
  consume(
    input: { sessionId: SessionId; messageId: string },
    opts?: { signal?: AbortSignal },
  ): Promise<boolean>;

  /**
   * 回滚（审计修复 #2）：把 drain 已归档到 `read/` 的信封放回 `unread/`，供下一轮重读。
   *
   * drain 是"先归档再交出"（防双读）；交出后 steer/入队失败时正文已离开 `unread/`，
   * 不回滚就永不重试。回滚保持"不丢不重"：失败信封下轮重读恰一次；重复回滚/重投已落
   * 盘时收敛为单份（幂等）。只操作该信封自身的文件，不触碰 `failed/`（坏档隔离语义不变）。
   * 真实 IO 故障向上抛，不假装成功。
   */
  restoreToUnread(
    input: { sessionId: SessionId; envelope: SessionMailboxEnvelope },
    opts?: { signal?: AbortSignal },
  ): Promise<void>;
}
