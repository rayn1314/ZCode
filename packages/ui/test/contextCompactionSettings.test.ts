// 「上下文压缩」设置分区里两个输入框的**提交契约**（spec: core/spec/context-compaction-controls.md §3.6）。
//
// 这三段是少先于 UI 的地方——非法值绝不能落库（越界百分比会被 core 按未配置处理，
// 等于用户以为设了 0% 实际没生效），所以在这里把边界钉死。
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCompactionThresholdPercentInput,
  parseKeepRecentToolResultsInput,
  resolveAutoThresholdPercent,
} from "../src/lib/contextCompactionSettings.js";

test("阈值输入：空串表示「自动」，1–100 整数为显式百分比", () => {
  assert.deepEqual(parseCompactionThresholdPercentInput(""), { kind: "auto" });
  assert.deepEqual(parseCompactionThresholdPercentInput("   "), { kind: "auto" });
  assert.deepEqual(parseCompactionThresholdPercentInput("1"), { kind: "percent", value: 1 });
  assert.deepEqual(parseCompactionThresholdPercentInput(" 80 "), { kind: "percent", value: 80 });
  assert.deepEqual(parseCompactionThresholdPercentInput("100"), { kind: "percent", value: 100 });
});

test("阈值输入：越界、小数、非数字一律非法，不静默取整", () => {
  for (const raw of ["0", "101", "-1", "1.5", "80%", "abc", "1e2", "+50"]) {
    assert.deepEqual(
      parseCompactionThresholdPercentInput(raw),
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

test("自动阈值百分比与 core 的公式口径一致（200K 窗口 ≈ 83%）", () => {
  // (200000 − min(21000, 200000) − 13000) / 200000 = 83%
  assert.equal(resolveAutoThresholdPercent(200_000), 83);
});

test("拿不到模型窗口时返回 null，UI 只显示「自动」而不编数字", () => {
  for (const window of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(resolveAutoThresholdPercent(window), null, `应返回 null：${String(window)}`);
  }
});
