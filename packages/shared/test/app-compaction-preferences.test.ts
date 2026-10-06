// 上下文压缩偏好（六项）在 shared 层的契约：
//   * AppSettings 缺省值必须是「维持现状」——默认全关、保留 5 组、阈值 null（沿用 core 公式阈值）；
//   * 阈值百分比只接受 1–100 整数或 null，越界不得写进偏好；
//   * patch 里 null 是「恢复自动」而非「不修改」（靠 optional 区分）；
//   * 协议层 `ZCodeCompactionPreferences` 必须 strict 拒绝 contextWindow——窗口由模型推导，
//     不允许配置覆盖（spec 不变式 I3）。
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  zcodeCompactionPreferencesSchema,
} from "../src/zcode-protocol/index.js";

test("AppSettings 解析后压缩六项为「维持现状」默认值", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.compactionThresholdPercent ?? null, null);
  assert.equal(parsed.compactionMicrocompactEnabled, false);
  assert.equal(parsed.compactionMicrocompactKeepRecentToolResults, 5);
  assert.equal(parsed.compactionMicrocompactClearErrorResults, false);
  assert.equal(parsed.compactionPostTurnEnabled, false);
  assert.equal(parsed.compactionModelDownshiftEnabled, false);
});

test("阈值百分比接受 1–100 整数与 null，拒绝越界与小数", () => {
  for (const value of [1, 50, 100, null]) {
    assert.equal(appSettingsSchema.safeParse({ compactionThresholdPercent: value }).success, true);
  }
  for (const value of [0, 101, -1, 50.5]) {
    assert.equal(
      appSettingsSchema.safeParse({ compactionThresholdPercent: value }).success,
      false,
      `应拒绝 compactionThresholdPercent=${String(value)}`,
    );
  }
});

test("保留组数只接受 1–50 整数", () => {
  for (const value of [1, 5, 50]) {
    assert.equal(
      appSettingsSchema.safeParse({ compactionMicrocompactKeepRecentToolResults: value }).success,
      true,
    );
  }
  for (const value of [0, 51, 2.5]) {
    assert.equal(
      appSettingsSchema.safeParse({ compactionMicrocompactKeepRecentToolResults: value }).success,
      false,
      `应拒绝 keepRecentToolResults=${String(value)}`,
    );
  }
});

test("patch 中显式 null 表示恢复自动阈值，缺席表示不修改", () => {
  const cleared = appSettingsPatchSchema.parse({ compactionThresholdPercent: null });
  assert.equal(cleared.compactionThresholdPercent, null);
  assert.equal("compactionThresholdPercent" in cleared, true);

  const untouched = appSettingsPatchSchema.parse({ compactionMicrocompactEnabled: true });
  assert.equal("compactionThresholdPercent" in untouched, false);
});

test("协议偏好 strict 拒绝 contextWindow 等多余字段", () => {
  const base = { ...DEFAULT_ZCODE_COMPACTION_PREFERENCES };
  assert.equal(zcodeCompactionPreferencesSchema.safeParse(base).success, true);
  assert.equal(
    zcodeCompactionPreferencesSchema.safeParse({ ...base, contextWindow: 200_000 }).success,
    false,
  );
  // 六项缺一不可：缺席由调用方补默认值，不在协议层静默兜底。
  const { postTurnEnabled: _omitted, ...incomplete } = base;
  assert.equal(zcodeCompactionPreferencesSchema.safeParse(incomplete).success, false);
});
