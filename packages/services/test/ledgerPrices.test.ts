import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { calcLedgerCost, LedgerPriceLoader } from "../src/usage-ledger/ledgerPrices.js";

// 契约：input_tokens 本就含 cacheRead（AI SDK 归一化为 total，spec 口径 cacheRead ⊂ input），
// 费用必须先把命中部分从输入扣掉再乘输入价——否则命中 token 按未命中价计一遍、
// 再按缓存价计一遍，双重计费。回归背景：2026-10-09 xin × deepseek-v4-1-flash
// 98% 命中率下预估费用显示 $7,069（真实约 $104），虚高 68 倍。

const DEEPSEEK_OFFPEAK = {
  prices: new Map([["deepseek-v4.1-flash", { input: 0.15, output: 0.6, cacheRead: 0.003 }]]),
  meta: null,
};

function cost(modelId: string, input: number, output: number, cacheRead: number) {
  return calcLedgerCost(DEEPSEEK_OFFPEAK, modelId, input, output, cacheRead);
}

test("缓存命中部分不按输入价重复计费", () => {
  // 1000 输入里 900 命中：只有 100 按输入价，900 按缓存价
  const got = cost("deepseek-v4.1-flash", 1_000, 100, 900);
  const expected = (100 / 1e6) * 0.15 + (100 / 1e6) * 0.6 + (900 / 1e6) * 0.003;
  assert.ok(got !== null);
  assert.ok(Math.abs(got - expected) < 1e-12, `got ${got}, want ${expected}`);
});

test("无缓存时只按输入价与输出价计", () => {
  const got = cost("deepseek-v4.1-flash", 1_000, 100, 0);
  const expected = (1_000 / 1e6) * 0.15 + (100 / 1e6) * 0.6;
  assert.ok(Math.abs((got ?? 0) - expected) < 1e-12);
});

test("98% 命中率的截图口径落在官方闲时价 ~$104", () => {
  // 截图：输入 117.6 亿、缓存读 115.5 亿、输出 6295.5 万（DeepSeek V4.1-Flash 闲时价）
  const got = cost("deepseek-v4.1-flash", 11_760_000_000, 62_955_000, 11_550_000_000);
  assert.ok(got !== null);
  assert.ok(got > 100 && got < 110, `want ~104, got ${got}`);
});

test("未定价模型与空价格表返回 null，不静默按 0 算", () => {
  assert.equal(cost("no-such-model", 1_000, 100, 0), null);
  assert.equal(calcLedgerCost(null, "deepseek-v4.1-flash", 1_000, 100, 0), null);
  assert.equal(
    calcLedgerCost({ prices: new Map(), meta: null }, "deepseek-v4.1-flash", 1_000, 100, 0),
    null,
  );
});

test("内置基准含连字符别名 deepseek-v4-1-flash（中转站模型命名）", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-"));
  try {
    const table = await new LedgerPriceLoader({ dataRootDir: dir }).load();
    const price = table.prices.get("deepseek-v4-1-flash");
    assert.ok(price, "内置基准应含连字符别名键");
    assert.equal(price.input, 0.15);
    assert.equal(price.output, 0.6);
    assert.equal(price.cacheRead, 0.003);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeUserPrices(dir: string, payload: unknown): Promise<void> {
  await mkdir(path.join(dir, "v2"), { recursive: true });
  await writeFile(path.join(dir, "v2", "usage-prices.json"), JSON.stringify(payload), "utf8");
}

test("用户覆盖层的 _aliases 在加载时展开为目标价格", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-"));
  try {
    await writeUserPrices(dir, {
      "custom-model": { input: 1, output: 2, cacheRead: 0.1 },
      _aliases: { "relay-model": "custom-model" },
    });
    const table = await new LedgerPriceLoader({ dataRootDir: dir }).load();
    assert.deepEqual(table.prices.get("relay-model"), {
      input: 1,
      output: 2,
      cacheRead: 0.1,
    });
    // 别名键由用户声明决定存在，来源记 user；价格本身来自同层
    assert.equal(table.sources?.get("relay-model"), "user");
    assert.equal(table.aliasTargets?.get("relay-model"), "custom-model");
    assert.equal(table.aliases?.get("relay-model"), "custom-model");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("别名键自己的显式定价优先于别名展开", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-"));
  try {
    await writeUserPrices(dir, {
      "custom-model": { input: 1, output: 2, cacheRead: 0.1 },
      "relay-model": { input: 9, output: 9, cacheRead: 9 },
      _aliases: { "relay-model": "custom-model" },
    });
    const table = await new LedgerPriceLoader({ dataRootDir: dir }).load();
    assert.deepEqual(table.prices.get("relay-model"), { input: 9, output: 9, cacheRead: 9 });
    assert.equal(table.aliasTargets?.has("relay-model"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("别名链按最终目标展开，成环时中断且不抛错", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-"));
  try {
    await writeUserPrices(dir, {
      "final-model": { input: 2, output: 4, cacheRead: 0.2 },
      _aliases: {
        "alias-a": "alias-b",
        "alias-b": "final-model",
        "cycle-x": "cycle-y",
        "cycle-y": "cycle-x",
      },
    });
    const table = await new LedgerPriceLoader({ dataRootDir: dir }).load();
    assert.deepEqual(table.prices.get("alias-a"), { input: 2, output: 4, cacheRead: 0.2 });
    assert.equal(table.aliasTargets?.get("alias-a"), "final-model");
    assert.equal(table.prices.has("cycle-x"), false);
    assert.equal(table.prices.has("cycle-y"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("来源标注按层：内置 / 同步 / 用户覆盖依次覆盖", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "ledger-prices-"));
  try {
    await mkdir(path.join(dir, "v2"), { recursive: true });
    await writeFile(
      path.join(dir, "v2", "usage-prices-baseline.json"),
      JSON.stringify({ "deepseek-flash": { input: 9, output: 9, cacheRead: 9 } }),
      "utf8",
    );
    await writeUserPrices(dir, {
      "custom-model": { input: 1, output: 2, cacheRead: 0.1 },
    });
    const table = await new LedgerPriceLoader({ dataRootDir: dir }).load();
    assert.equal(table.sources?.get("deepseek-flash"), "synced");
    assert.equal(table.sources?.get("deepseek-v4.1-flash"), "builtin");
    assert.equal(table.sources?.get("custom-model"), "user");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
