// 身份数据迁移面板的体积展示契约：二进制单位、非负回退与两位以内小数。
import assert from "node:assert/strict";
import test from "node:test";
import { formatBytes } from "../src/settings/identity/formatBytes.js";

test("formatBytes 使用二进制单位并保留可读精度", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1536), "1.5 KB");
  // 超过 10 个单位后不再保留小数，避免列表右侧宽度抖动。
  assert.equal(formatBytes(12 * 1024), "12 KB");
  assert.equal(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

test("formatBytes 对非法与负值输入回退到 0 B", () => {
  assert.equal(formatBytes(-1), "0 B");
  assert.equal(formatBytes(Number.NaN), "0 B");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "0 B");
});
