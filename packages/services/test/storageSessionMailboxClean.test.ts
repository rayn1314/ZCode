import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { StorageRootSpec } from "@zcode/shared";
import { planStorageClean } from "../src/storage/domain/cleanPlan.js";
import {
  classifyStoragePath,
  getStorageCategoryCleanability,
  getStorageCleanScopes,
} from "../src/storage/domain/storageCatalog.js";
import { createStorageUsageAccumulator } from "../src/storage/domain/usageAggregate.js";
import { createStorageService } from "../src/storage/app/storageService.js";
import { createFsStorageCleaner } from "../src/storage/adapters/fsCleaner.js";

/**
 * 契约：会话信箱的手动清理路径——read/failed 可清（safe），unread 是活数据绝不触达；
 * 大小统计与清理走同一分类，单文件删除失败不阻断其余，既有类别行为不回归。
 */

const CONTEXT = { rootId: "home" as const, hasCustomDataBaseDir: false };

async function withRoot<T>(run: (rootDir: string) => Promise<T>): Promise<T> {
  const rootDir = await mkdtemp(join(tmpdir(), "zcode-mailbox-clean-"));
  try {
    return await run(rootDir);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
}

/** 造一棵真实信箱树：read/failed/unread 各一封 + 一层结构外嵌套残留。 */
async function seedMailbox(rootDir: string): Promise<void> {
  const sessionDir = join(rootDir, "mailbox", "sess_seed");
  await Promise.all(
    ["read", "failed", "unread", join("read", "sub")].map((kind) =>
      mkdir(join(sessionDir, kind), { recursive: true }),
    ),
  );
  await Promise.all(
    [
      ["read/20261009T000000_aaaa.json", "read-envelope"],
      ["failed/20261009T000001_bbbb.json", "dead-letter"],
      ["unread/20261009T000002_cccc.json", "live-envelope"],
      ["read/sub/nested.json", "structure-outlier"],
    ].map(([relative, content]) => writeFile(join(sessionDir, relative), content)),
  );
}

test("分类：read/failed 单层信封归 sessionMailbox，unread 与结构外残留归 config", () => {
  assert.equal(
    classifyStoragePath("mailbox/sess_1/read/20261009T000000_aaaa.json", CONTEXT).categoryId,
    "sessionMailbox",
  );
  assert.equal(
    classifyStoragePath("mailbox/sess_1/failed/20261009T000001_bbbb.json", CONTEXT).categoryId,
    "sessionMailbox",
  );
  // unread 是未投递活数据；更深嵌套是结构外残留——两者都必须留在不可清的 config。
  assert.equal(
    classifyStoragePath("mailbox/sess_1/unread/20261009T000002_cccc.json", CONTEXT).categoryId,
    "config",
  );
  assert.equal(
    classifyStoragePath("mailbox/sess_1/read/sub/nested.json", CONTEXT).categoryId,
    "config",
  );
  assert.equal(classifyStoragePath("mailbox/stray.json", CONTEXT).categoryId, "config");
  // 下钻明细按 mailbox/<sessionId>/<kind> 聚合
  assert.equal(
    classifyStoragePath("mailbox/sess_1/read/20261009T000000_aaaa.json", CONTEXT).entryKey,
    "mailbox/sess_1/read",
  );
});

test("清理范围与可清理性：sessionMailbox=safe，递归枚举 mailbox；config 仍拿不到范围", () => {
  assert.equal(getStorageCategoryCleanability("sessionMailbox"), "safe");
  assert.deepEqual(getStorageCleanScopes("sessionMailbox"), [
    { prefix: "mailbox", recursive: true },
  ]);
  // 回归：mailbox 前缀仍归 config，none 类别没有任何可枚举范围。
  assert.equal(getStorageCategoryCleanability("config"), "none");
  assert.deepEqual(getStorageCleanScopes("config"), []);
});

test("清理计划：包含 read/failed，不含 unread、结构外嵌套与游离文件", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  const candidates = [
    "mailbox/sess_1/read/20261009T000000_aaaa.json",
    "mailbox/sess_1/failed/20261009T000001_bbbb.json",
    "mailbox/sess_1/unread/20261009T000002_cccc.json",
    "mailbox/sess_1/read/sub/nested.json",
    "mailbox/stray.json",
  ].map((relativePath, index) => ({ relativePath, bytes: 10 * (index + 1), mtimeMs: now }));

  const plan = planStorageClean({
    categoryId: "sessionMailbox",
    candidates,
    context: CONTEXT,
    now,
  });
  assert.deepEqual(
    plan.targets.map((target) => target.relativePath),
    [
      "mailbox/sess_1/read/20261009T000000_aaaa.json",
      "mailbox/sess_1/failed/20261009T000001_bbbb.json",
    ],
  );
  assert.equal(plan.skippedCount, 3);
});

