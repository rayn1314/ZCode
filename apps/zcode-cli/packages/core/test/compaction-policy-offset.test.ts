import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPostTurnThresholdOffset,
  getAutoCompactThreshold,
  getAutoCompactThresholdPercent,
} from "../src/compact/policy.js";

/**
 * 轮末压缩阈值的**提前量（tokens）**契约（spec: core/spec/context-compaction-controls.md §2 D8、§4 I8）。
 *
 * 硬不变式：提前量缺省或为 0 时，applyPostTurnThresholdOffset 必须**原样返回入参对象**
 * （引用相等），轮末判定与改造前逐位相同——绝不能经由任何单位换算往返一遍。
 * 提前量 > 0 时轮末阈值 = max(1, 自动阈值 − 提前量)，且允许比自动压缩更早触发。
 */

const CONTEXT_WINDOW = 200_000;
const MAX_OUTPUT_TOKENS = 32_000;
// 输入侧上限 = 200000 − min(32000, 21000) = 179000；默认余量后阈值 166000。
const EFFECTIVE_WINDOW = CONTEXT_WINDOW - 21_000;

function config(overrides: { bufferTokens?: number } = {}) {
  return { contextWindow: CONTEXT_WINDOW, maxOutputTokens: MAX_OUTPUT_TOKENS, ...overrides };
}

test("提前量 undefined / 0：原样返回入参对象，不做任何改写", () => {
  const base = config();
  for (const offset of [undefined, 0]) {
    const result = applyPostTurnThresholdOffset(base, offset);
    assert.equal(result, base, `offset=${String(offset)} 应返回同一个对象引用`);
    assert.equal(getAutoCompactThreshold(result), getAutoCompactThreshold(base));
  }
});

test("公式模式（200K 窗口，自动阈值 166000）+ 提前量 6000 ⟹ 轮末阈值 160000", () => {
  const base = config();
  assert.equal(getAutoCompactThreshold(base), EFFECTIVE_WINDOW - 13_000);

  const result = applyPostTurnThresholdOffset(base, 6_000);
  assert.notEqual(result, base);
  assert.equal(getAutoCompactThreshold(result), 160_000);
  // 不改写入参本身。
  assert.equal(base.bufferTokens, undefined);
});

test("显式安全余量 20000（自动阈值 159000）+ 提前量 6000 ⟹ 轮末阈值 153000", () => {
  const base = config({ bufferTokens: 20_000 });
  assert.equal(getAutoCompactThreshold(base), 159_000);

  const result = applyPostTurnThresholdOffset(base, 6_000);
  assert.equal(getAutoCompactThreshold(result), 153_000);
});

test("越界 / 非法提前量一律等同未配置（对象引用不变）", () => {
  const base = config();
  for (const offset of [
    100_001,
    -1,
    2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ]) {
    const result = applyPostTurnThresholdOffset(base, offset);
    assert.equal(result, base, `offset=${String(offset)} 应等同未配置`);
  }
});

test("夹紧：提前量再大也不能把轮末阈值压到 1 以下", () => {
  const base = config({ bufferTokens: EFFECTIVE_WINDOW - 1_000 }); // 自动阈值 1000
  assert.equal(getAutoCompactThreshold(base), 1_000);

  const result = applyPostTurnThresholdOffset(base, 100_000);
  assert.equal(getAutoCompactThreshold(result), 1);
  assert.ok(getAutoCompactThresholdPercent(result) >= 0);
});
