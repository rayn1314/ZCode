// 冷打开窗口态读路径（spec: bootstrap/spec/cold-open-window-first.md §1）：
// messageWindow / messagePageBefore 必须与 messages() 的规范全序前缀一致，
// 并给出可支撑首帧 rows.totalCount / 翻页游标的轻量元信息。
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
    if (root) await rm(root, { force: true, recursive: true });
  }
});

async function seedSession(input: {
  dbPath: string;
  messageCount: number;
  partsPerMessage?: number;
}): Promise<{ sessionID: SessionId; messageIds: MessageId[] }> {
  const store = createSqliteSessionStore({ dbPath: input.dbPath });
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

function openStore(dbPath: string) {
  return createSqliteSessionStore({ dbPath });
}

describe("session store message window", () => {
  it("尾部窗口是全量规范顺序的尾部子集，并给出真实总数", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-message-window-"));
    tempRoots.push(root);
    const dbPath = join(root, "session.sqlite");
    const { sessionID } = await seedSession({ dbPath, messageCount: 25, partsPerMessage: 2 });
    const store = openStore(dbPath);
    try {
      const all = await store.messages({ sessionID });
      const window = await store.messageWindow!({ sessionID, limit: 10 });

      expect(window.totalCount).toBe(25);
      expect(window.firstSequence).toBe(all.length > 0 ? 0 : null);
      expect(window.legacySequence).toBe(false);
      expect(window.hasOlder).toBe(true);
      expect(window.messages).toEqual(all.slice(-10));
      // sequences 与 messages 对齐且单调递增（游标换算依赖它）。
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
    const store = openStore(dbPath);
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

  it("游标分页逐页取更早消息，页间无缝无重叠，并最终到达会话开头", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-message-page-"));
    tempRoots.push(root);
    const dbPath = join(root, "session.sqlite");
    const { sessionID } = await seedSession({ dbPath, messageCount: 25 });
    const store = openStore(dbPath);
    try {
      const all = await store.messages({ sessionID });
      const window = await store.messageWindow!({ sessionID, limit: 8 });
      const pages: (typeof all)[] = [];
      let beforeSequence: number | undefined = window.sequences[0];
      for (let guard = 0; guard < 10; guard += 1) {
        const page = await store.messagePageBefore!({
          sessionID,
          ...(beforeSequence === undefined ? {} : { beforeSequence }),
          limit: 8,
        });
        if (page.messages.length === 0) break;
        pages.push(page.messages);
        beforeSequence = page.sequences[0];
        if (!page.hasOlder) break;
      }
      // 窗口 + 逐页拼回来的正是全量规范顺序的尾部（顺序与内容都一致）：页是按更早方向
      // 取回的，拼装时要倒序页序，而不是倒序每页内部的行。
      const pageRows = pages.toReversed().flat();
      expect([...pageRows, ...window.messages]).toEqual(
        all.slice(all.length - pageRows.length - window.messages.length),
      );
      expect(pageRows.length + window.messages.length).toBe(25);
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

    const store = openStore(dbPath);
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
