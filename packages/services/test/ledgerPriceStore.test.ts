import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  deleteUserLedgerPrice,
  setUserLedgerAlias,
  setUserLedgerPrice,
} from "../src/usage-ledger/ledgerPriceStore.js";

// 契约：写操作只动用户覆盖层 usage-prices.json，保留 _meta 与未知键；
// 文件损坏时拒绝覆盖（读取层可以忽略坏文件，写入层不能把整份文件抹掉）。

async function tempRoot(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "ledger-price-store-"));
}

function userFile(dir: string): string {
  return path.join(dir, "v2", "usage-prices.json");
}

async function readUserFile(dir: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(userFile(dir), "utf8")) as Record<string, unknown>;
}

test("setUserLedgerPrice 写小写键并保留 _meta 与未知键", async () => {
  const dir = await tempRoot();
  try {
    await mkdir(path.join(dir, "v2"), { recursive: true });
    await writeFile(
      userFile(dir),
      JSON.stringify({
        _meta: { date: "2026-01-01", currency: "USD" },
        keep: { input: 1, output: 1, cacheRead: 1 },
      }),
      "utf8",
    );
    const result = await setUserLedgerPrice({
      dataRootDir: dir,
      modelId: " My-Model ",
      price: { input: 1, output: 2, cacheRead: 3 },
    });
    assert.equal(result.ok, true);
    const saved = await readUserFile(dir);
    assert.deepEqual(saved["my-model"], { input: 1, output: 2, cacheRead: 3 });
    assert.deepEqual(saved.keep, { input: 1, output: 1, cacheRead: 1 });
    assert.deepEqual(saved._meta, { date: "2026-01-01", currency: "USD" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setUserLedgerPrice 删除同名别名，让显式定价生效", async () => {
  const dir = await tempRoot();
  try {
    await setUserLedgerAlias({ dataRootDir: dir, alias: "relay", target: "official" });
    const result = await setUserLedgerPrice({
      dataRootDir: dir,
      modelId: "relay",
      price: { input: 1, output: 1, cacheRead: 1 },
    });
    assert.equal(result.ok, true);
    const saved = await readUserFile(dir);
    assert.equal(saved._aliases, undefined);
    assert.deepEqual(saved.relay, { input: 1, output: 1, cacheRead: 1 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("deleteUserLedgerPrice 只删用户键，别名保留", async () => {
  const dir = await tempRoot();
  try {
    await setUserLedgerPrice({
      dataRootDir: dir,
      modelId: "custom",
      price: { input: 1, output: 1, cacheRead: 1 },
    });
    await setUserLedgerAlias({ dataRootDir: dir, alias: "relay", target: "custom" });
    const result = await deleteUserLedgerPrice({ dataRootDir: dir, modelId: "CUSTOM" });
    assert.equal(result.ok, true);
    const saved = await readUserFile(dir);
    assert.equal(saved.custom, undefined);
    assert.deepEqual(saved._aliases, { relay: "custom" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("setUserLedgerAlias 移除同名显式定价；target=null 删除别名", async () => {
  const dir = await tempRoot();
  try {
    await setUserLedgerPrice({
      dataRootDir: dir,
      modelId: "relay",
      price: { input: 1, output: 1, cacheRead: 1 },
    });
    const set = await setUserLedgerAlias({ dataRootDir: dir, alias: "relay", target: "official" });
    assert.equal(set.ok, true);
    let saved = await readUserFile(dir);
    assert.equal(saved.relay, undefined);
    assert.deepEqual(saved._aliases, { relay: "official" });

    const removed = await setUserLedgerAlias({ dataRootDir: dir, alias: "relay", target: null });
    assert.equal(removed.ok, true);
    saved = await readUserFile(dir);
    assert.equal(saved._aliases, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("拒绝别名指向自己", async () => {
  const dir = await tempRoot();
  try {
    const result = await setUserLedgerAlias({ dataRootDir: dir, alias: "same", target: "same" });
    assert.equal(result.ok, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("用户价格文件损坏时拒绝覆盖，原文件保持不变", async () => {
  const dir = await tempRoot();
  try {
    await mkdir(path.join(dir, "v2"), { recursive: true });
    await writeFile(userFile(dir), "{ not json", "utf8");
    const result = await setUserLedgerPrice({
      dataRootDir: dir,
      modelId: "model",
      price: { input: 1, output: 1, cacheRead: 1 },
    });
    assert.equal(result.ok, false);
    assert.match(result.error ?? "", /无法读取或已损坏/);
    assert.equal(await readFile(userFile(dir), "utf8"), "{ not json");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("文件不存在时从空表创建", async () => {
  const dir = await tempRoot();
  try {
    const result = await setUserLedgerPrice({
      dataRootDir: dir,
      modelId: "model",
      price: { input: 1, output: 2, cacheRead: 3 },
    });
    assert.equal(result.ok, true);
    assert.deepEqual(await readUserFile(dir), {
      model: { input: 1, output: 2, cacheRead: 3 },
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
