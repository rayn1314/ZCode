import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionId, SessionMailboxEnvelope } from "@zcode/contracts";
import { createNodeSessionMailboxAdapter } from "../src/mailbox/index.js";

const TARGET = "sess_target" as SessionId;
const SENDER = "sess_sender" as SessionId;

function envelope(overrides: Partial<SessionMailboxEnvelope> = {}): SessionMailboxEnvelope {
  return {
    version: 1,
    messageId: "msg_1",
    fromSessionId: SENDER,
    toSessionId: TARGET,
    content: "hello",
    createdAt: "2026-10-03T03:15:00.123Z",
    ...overrides,
  };
}

async function withRoot<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-"));
  try {
    return await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("deliver 文件名以零填充时间戳前缀 + messageId 命名，字典序等于时间序", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const later = envelope({ messageId: "msg_later", createdAt: "2026-10-03T03:15:01.000Z" });
    const earlier = envelope({ messageId: "msg_earlier", createdAt: "2026-10-03T03:15:00.500Z" });
    // 故意乱序投递，验证排序来自文件名而不是写入顺序。
    await mailbox.deliver(later);
    await mailbox.deliver(earlier);

    const files = (await readdir(join(rootDir, "sess_target", "unread"))).sort();
    assert.deepEqual(files, [
      "20261003T031500500Z_msg_earlier.json",
      "20261003T031501000Z_msg_later.json",
    ]);

    const drained = await mailbox.drainUnread({ sessionId: TARGET });
    assert.deepEqual(
      drained.map((message) => message.messageId),
      ["msg_earlier", "msg_later"],
    );
  });
});

test("drainUnread 能读到 deliver 落盘的信封，并按序归档到 read/", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    await mailbox.deliver(envelope({ messageId: "msg_a", content: "from A" }));
    await mailbox.deliver(
      envelope({ messageId: "msg_b", content: "from B", createdAt: "2026-10-03T03:15:02.000Z" }),
    );

    const drained = await mailbox.drainUnread({ sessionId: TARGET });
    assert.equal(drained.length, 2);
    assert.equal(drained[0].content, "from A");
    assert.equal(drained[1].content, "from B");

    // 消费过的信封离开 unread/，重复 drain 不再返回。
    assert.deepEqual(await readdir(join(rootDir, "sess_target", "unread")), []);
    const readFiles = (await readdir(join(rootDir, "sess_target", "read"))).sort();
    assert.deepEqual(readFiles, [
      "20261003T031500123Z_msg_a.json",
      "20261003T031502000Z_msg_b.json",
    ]);
    assert.deepEqual(await mailbox.drainUnread({ sessionId: TARGET }), []);
  });
});

test("坏档隔离：坏 JSON 与非法信封被移入 failed/，不影响其后的好信封", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const unreadDir = join(rootDir, "sess_target", "unread");
    await mkdir(unreadDir, { recursive: true });
    // 文件名排在好信封之前：坏档若阻断整批，后面的消息就永远读不出来。
    await writeFile(join(unreadDir, "00000000T000000000Z_msg_broken.json"), "{ not json", "utf8");
    await writeFile(
      join(unreadDir, "00000000T000000001Z_msg_wrong_version.json"),
      JSON.stringify({ version: 2, messageId: "msg_wrong_version" }),
      "utf8",
    );
    await mailbox.deliver(envelope({ messageId: "msg_good", content: "survives" }));

    const drained = await mailbox.drainUnread({ sessionId: TARGET });
    assert.deepEqual(
      drained.map((message) => message.messageId),
      ["msg_good"],
    );

    const failedFiles = (await readdir(join(rootDir, "sess_target", "failed"))).sort();
    assert.deepEqual(failedFiles, [
      "00000000T000000000Z_msg_broken.json",
      "00000000T000000001Z_msg_wrong_version.json",
    ]);
    assert.deepEqual(await readdir(unreadDir), []);
  });
});

test("senderKind 可选：旧信封缺字段仍可解析，新信封按值往返", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    await mailbox.deliver(envelope({ messageId: "msg_legacy" }));
    await mailbox.deliver(
      envelope({
        messageId: "msg_subagent",
        senderKind: "subagent",
        fromSessionId: "sess_subagent_x" as SessionId,
        createdAt: "2026-10-03T03:15:01.000Z",
      }),
    );

    const drained = await mailbox.drainUnread({ sessionId: TARGET });
    assert.equal(drained.length, 2);
    assert.equal(drained[0].senderKind, undefined);
    assert.equal(drained[1].senderKind, "subagent");
  });
});