test("真实清理：read/failed 被删，unread 完好，mailbox 顶层目录保留", async () => {
  await withRoot(async (rootDir) => {
    await seedMailbox(rootDir);
    const roots: StorageRootSpec[] = [{ id: "home", path: rootDir, hasCustomDataBaseDir: false }];
    const service = createStorageService({
      roots: { resolveRoots: async () => roots },
      scanRunner: {
        run: async () => {
          throw new Error("clean 不应触发扫描");
        },
      },
      cleaner: createFsStorageCleaner(),
    });

    const result = await service.clean({ rootId: "home", categoryId: "sessionMailbox" });
    assert.equal(result.failures.length, 0);
    // 结构外嵌套里那层文件归 config，分类过滤保住它；真信封按计划删除。
    assert.equal(result.deletedCount, 2);
    assert.ok(result.freedBytes > 0);

    const sessionDir = join(rootDir, "mailbox", "sess_seed");
    await assert.rejects(() => readFile(join(sessionDir, "read/20261009T000000_aaaa.json")));
    await assert.rejects(() => readFile(join(sessionDir, "failed/20261009T000001_bbbb.json")));
    // 不变式：unread 活数据逐字节完好，信封正文还在。
    assert.equal(
      await readFile(join(sessionDir, "unread/20261009T000002_cccc.json"), "utf8"),
      "live-envelope",
    );
    // 结构外残留同样不被误删（它归 config，不可清）。
    assert.equal(
      await readFile(join(sessionDir, "read/sub/nested.json"), "utf8"),
      "structure-outlier",
    );
    // keepDirectories 保住 mailbox 顶层；结构外残留仍可读。
    assert.equal(
      await readFile(join(sessionDir, "read/sub/nested.json"), "utf8"),
      "structure-outlier",
    );
    // 再清一次幂等：没有可删的目标，也不报错。
    const again = await service.clean({ rootId: "home", categoryId: "sessionMailbox" });
    assert.equal(again.deletedCount, 0);
    assert.equal(again.failures.length, 0);

    // 回归：config 仍不可清理（unread 的最后一道门禁）。
    await assert.rejects(() => service.clean({ rootId: "home", categoryId: "config" }));
  });
});

test("部分失败：单文件删除失败记入 failures，其余照删", async () => {
  await withRoot(async (rootDir) => {
    const sessionDir = join(rootDir, "mailbox", "sess_1");
    await mkdir(join(sessionDir, "read"), { recursive: true });
    await mkdir(join(sessionDir, "failed"), { recursive: true });
    await writeFile(join(sessionDir, "read/a.json"), "aaa");
    await writeFile(join(sessionDir, "failed/b.json"), "bb");

    // 中间一项在计划生成后被并发消费方删掉（ENOENT），模拟 drain 竞争。
    const cleaner = createFsStorageCleaner();
    const result = await cleaner.deleteFiles(
      rootDir,
      [
        { relativePath: "mailbox/sess_1/read/a.json", bytes: 3, mtimeMs: 0 },
        { relativePath: "mailbox/sess_1/read/gone.json", bytes: 5, mtimeMs: 0 },
        { relativePath: "mailbox/sess_1/failed/b.json", bytes: 2, mtimeMs: 0 },
      ],
      { keepDirectories: ["mailbox"] },
    );

    assert.equal(result.deletedCount, 2);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0]?.path, "mailbox/sess_1/read/gone.json");
    assert.equal(result.failures[0]?.code, "ENOENT");
    // 失败不阻断：另外两封确实删掉了。
    await assert.rejects(() => readFile(join(sessionDir, "read/a.json")));
    await assert.rejects(() => readFile(join(sessionDir, "failed/b.json")));
  });
});

