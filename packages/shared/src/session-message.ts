// 跨会话消息在 v4 命令面上的共享身份常量（CLI 与 Host services 双侧必须同源）。
//
// 审计修复（spec: core/spec/session-message-audit-fixes.md）：
// 1. 同一封消息在 CLI 直投与 Host 转投两条路径上必须用**同一个 CommandInbox 幂等键**，
//    否则 ACK 丢失重投时两键分叉 → 双投。键必须只由消息稳定身份 messageId 派生，
//    不能依赖调用方提供的 requestId（契约允许任意 requestId，两侧各推导一次就会漂移）。
// 2. 会话消息来源的 sendText（同进程直投、Host 实时投递与回执）必须携带可辨识的
//    提交端 clientId：接收侧 runtime 据此区分「人类输入（清防环链）」与
//    「会话间消息（不清链）」（spec D7 修订）。

/**
 * 会话消息投递的 v4 提交端 clientId。同进程由 CLI bootstrap 的 SessionMessagePort 使用；
 * 跨进程由 Host services 的实时投递与回执沿用——两者语义上都是"会话消息机器"发起的输入。
 */
export const SESSION_MESSAGE_CLIENT_ID = "session-message-port";

/** v4 幂等键前缀；完整键见 `sessionMessageV4CommandId`。 */
const SESSION_MESSAGE_COMMAND_ID_PREFIX = "session-message";

/**
 * 跨会话消息的 v4 CommandInbox 幂等键：`session-message:<messageId>`。
 *
 * CLI 直投与 Host 转投必须都用它——CommandInbox 按 `{sessionId, commandId}` 去重，
 * 两键同源才能保证"同一封消息的两条投递路径共享去重"（ACK 丢失重投不产生第二条消息）。
 * messageId 是消息的稳定身份，天然按消息幂等；requestId 只用于跨进程路由与结果关联。
 */
export function sessionMessageV4CommandId(messageId: string): string {
  return `${SESSION_MESSAGE_COMMAND_ID_PREFIX}:${messageId}`;
}
