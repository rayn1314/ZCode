import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createUsageLedgerService } from "../src/usage-ledger/usageLedgerService.js";

// 契约：价格列表带来源层与别名解析状态；写操作后缓存立即失效，下一次列表即生效。

test("listLedgerPrices 返回来源与别名，写操作后立即生效", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-service-"));
  const service = createUsageLedgerService({ dataRootDir: dir });
  try {
    const builtin = await service.listLedgerPrices({ query: "deepseek-v4.1-flash" });
    assert.equal(builtin.entries[0]?.source, "builtin");

    const set = await service.setLedgerPrice({
      modelId: "Relay-Model",
      input: 1,
      output: 2,
      cacheRead: 0.5,
    });
    assert.equal(set.ok, true);
    const aliasSet = await service.setLedgerPriceAlias({
      alias: "alias-model",
      target: "relay-model",
    });
    assert.equal(aliasSet.ok, true);

    const list = await service.listLedgerPrices({ query: "model" });
    const relay = list.entries.find((entry) => entry.modelId === "relay-model");
    assert.equal(relay?.source, "user");
    assert.deepEqual(
      relay ? { input: relay.input, output: relay.output, cacheRead: relay.cacheRead } : null,
      { input: 1, output: 2, cacheRead: 0.5 },
    );
    const alias = list.entries.find((entry) => entry.modelId === "alias-model");
    assert.equal(alias?.aliasOf, "relay-model");
    assert.equal(alias?.input, 1);
    assert.equal(list.aliases.find((item) => item.alias === "alias-model")?.resolved, true);

    const removed = await service.deleteLedgerPrice({ modelId: "relay-model" });
    assert.equal(removed.ok, true);
    const after = await service.listLedgerPrices({ query: "model" });
    assert.equal(
      after.entries.some((entry) => entry.modelId === "alias-model"),
      false,
    );
    assert.equal(after.aliases.find((item) => item.alias === "alias-model")?.resolved, false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("listLedgerPrices 按 limit 截断但 total 报过滤后总数", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-service-"));
  const service = createUsageLedgerService({ dataRootDir: dir });
  try {
    const limited = await service.listLedgerPrices({ query: "deepseek", limit: 2 });
    assert.equal(limited.entries.length, 2);
    assert.ok(limited.total > limited.entries.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
