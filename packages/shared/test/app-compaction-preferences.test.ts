// 上下文压缩偏好（七项）在 shared 层的契约：
//   * AppSettings 缺省值必须是「维持现状」——默认全关、保留 5 组、余量 null（沿用默认 13000）；
//   * 安全余量只接受 1000–100000 整数或 null，越界不得写进偏好；
//   * patch 里 null 是「恢复默认余量」而非「不修改」（靠 optional 区分）；
//   * 协议层 `ZCodeCompactionPreferences` 必须 strict 拒绝 contextWindow——窗口由模型推导，
//     不允许配置覆盖（spec 不变式 I3）；
//   * 删除旧的 thresholdPercent 不能让旧持久化数据解析失败（schema 非 strict，未知键静默剥掉）。
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import {
  DEFAULT_ZCODE_COMPACTION_PREFERENCES,
  zcodeCompactionPreferencesSchema,
} from "../src/zcode-protocol/index.js";

test("AppSettings 解析后压缩七项为「维持现状」默认值", () => {
  const parsed = appSettingsSchema.parse({});
  assert.equal(parsed.compactionBufferTokens ?? null, null);
  assert.equal(parsed.compactionMicrocompactEnabled, false);
  assert.equal(parsed.compactionMicrocompactKeepRecentToolResults, 5);
  assert.equal(parsed.compactionMicrocompactClearErrorResults, false);
  assert.equal(parsed.compactionPostTurnEnabled, false);
  assert.equal(parsed.compactionPostTurnThresholdOffsetTokens, 0);
  assert.equal(parsed.compactionModelDownshiftEnabled, false);
});

test("安全余量接受 1000–100000 整数与 null，拒绝越界与小数", () => {
  for (const value of [1_000, 13_000, 100_000, null]) {
    assert.equal(appSettingsSchema.safeParse({ compactionBufferTokens: value }).success, true);
  }
  for (const value of [999, 100_001, -1, 1_500.5]) {
    assert.equal(
      appSettingsSchema.safeParse({ compactionBufferTokens: value }).success,
      false,
      `应拒绝 compactionBufferTokens=${String(value)}`,
    );
  }
});

test("轮末提前量只接受 0–100000 整数", () => {
  for (const value of [0, 6_000, 100_000]) {
    assert.equal(
      appSettingsSchema.safeParse({ compactionPostTurnThresholdOffsetTokens: value }).success,
      true,
    );
  }
  for (const value of [-1, 100_001, 2.5]) {
    assert.equal(
      appSettingsSchema.safeParse({ compactionPostTurnThresholdOffsetTokens: value }).success,
      false,
      `应拒绝 offset=${String(value)}`,
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

test("patch 中显式 null 表示恢复默认余量，缺席表示不修改", () => {
  const cleared = appSettingsPatchSchema.parse({ compactionBufferTokens: null });
  assert.equal(cleared.compactionBufferTokens, null);
  assert.equal("compactionBufferTokens" in cleared, true);

  const untouched = appSettingsPatchSchema.parse({ compactionMicrocompactEnabled: true });
  assert.equal("compactionBufferTokens" in untouched, false);
});

test("删除 thresholdPercent 不破坏旧数据：旧键被静默剥掉、解析不报错", () => {
  // validationAppSettings 的两个 schema 都是裸 z.object（非 strict），zod 对未知键默认剥掉。
  const parsed = appSettingsSchema.parse({
    compactionThresholdPercent: 80,
    compactionBufferTokens: 20_000,
  } as Record<string, unknown>);
  assert.equal("compactionThresholdPercent" in parsed, false);
  assert.equal(parsed.compactionBufferTokens, 20_000);

  const patched = appSettingsPatchSchema.parse({ compactionThresholdPercent: 80 });
  assert.equal("compactionThresholdPercent" in patched, false);
});

test("协议偏好 strict 拒绝 contextWindow 等多余字段", () => {
  const base = { ...DEFAULT_ZCODE_COMPACTION_PREFERENCES };
  assert.equal(zcodeCompactionPreferencesSchema.safeParse(base).success, true);
  assert.equal(
    zcodeCompactionPreferencesSchema.safeParse({ ...base, contextWindow: 200_000 }).success,
    false,
  );
  // 七项缺一不可：缺席由调用方补默认值，不在协议层静默兜底。
  const { postTurnThresholdOffsetTokens: _omitted, ...incomplete } = base;
  assert.equal(zcodeCompactionPreferencesSchema.safeParse(incomplete).success, false);
});
