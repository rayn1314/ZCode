import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createNodeSessionMessageMailbox,
  resolveSessionMessageMailboxRoot,
} from "../src/session/sessionMailboxStore.js";

/**
 * 契约：Host 侧 mailbox 与 CLI adapters 共用同一套文件名/根目录规则，
 * 因此这里必须能消费掉 CLI 名下同名的 `_<messageId>.json` 信封。
 */

async function withRoot<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-host-mailbox-"));
  try {
    return await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

test("deliver 落盘文件名与 CLI 规则一致，consume 按 messageId 命中", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMessageMailbox({ rootDir });
    await mailbox.deliver({
      version: 1,
      messageId: "msg_1",
      fromSessionId: "sess_sender",
      toSessionId: "sess_target",
      content: "hello",
      createdAt: "2026-10-03T03:15:00.123Z",
    });

    const files = await readdir(join(rootDir, "sess_target", "unread"));
    assert.deepEqual(files, ["20261003T031500123Z_msg_1.json"]);

    assert.equal(await mailbox.consume({ sessionId: "sess_target", messageId: "msg_1" }), true);
    assert.equal(await mailbox.consume({ sessionId: "sess_target", messageId: "msg_1" }), false);
    assert.deepEqual(await readdir(join(rootDir, "sess_target", "unread")), []);
  });
});

test("consume 对不存在的会话目录是幂等 no-op", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMessageMailbox({ rootDir });
    assert.equal(await mailbox.consume({ sessionId: "sess_empty", messageId: "msg_x" }), false);
  });
});

test("路径穿越被拒：sessionId 与 messageId 都过白名单", async () => {
  await withRoot(async (rootDir) => {
    const mailbox = createNodeSessionMessageMailbox({ rootDir });
    await assert.rejects(
      () => mailbox.consume({ sessionId: "../escape", messageId: "msg_x" }),
      /Invalid session id/,
    );
    await assert.rejects(
      () => mailbox.consume({ sessionId: "sess_target", messageId: "../msg_x" }),
      /Invalid session mailbox message id/,
    );
    await assert.rejects(
      () =>
        mailbox.deliver({
          version: 1,
          messageId: "msg_1",
          fromSessionId: "sess_sender",
          toSessionId: "../escape",
          content: "hello",
          createdAt: "2026-10-03T03:15:00.123Z",
        }),
      /Invalid session id/,
    );
  });
});

test("根目录解析：ZCODE_MAILBOX_ROOT 优先，缺省 ~/.zcode/mailbox", () => {
  assert.match(resolveSessionMessageMailboxRoot({}), /[\\/]\.zcode[\\/]mailbox$/);
  const overridden = resolveSessionMessageMailboxRoot({
    ZCODE_MAILBOX_ROOT: "/custom/mailbox",
  });
  assert.ok(overridden.includes("custom"), overridden);
  assert.ok(overridden.endsWith("mailbox"), overridden);
});