test("chain 可选：带链信封可投递并 drain 回读，旧信封缺字段仍合法", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const chain = { hop: 2, originMessageId: "msg_root" };
    await mailbox.deliver(envelope({ messageId: "msg_legacy" }));
    await mailbox.deliver(
      envelope({ messageId: "msg_chained", chain, createdAt: "2026-10-03T03:15:01.000Z" }),
    );

    const drained = await mailbox.drainUnread({ sessionId: TARGET });
    assert.equal(drained.length, 2);
    // 防环链是结构化字段，drain 必须原样交回 runtime（spec D7 接收侧记）。
    assert.equal(drained[0].chain, undefined);
    assert.deepEqual(drained[1].chain, chain);
  });
});

test("非法 chain 被拒：hop 非正整数 / origin 空", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });

    for (const illegal of [
      { hop: 0, originMessageId: "msg_root" },
      { hop: 1.5, originMessageId: "msg_root" },
      { hop: 1, originMessageId: "" },
    ]) {
      await assert.rejects(
        () =>
          mailbox.deliver(envelope({ chain: illegal as SessionMailboxEnvelope["chain"] })),
        /Invalid session mailbox envelope chain/,
      );
    }
  });
});

test("路径穿越与非法取值仍被拒：sessionId / messageId / createdAt", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });

    await assert.rejects(
      () => mailbox.deliver(envelope({ toSessionId: "../escape" as SessionId })),
      /Invalid session id/,
    );
    await assert.rejects(
      () => mailbox.deliver(envelope({ messageId: "../msg_escape" })),
      /Invalid session mailbox message id/,
    );
    await assert.rejects(
      () => mailbox.deliver(envelope({ createdAt: "not-a-date" })),
      /Invalid session mailbox envelope createdAt/,
    );
    await assert.rejects(
      () => mailbox.drainUnread({ sessionId: "../escape" as SessionId }),
      /Invalid session id/,
    );

    assert.deepEqual(await readdir(join(rootDir, "sess_target", "unread")), []);
  });
});

test("deliver 拒绝字段不合法的信封，不落半截文件", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    const missingContent = { ...envelope(), content: undefined } as unknown as SessionMailboxEnvelope;
    await assert.rejects(() => mailbox.deliver(missingContent), /Invalid session mailbox envelope/);
    // 校验先于 mkdir/写盘：目录都不应被创建，更不会留下半截临时文件。
    await assert.rejects(() => readdir(join(rootDir, "sess_target", "unread")), /ENOENT/);
  });
});

test("consume 按 messageId 删掉未读信封，返回是否命中", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    await mailbox.deliver(envelope({ messageId: "msg_live", content: "delivered live" }));
    await mailbox.deliver(
      envelope({ messageId: "msg_other", createdAt: "2026-10-03T03:15:01.000Z" }),
    );

    // 实时投递命中后清掉持久副本；同目录其它消息不受影响。
    assert.equal(await mailbox.consume({ sessionId: TARGET, messageId: "msg_live" }), true);
    assert.deepEqual(await readdir(join(rootDir, "sess_target", "unread")), [
      "20261003T031501000Z_msg_other.json",
    ]);

    // 幂等：已消费/不存在的 messageId 返回 false，不抛错；前缀相同但不等于后缀的不误删。
    assert.equal(await mailbox.consume({ sessionId: TARGET, messageId: "msg_live" }), false);
    assert.equal(await mailbox.consume({ sessionId: TARGET, messageId: "liv" }), false);

    const drained = await mailbox.drainUnread({ sessionId: TARGET });
    assert.deepEqual(
      drained.map((message) => message.messageId),
      ["msg_other"],
    );
  });
});

test("consume 对空会话与已 drain 归档是幂等 no-op", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    // 目录都还不存在。
    assert.equal(await mailbox.consume({ sessionId: TARGET, messageId: "msg_x" }), false);

    await mailbox.deliver(envelope({ messageId: "msg_x" }));
    await mailbox.drainUnread({ sessionId: TARGET });
    // 已归档到 read/ 的信封不再被 consume 计入（unread 里已经没有它）。
    assert.equal(await mailbox.consume({ sessionId: TARGET, messageId: "msg_x" }), false);
    assert.equal((await readdir(join(rootDir, "sess_target", "read"))).length, 1);
  });
});

test("consume 拒绝可借文件名穿越的 messageId", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMailboxAdapter({ rootDir });
    await assert.rejects(
      () => mailbox.consume({ sessionId: TARGET, messageId: "../msg_escape" }),
      /Invalid session mailbox message id/,
    );
    await assert.rejects(
      () => mailbox.consume({ sessionId: "../escape" as SessionId, messageId: "msg_x" }),
      /Invalid session id/,
    );
  });
});
