import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import type {
  Logger,
  SessionId,
  SessionMailboxEnvelope,
  SessionMailboxPort,
  SessionMessageSenderKind,
} from "@zcode/contracts";
import {
  SESSION_MAILBOX_ENVELOPE_SUFFIX,
  buildSessionMailboxFileName,
  isValidSessionMailboxSessionId,
  isValidSessionMessageChain,
  sessionMailboxMessageIdSuffix,
} from "@zcode/shared";

export interface NodeSessionMailboxOptions {
  rootDir: string;
  /** 坏档隔离等可恢复异常的告警出口；缺省不落任何日志，但隔离行为照常执行。 */
  logger?: Logger;
}

/** 临时文件后缀：drainUnread 只收 `.json`，半截文件不会被当成待读信封。 */
const TEMP_FILE_SUFFIX = ".tmp";
const SENDER_KINDS: readonly SessionMessageSenderKind[] = ["session", "subagent"];
const DEFAULT_DRAIN_LIMIT = 20;

type MailboxDirKind = "read" | "unread" | "failed";

export class NodeSessionMailboxAdapter implements SessionMailboxPort {
  private readonly logger?: Logger;

  constructor(private readonly options: NodeSessionMailboxOptions) {
    this.logger = options.logger?.child({ module: "adapters.mailbox" });
  }

