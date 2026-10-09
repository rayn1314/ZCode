// 「上下文压缩」设置分区里几个输入框的**提交契约**（spec: core/spec/context-compaction-controls.md §3.6）。
//
// 用户调的是安全余量（tokens）：非法值绝不能落库（越界余量会被 core 按未配置处理，
// 等于用户以为设了值实际没生效），所以在这里把边界钉死。
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseBufferTokensInput,
  parseKeepRecentToolResultsInput,
  parsePostTurnThresholdOffsetTokensInput,
  resolveAutoThresholdTokens,
  resolveThresholdPercent,
} from "../src/lib/contextCompactionSettings.js";

test("安全余量输入：空串表示「不覆盖」，1–100 千 tokens 为显式余量", () => {
  assert.deepEqual(parseBufferTokensInput(""), { kind: "auto" });
  assert.deepEqual(parseBufferTokensInput("   "), { kind: "auto" });
  assert.deepEqual(parseBufferTokensInput("1"), { kind: "value", value: 1_000 });
  assert.deepEqual(parseBufferTokensInput(" 13 "), { kind: "value", value: 13_000 });
  assert.deepEqual(parseBufferTokensInput("100"), { kind: "value", value: 100_000 });
});

test("安全余量输入：越界、小数、非数字一律非法，不静默取整", () => {
  for (const raw of ["0", "101", "-1", "1.5", "13K", "abc", "1e2", "+50"]) {
    assert.deepEqual(
      parseBufferTokensInput(raw),
      { kind: "invalid" },
      `应判为非法：${JSON.stringify(raw)}`,
    );
  }
});

test("轮末提前量输入：0–100 千 tokens 有效，空串与越界非法", () => {
  assert.deepEqual(parsePostTurnThresholdOffsetTokensInput("0"), { kind: "value", value: 0 });
  assert.deepEqual(parsePostTurnThresholdOffsetTokensInput(" 3 "), { kind: "value", value: 3_000 });
  assert.deepEqual(parsePostTurnThresholdOffsetTokensInput("100"), {
    kind: "value",
    value: 100_000,
  });
  for (const raw of ["", "101", "-1", "2.5", "x"]) {
    assert.deepEqual(
      parsePostTurnThresholdOffsetTokensInput(raw),
      { kind: "invalid" },
      `应判为非法：${JSON.stringify(raw)}`,
    );
  }
});

test("保留组数输入：1–50 整数有效，空串与越界非法", () => {
  assert.deepEqual(parseKeepRecentToolResultsInput("1"), { kind: "value", value: 1 });
  assert.deepEqual(parseKeepRecentToolResultsInput(" 5 "), { kind: "value", value: 5 });
  assert.deepEqual(parseKeepRecentToolResultsInput("50"), { kind: "value", value: 50 });
  for (const raw of ["", "0", "51", "2.5", "x"]) {
    assert.deepEqual(
      parseKeepRecentToolResultsInput(raw),
      { kind: "invalid" },
      `应判为非法：${JSON.stringify(raw)}`,
    );
  }
});

test("自动阈值与 core 的公式口径一致（200K 窗口 166K ≈ 83%）", () => {
  // (200000 − min(21000, 200000) − 13000) = 166000 → 83%
  assert.equal(resolveAutoThresholdTokens(200_000, null), 166_000);
  assert.equal(resolveThresholdPercent(200_000, resolveAutoThresholdTokens(200_000, null)), 83);
  // 显式余量直接改变阈值：余量 20000 → 159000。
  assert.equal(resolveAutoThresholdTokens(200_000, 20_000), 159_000);
});

test("拿不到模型窗口时返回 null，UI 只显示「自动」而不编数字", () => {
  for (const window of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveAutoThresholdTokens(window, null), null, `应返回 null：${String(window)}`);
    assert.equal(resolveThresholdPercent(window, 166_000), null, `应返回 null：${String(window)}`);
  }
});
