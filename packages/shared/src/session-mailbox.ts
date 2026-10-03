// 会话收件箱（mailbox）落盘契约的共享部分。
//
// 同一台机器上写侧可能是 CLI 进程（adapters）或 Host services 进程，读侧仍是目标 CLI；
// 两个进程必须按同一套根目录 / 文件名规则读写同一棵树，否则实时投递与 drain 会各写一份，
// 同一条消息被读两次。这里只放纯字符串规则（不引 node:os / node:path），
// `~` 展开与目录拼接由各进程自行完成。

/** mailbox 根目录覆盖；缺省 `~/.zcode/mailbox`。CLI 与 Host services 读同一个值。 */
export const SESSION_MAILBOX_ROOT_ENV = "ZCODE_MAILBOX_ROOT";
export const DEFAULT_SESSION_MAILBOX_ROOT = "~/.zcode/mailbox";
export const SESSION_MAILBOX_ENVELOPE_SUFFIX = ".json";

/**
 * messageId 会成为文件名的一部分，调用方可能来自别的进程 / 远端，必须过白名单，
 * 否则 `../` 之类的取值能借文件名突破会话目录的根目录防护。
 */
const MESSAGE_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
/** 会话 id 同样会拼进目录路径（`<sessionId>/unread/`），必须过同一套白名单。 */
const SESSION_ID_PATTERN = /^sess_[A-Za-z0-9._-]+$/;

export function isValidSessionMailboxMessageId(messageId: string): boolean {
  return MESSAGE_ID_PATTERN.test(messageId);
}

export function isValidSessionMailboxSessionId(sessionId: string): boolean {
  return SESSION_ID_PATTERN.test(sessionId);
}

/** 信封文件名的 messageId 后缀（`_<messageId>.json`）；consume 按它匹配。 */
export function sessionMailboxMessageIdSuffix(messageId: string): string {
  if (!isValidSessionMailboxMessageId(messageId)) {
    throw new Error(`Invalid session mailbox message id: ${messageId}`);
  }
  return `_${messageId}${SESSION_MAILBOX_ENVELOPE_SUFFIX}`;
}

/**
 * 文件名 = 零填充 UTC 时间戳（`YYYYMMDDTHHMMSSmmmZ`）+ messageId。
 * 定长格式保证 `readdir().sort()` 的字典序等于时间序（drainUnread 依赖它且只取前 N 条）。
 * 时间戳取信封的 createdAt（消息逻辑时间）而不是落盘时刻：同一信封重投时文件名稳定，
 * 原子 rename 覆盖同一路径，重复投递不会产生第二份可读消息。
 */
export function buildSessionMailboxFileName(input: {
  messageId: string;
  createdAt: string;
}): string {
  const suffix = sessionMailboxMessageIdSuffix(input.messageId);
  const date = new Date(input.createdAt);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid session mailbox envelope createdAt: ${input.createdAt}`);
  }
  const iso = date.toISOString();
  const timestamp = `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${iso.slice(20, 23)}Z`;
  return `${timestamp}${suffix}`;
}
