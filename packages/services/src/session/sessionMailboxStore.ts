// Host services 侧的 mailbox 落盘实现（同一台机器上目标 Host 的实时投递去重 / 兜底）。
//
// 与 CLI adapters 的 NodeSessionMailboxAdapter 读写同一棵树、同一套文件名规则
// （规则在 @zcode/shared 的 session-mailbox 里，两个进程不各写一套）。
// 这里只实现 Host 需要的两个动作：落盘（不可达兜底）与按 messageId 消费（实时命中后去重）。

import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  DEFAULT_SESSION_MAILBOX_ROOT,
  SESSION_MAILBOX_ROOT_ENV,
  buildSessionMailboxFileName,
  isValidSessionMailboxMessageId,
  isValidSessionMailboxSessionId,
  isValidSessionMessageChain,
  sessionMailboxMessageIdSuffix,
} from "@zcode/shared";
import type {
  SessionMessageMailboxEnvelope,
  SessionMessageMailboxPort,
  SessionMessageSenderKind,
} from "./sessionMailbox.js";

const TEMP_FILE_SUFFIX = ".tmp";
const SENDER_KINDS: readonly SessionMessageSenderKind[] = ["session", "subagent"];

export interface NodeSessionMessageMailboxOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** mailbox 根目录：`ZCODE_MAILBOX_ROOT` 优先，缺省 `~/.zcode/mailbox`（与 CLI 同源）。 */
export function resolveSessionMessageMailboxRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env[SESSION_MAILBOX_ROOT_ENV]?.trim() || DEFAULT_SESSION_MAILBOX_ROOT;
  return expandHome(configured);
}

export function createNodeSessionMessageMailbox(
  options: NodeSessionMessageMailboxOptions = {},
): SessionMessageMailboxPort {
  const rootDir = options.rootDir ?? resolveSessionMessageMailboxRoot(options.env);
  return new NodeSessionMessageMailbox(rootDir);
}

class NodeSessionMessageMailbox implements SessionMessageMailboxPort {
  constructor(private readonly rootDir: string) {}

  async deliver(envelope: SessionMessageMailboxEnvelope): Promise<void> {
    const validated = assertEnvelope(envelope);
    const unreadDir = this.sessionDir(validated.toSessionId, "unread");
    await mkdir(unreadDir, { recursive: true });

    const fileName = buildSessionMailboxFileName(validated);
    const targetPath = join(unreadDir, fileName);
    // 临时文件必须与目标同目录：rename 才在同一文件系统内保持原子。
    const tempPath = join(unreadDir, `.${fileName}.${randomUUID()}${TEMP_FILE_SUFFIX}`);
    try {
      await writeFile(tempPath, JSON.stringify(validated), "utf8");
      await rename(tempPath, targetPath);
    } catch (error) {
      await removeTempFile(tempPath);
      throw error;
    }
  }

  async consume(input: { sessionId: string; messageId: string }): Promise<boolean> {
    // 先过白名单再拼路径：messageId / sessionId 来自另一个进程，可能被构造成路径穿越。
    const suffix = sessionMailboxMessageIdSuffix(input.messageId);
    const unreadDir = this.sessionDir(input.sessionId, "unread");

    let entries: string[];
    try {
      entries = await readdir(unreadDir);
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }

    let consumed = false;
    for (const entry of entries.filter((candidate) => candidate.endsWith(suffix))) {
      try {
        await unlink(join(unreadDir, entry));
        consumed = true;
      } catch (error) {
        // 与并发 drain/consume 抢同一文件时会 ENOENT：已被消费，视为未命中继续。
        if (isNotFound(error)) continue;
        throw error;
      }
    }
    return consumed;
  }

  private sessionDir(sessionId: string, kind: "unread"): string {
    if (!isValidSessionMailboxSessionId(sessionId)) {
      throw new Error(`Invalid session id: ${sessionId}`);
    }
    const rootDir = resolve(this.rootDir);
    const sessionDir = resolve(rootDir, sessionId, kind);
    const relativePath = relative(rootDir, sessionDir);
    if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
      throw new Error(`Session mailbox path escapes root: ${sessionId}`);
    }
    return sessionDir;
  }
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : resolve(path);
}

async function removeTempFile(tempPath: string): Promise<void> {
  try {
    await unlink(tempPath);
  } catch {
    // 清理是尽力而为：写失败时真正的错误由调用方抛出，临时残留不影响 drain。
  }
}

/** 目录/文件不存在：consume 的幂等语义把 ENOENT 当成"没命中"，其它 IO 错误照抛。 */
function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertEnvelope(value: unknown): SessionMessageMailboxEnvelope {
  const parsed = value as SessionMessageMailboxEnvelope;
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
  if (!isValidSessionMailboxMessageId(parsed.messageId)) {
    throw new Error(`Invalid session mailbox message id: ${parsed.messageId}`);
  }
  // 可选字段：旧信封没有 senderKind 仍然合法，只在出现时必须取白名单值。
  if (parsed.senderKind !== undefined && !SENDER_KINDS.includes(parsed.senderKind)) {
    throw new Error("Invalid session mailbox envelope senderKind");
  }
  // 与 CLI adapters 同一套链校验：坏链不落盘，避免目标 drain 时才暴露。
  if (parsed.chain !== undefined && !isValidSessionMessageChain(parsed.chain)) {
    throw new Error("Invalid session mailbox envelope chain");
  }
  return parsed;
}
