import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { syncLedgerPriceBaseline } from "../src/usage-ledger/ledgerPriceSync.js";

// 契约：同名模型多渠道报价不一致（众数平票）时，同步层不写入该模型，
// 回退内置基准或记未定价；绝不按目录插入顺序随机取一家。
// 回归背景：deepseek-v4-1-flash 曾被随机取中 cacheRead=输入价的劣质条目（$0.3 vs 官方 $0.003）。

function catalog(entries: Record<string, { input: number; output: number; cache_read?: number }>) {
  const models: Record<string, { cost: Record<string, number> }> = {};
  for (const [id, cost] of Object.entries(entries)) models[id] = { cost };
  return {
    meta: { fields: ["cost"] },
    provider: { name: "test" },
    models,
  } as unknown as Record<string, unknown>;
}

// 同步要求模型数 >= MIN_MODEL_COUNT（1000），填充到阈值以上
function withFillers(target: Record<string, unknown>): Record<string, unknown> {
  const filler: Record<string, unknown> = {};
  for (let i = 0; i < 1005; i++) {
    filler[`filler-${i}`] = {
      models: { [`filler-model-${i}`]: { cost: { input: 1, output: 2 } } },
    };
  }
  return { ...filler, ...target };
}

async function syncWithCatalog(catalogs: Record<string, unknown>) {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-sync-"));
  try {
    const fetchImpl = (async () => ({
      ok: true,
      status: 200,
      json: async () => catalogs,
    })) as unknown as typeof fetch;
    const result = await syncLedgerPriceBaseline({
      dataRootDir: dir,
      fetchImpl,
      now: () => new Date("2026-10-09T00:00:00Z"),
    });
    assert.ok(result.ok, "同步本体应成功（仅跳过平票模型）");
    const written = JSON.parse(
      await readFile(path.join(dir, "v2", "usage-prices-baseline.json"), "utf8"),
    );
    return written as Record<string, { input: number; output: number; cacheRead: number }>;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("众数平票的模型不写入同步层", async () => {
  const written = await syncWithCatalog(
    withFillers({
      chA: catalog({ "tie-model": { input: 1, output: 2, cache_read: 0.1 } }),
      chB: catalog({ "tie-model": { input: 3, output: 4, cache_read: 0.2 } }),
    }),
  );
  assert.ok(!("tie-model" in written), "平票模型不应写入同步层");
});

test("有明确众数的模型写入众数价", async () => {
  const written = await syncWithCatalog(
    withFillers({
      chA: catalog({ "modeled-model": { input: 1, output: 2, cache_read: 0.1 } }),
      chB: catalog({ "modeled-model": { input: 1, output: 2, cache_read: 0.1 } }),
      chC: catalog({ "modeled-model": { input: 9, output: 9, cache_read: 9 } }),
    }),
  );
  assert.deepEqual(written["modeled-model"], { input: 1, output: 2, cacheRead: 0.1 });
});

test("官方白名单渠道优先于众数", async () => {
  const written = await syncWithCatalog(
    withFillers({
      deepseek: catalog({ "official-model": { input: 0.15, output: 0.6, cache_read: 0.003 } }),
      chA: catalog({ "official-model": { input: 3, output: 4, cache_read: 0.2 } }),
      chB: catalog({ "official-model": { input: 5, output: 6, cache_read: 0.3 } }),
    }),
  );
  assert.equal(written["official-model"]?.cacheRead, 0.003);
  assert.equal(written["official-model"]?.input, 0.15);
});

test("单渠道报价照常写入", async () => {
  const written = await syncWithCatalog(
    withFillers({
      chA: catalog({ "single-model": { input: 0.2, output: 0.8, cache_read: 0.004 } }),
    }),
  );
  assert.equal(written["single-model"]?.input, 0.2);
  assert.equal(written["single-model"]?.cacheRead, 0.004);
});