  async drainUnread(
    input: { sessionId: SessionId; limit?: number },
    options?: { signal?: AbortSignal },
  ): Promise<SessionMailboxEnvelope[]> {
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    const readDir = this.sessionDir(input.sessionId, "read");
    const failedDir = this.sessionDir(input.sessionId, "failed");
    await mkdir(unreadDir, { recursive: true });
    await mkdir(readDir, { recursive: true });

    const entries = (await readdir(unreadDir))
      .filter((entry) => entry.endsWith(SESSION_MAILBOX_ENVELOPE_SUFFIX))
      .sort()
      .slice(0, input.limit ?? DEFAULT_DRAIN_LIMIT);
    const messages: SessionMailboxEnvelope[] = [];

    // 逐文件隔离：单个坏档（JSON 破损/字段不合法）只归档自己，不能阻断整批——
    // 否则它排在前面时后续所有消息永远读不出来。
    for (const entry of entries) {
      options?.signal?.throwIfAborted();
      const unreadPath = join(unreadDir, entry);
      const raw = await this.readEnvelopeFile(unreadPath, input.sessionId, entry);
      if (raw === undefined) continue;

      let envelope: SessionMailboxEnvelope;
      try {
        envelope = parseEnvelope(raw);
      } catch (error) {
        await this.archiveBadEnvelope({
          unreadPath,
          failedDir,
          fileName: entry,
          sessionId: input.sessionId,
          error,
        });
        continue;
      }

      // 先归档到 read/ 再交出：rename 失败时信封仍留在 unread/，下一轮可重读，
      // 既不丢也不会被重复返回。交出后的"交付失败"由调用方经 restoreToUnread 回滚
      // （契约 #2）：回滚后下轮重读恰一次，仍不产生双投。
      try {
        await rename(unreadPath, join(readDir, entry));
      } catch (error) {
        this.logger?.warn("Session mailbox envelope could not be archived; will retry next drain", {
          sessionId: String(input.sessionId),
          file: entry,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      messages.push(envelope);
    }

    return messages;
  }

  async deliver(envelope: SessionMailboxEnvelope, opts?: { signal?: AbortSignal }): Promise<void> {
    const validated = assertEnvelope(envelope);
    opts?.signal?.throwIfAborted();

    const unreadDir = this.sessionDir(validated.toSessionId, "unread");
    await mkdir(unreadDir, { recursive: true });
    await this.writeEnvelopeFile(unreadDir, validated, opts);
  }

  /**
   * 回滚已归档的信封（契约 restoreToUnread）：drain 后 steer/入队失败时把正文送回
   * `unread/`，下一轮重读恰一次。只碰该信封自身文件，坏档隔离（failed/）不受影响。
   */
  async restoreToUnread(
    input: { sessionId: SessionId; envelope: SessionMailboxEnvelope },
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const envelope = assertEnvelope(input.envelope);
    opts?.signal?.throwIfAborted();

    const fileName = buildSessionMailboxFileName(envelope);
    const readPath = join(this.sessionDir(input.sessionId, "read"), fileName);
    const unreadDir = this.sessionDir(input.sessionId, "unread");
    const unreadPath = join(unreadDir, fileName);
    await mkdir(unreadDir, { recursive: true });

    // 幂等收敛：unread 已有同名（重投已落盘 / 已回滚过）→ 消息已在待读，
    // 去掉 read/ 旧副本即可，绝不在 unread 里留下第二份可读消息。
    if (await pathExists(unreadPath)) {
      await removeFileIfExists(readPath);
      return;
    }
    try {
      await rename(readPath, unreadPath);
      return;
    } catch (error) {
      if (isNotFound(error)) {
        // read/ 副本缺失（重复回滚 / 外部清理）：信封仍在内存，按 deliver 的原子写重写，
        // 不能因为磁盘副本消失就把消息丢掉。
        await this.writeEnvelopeFile(unreadDir, envelope, opts);
        return;
      }
      // Windows 上目标在上面的存在性检查之后被并发写入时 rename 会失败：
      // 若 unread 此刻已有同名，回滚目的已达，只清掉 read/ 旧副本。
      if (await pathExists(unreadPath)) {
        await removeFileIfExists(readPath);
        return;
      }
      throw error;
    }
  }

  async consume(
    input: { sessionId: SessionId; messageId: string },
    opts?: { signal?: AbortSignal },
  ): Promise<boolean> {
    // 先过白名单再拼路径：messageId 直接来自调用方（可能是别的进程/远端）。
    const suffix = sessionMailboxMessageIdSuffix(input.messageId);
    const unreadDir = this.sessionDir(input.sessionId, "unread");

    let entries: string[];
    try {
      entries = await readdir(unreadDir);
    } catch (error) {
      // 没有 unread/ 说明该会话还没有落盘信封（或已被 drain 归档）；不是故障。
      if (isNotFound(error)) return false;
      throw error;
    }

    let consumed = false;
    for (const entry of entries.filter((candidate) => candidate.endsWith(suffix))) {
      opts?.signal?.throwIfAborted();
      try {
        await unlink(join(unreadDir, entry));
        consumed = true;
      } catch (error) {
        // 与并发 drain/consume 抢同一文件时会 ENOENT：该信封已被别人消费，视为未命中继续。
        if (isNotFound(error)) continue;
        throw error;
      }
    }
    return consumed;
  }

  /** 原子落盘：临时文件与目标同目录，rename 保证读侧永远只见完整 JSON。 */
  private async writeEnvelopeFile(
    targetDir: string,
    envelope: SessionMailboxEnvelope,
    opts?: { signal?: AbortSignal },
  ): Promise<void> {
    const fileName = buildSessionMailboxFileName(envelope);
    const targetPath = join(targetDir, fileName);
    const tempPath = join(targetDir, `.${fileName}.${randomUUID()}${TEMP_FILE_SUFFIX}`);
    try {
      await writeFile(tempPath, JSON.stringify(envelope), "utf8");
      opts?.signal?.throwIfAborted();
      await rename(tempPath, targetPath);
    } catch (error) {
      await removeTempFile(tempPath);
      throw error;
    }
  }

  private async readEnvelopeFile(
    unreadPath: string,
    sessionId: SessionId,
    entry: string,
  ): Promise<string | undefined> {
    try {
      return await readFile(unreadPath, "utf8");
    } catch (error) {
      // 与并发的 drain/消费抢同一个文件时会 ENOENT；跳过即可，不能阻断整批。
      this.logger?.warn("Session mailbox envelope could not be read", {
        sessionId: String(sessionId),
        file: entry,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  /**
   * 坏档归到 `failed/` 而不是 `read/`：`read/` 表示"已成功投递"，把无法解析的原始
   * 字节放进去会让审计误判为已送达，也让后续人工排查失去入口。
   */
  private async archiveBadEnvelope(input: {
    unreadPath: string;
    failedDir: string;
    fileName: string;
    sessionId: SessionId;
    error: unknown;
  }): Promise<void> {
    try {
      await mkdir(input.failedDir, { recursive: true });
      await rename(input.unreadPath, join(input.failedDir, input.fileName));
    } catch (moveError) {
      this.logger?.warn("Session mailbox bad envelope could not be archived", {
        sessionId: String(input.sessionId),
        file: input.fileName,
        error: moveError instanceof Error ? moveError.message : String(moveError),
      });
    }
    this.logger?.warn("Session mailbox envelope skipped: invalid content", {
      sessionId: String(input.sessionId),
      file: input.fileName,
      error: input.error instanceof Error ? input.error.message : String(input.error),
    });
  }

  private sessionDir(sessionId: SessionId, kind: MailboxDirKind): string {
    const normalizedSessionId = String(sessionId);
    if (!isValidSessionMailboxSessionId(normalizedSessionId)) {
      throw new Error(`Invalid session id: ${normalizedSessionId}`);
    }

    const rootDir = resolve(this.options.rootDir);
    const sessionDir = resolve(rootDir, normalizedSessionId, kind);
    const relativePath = relative(rootDir, sessionDir);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Session mailbox path escapes root: ${normalizedSessionId}`);
    }
    return sessionDir;
  }
}

export function createNodeSessionMailboxAdapter(
  options: NodeSessionMailboxOptions,
): SessionMailboxPort {
  return new NodeSessionMailboxAdapter(options);
}

async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch {
    // 清理是尽力而为：写失败时真正的错误由调用方抛出，临时残留不影响 drain。
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if (isNotFound(error)) return;
    throw error;
  }
}

/** 目录/文件不存在：consume 的幂等语义把 ENOENT 当成"没命中"，其它 IO 错误照抛。 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function parseEnvelope(content: string): SessionMailboxEnvelope {
  return assertEnvelope(JSON.parse(content));
}

function assertEnvelope(value: unknown): SessionMailboxEnvelope {
  const parsed = value as SessionMailboxEnvelope;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    parsed.version !== 1 ||
    typeof parsed.messageId !== "string" ||
    typeof parsed.fromSessionId !== "string" ||
    typeof parsed.toSessionId !== "string" ||
    typeof parsed.content !== "string" ||
    typeof parsed.createdAt !== "string"
  ) {
    throw new Error("Invalid session mailbox envelope");
  }
  // 可选字段：旧信封没有 senderKind 仍然合法，只在出现时必须取白名单值。
  if (parsed.senderKind !== undefined && !SENDER_KINDS.includes(parsed.senderKind)) {
    throw new Error("Invalid session mailbox envelope senderKind");
  }
  // 同上：旧信封没有 chain 仍然合法，只在出现时必须是合法链（hop 正整数）。
  if (parsed.chain !== undefined && !isValidSessionMessageChain(parsed.chain)) {
    throw new Error("Invalid session mailbox envelope chain");
  }
  return parsed;
}
