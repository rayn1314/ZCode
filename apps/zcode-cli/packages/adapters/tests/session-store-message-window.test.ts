// 冷打开窗口态读路径（spec: bootstrap/spec/cold-open-window-first.md §1）：
// messageWindow 必须与 messages() 的规范全序尾部一致，
// 并给出可支撑首帧 rows.totalCount / 窗口态行号换算的轻量元信息。
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  createMessageId,
  createPartId,
  createProjectId,
  createSessionId,
  type MessageId,
  type SessionId,
} from "@zcode/contracts";
import { createSqliteSessionStore } from "../src/storage/index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await removeTempRoot(root);
  }
});

async function seedSession(input: {
  dbPath: string;
  messageCount: number;
  partsPerMessage?: number;
}): Promise<{ sessionID: SessionId; messageIds: MessageId[] }> {
  const store = await createSqliteSessionStore({ dbPath: input.dbPath });
  const sessionID = createSessionId("window-session");
  await store.createSession({
    id: sessionID,
    projectID: createProjectId("window-project"),
    slug: "window-session",
    directory: tmpdir(),
    title: "window session",
    version: "0.1.0",
  });
  const messageIds: MessageId[] = [];
  for (let index = 0; index < input.messageCount; index += 1) {
    const messageID = createMessageId(`window-message-${index}`);
    messageIds.push(messageID);
    await store.saveMessage({
      id: messageID,
      sessionID,
      role: index % 2 === 0 ? "user" : "assistant",
      time: { created: 1_000 + index * 10 },
      ...(index % 2 === 0 ? { agent: "zcode-agent" } : {}),
    } as never);
    for (let partIndex = 0; partIndex < (input.partsPerMessage ?? 1); partIndex += 1) {
      await store.savePart({
        id: createPartId(`window-part-${index}-${partIndex}`),
        sessionID,
        messageID,
        type: "text",
        text: `part ${index}-${partIndex}`,
        time: { start: 1_000 + index * 10 },
      });
    }
  }
  store.close();
  return { sessionID, messageIds };
}

// createSqliteSessionStore 在上游合并后是异步工厂：忘记 await 拿到的是 Promise，
// 后面 store.close() 就会报 "store.close is not a function"。
async function openStore(dbPath: string) {
  return createSqliteSessionStore({ dbPath });
}

/**
 * Windows 上刚关闭的 sqlite 句柄（-shm/-wal）会短暂占用目录，直接 `rm` 抛 EBUSY 并顶掉
 * 真正的断言失败。有界重试只吸收瞬时占用，预算用尽仍抛原错。
 */
async function removeTempRoot(root: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rm(root, { force: true, recursive: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EBUSY" || code === "EPERM" || code === "ENOTEMPTY";
      if (!transient || attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

describe("session store message window", () => {
  it("尾部窗口是全量规范顺序的尾部子集，并给出真实总数", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-message-window-"));
    tempRoots.push(root);
    const dbPath = join(root, "session.sqlite");
    const { sessionID } = await seedSession({ dbPath, messageCount: 25, partsPerMessage: 2 });
    const store = await openStore(dbPath);
    try {
      const all = await store.messages({ sessionID });
      const window = await store.messageWindow!({ sessionID, limit: 10 });

      expect(window.totalCount).toBe(25);
      expect(window.firstSequence).toBe(all.length > 0 ? 0 : null);
      expect(window.legacySequence).toBe(false);
      expect(window.hasOlder).toBe(true);
      expect(window.messages).toEqual(all.slice(-10));
      // sequences 与 messages 对齐且单调递增（窗口态行号按消息序号换算依赖它）。
      expect(window.sequences).toEqual([...window.sequences].toSorted((a, b) => a - b));
      expect(window.sequences).toHaveLength(window.messages.length);
    } finally {
      store.close();
    }
  });

  it("窗口覆盖整个会话时 hasOlder=false，且空会话返回空元信息", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-message-window-full-"));
    tempRoots.push(root);
    const dbPath = join(root, "session.sqlite");
    const { sessionID } = await seedSession({ dbPath, messageCount: 3 });
    const store = await openStore(dbPath);
    try {
      const window = await store.messageWindow!({ sessionID, limit: 10 });
      expect(window.hasOlder).toBe(false);
      expect(window.messages).toHaveLength(3);
      expect(window.totalCount).toBe(3);

      const emptySessionId = createSessionId("window-empty-session");
      await store.createSession({
        id: emptySessionId,
        projectID: createProjectId("window-project"),
        slug: "window-empty-session",
        directory: tmpdir(),
        title: "empty",
        version: "0.1.0",
      });
      const empty = await store.messageWindow!({ sessionID: emptySessionId, limit: 10 });
      expect(empty.hasOlder).toBe(false);
      expect(empty.totalCount).toBe(0);
      expect(empty.firstSequence).toBeNull();
      expect(empty.messages).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("NULL sequence 旧行让窗口读失败关闭，由调用方回退全量路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-message-legacy-"));
    tempRoots.push(root);
    const dbPath = join(root, "session.sqlite");
    const { sessionID } = await seedSession({ dbPath, messageCount: 3 });
    // 直接模拟旧二进制写入（不含 sequence 列）：触发器会兜底补号，
    // 因此这里显式在补号后把 sequence 改回 NULL，覆盖兜底失效的历史库。
    const db = new DatabaseSync(dbPath);
    db.exec("drop trigger if exists message_sequence_autofill");
    const messageID = createMessageId("window-message-0");
    db.prepare("update message set sequence = null where session_id = ? and id = ?").run(
      sessionID,
      messageID,
    );
    const nullCount = db
      .prepare("select count(*) as total from message where session_id = ? and sequence is null")
      .get(sessionID) as { total: number };
    db.close();
    expect(Number(nullCount.total)).toBe(1);

    const store = await openStore(dbPath);
    try {
      const window = await store.messageWindow!({ sessionID, limit: 2 });
      expect(window.legacySequence).toBe(true);
      expect(window.messages).toEqual([]);
      expect(window.totalCount).toBe(3);
    } finally {
      store.close();
    }
  });
});
