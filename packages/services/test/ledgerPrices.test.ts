import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
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