test("大小统计：sessionMailbox 只累计 read/failed，unread 计入 config", () => {
  const accumulator = createStorageUsageAccumulator({
    id: "home",
    path: "/tmp/zcode",
    hasCustomDataBaseDir: false,
  });
  accumulator.add({ relativePath: "mailbox/sess_1/read/a.json", bytes: 100, mtimeMs: 0 });
  accumulator.add({ relativePath: "mailbox/sess_1/failed/b.json", bytes: 50, mtimeMs: 0 });
  accumulator.add({ relativePath: "mailbox/sess_1/unread/c.json", bytes: 999, mtimeMs: 0 });

  const snapshot = accumulator.snapshot(null);
  const mailbox = snapshot.categories.find((category) => category.id === "sessionMailbox");
  assert.ok(mailbox);
  assert.equal(mailbox.bytes, 150);
  assert.equal(mailbox.fileCount, 2);
  assert.equal(mailbox.cleanability, "safe");
  assert.deepEqual(mailbox.entries, [
    { relativePath: "mailbox/sess_1/read", bytes: 100, fileCount: 1 },
    { relativePath: "mailbox/sess_1/failed", bytes: 50, fileCount: 1 },
  ]);
  // unread 的 999 字节仍算在 config（不可清类别），总量不丢不重。
  const config = snapshot.categories.find((category) => category.id === "config");
  assert.equal(config?.bytes, 999);
  assert.equal(snapshot.bytes, 1149);
});

test("回归：既有类别的分类与清理语义不变", () => {
  const now = Date.parse("2026-10-09T12:00:00Z");
  // 分类回归：既有前缀/文件规则不受新类别影响。
  assert.equal(classifyStoragePath("v2/sessions/abc.sqlite", CONTEXT).categoryId, "sessionStore");
  assert.equal(
    classifyStoragePath("cli/agents/sess_x/transcript.jsonl", CONTEXT).categoryId,
    "toolOutputs",
  );
  assert.equal(
    classifyStoragePath("cli/agents/sess_x/run_y/transcript.jsonl", CONTEXT).categoryId,
    "subagentTranscripts",
  );
  assert.equal(classifyStoragePath("logs/app.log", CONTEXT).categoryId, "logs");
  assert.equal(classifyStoragePath("backup/db.sqlite.20261001", CONTEXT).categoryId, "backups");

  // logs 保留当天：今天写的跳过，昨天写的可删。
  const today = planStorageClean({
    categoryId: "logs",
    candidates: [{ relativePath: "logs/app.log", bytes: 1, mtimeMs: now }],
    context: CONTEXT,
    now,
  });
  assert.equal(today.targets.length, 0);
  assert.equal(today.skippedCount, 1);
  const yesterday = planStorageClean({
    categoryId: "logs",
    candidates: [{ relativePath: "logs/app.log", bytes: 1, mtimeMs: now - 26 * 60 * 60 * 1000 }],
    context: CONTEXT,
    now,
  });
  assert.equal(yesterday.targets.length, 1);

  // none 类别直接空计划。
  const configPlan = planStorageClean({
    categoryId: "config",
    candidates: [{ relativePath: "mailbox/sess_1/unread/c.json", bytes: 1, mtimeMs: now }],
    context: CONTEXT,
    now,
  });
  assert.equal(configPlan.targets.length, 0);
  assert.equal(configPlan.skippedCount, 1);
});
