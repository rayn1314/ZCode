import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_ZCODE_COMPACTION_PREFERENCES } from "@zcode/shared";
import {
  compactionPreferencesToPolicy,
  compactionPreferencesToPolicyOverride,
} from "../src/compaction-policy.js";

/**
 * 两个 mapper 的**稀疏语义**契约（spec: core/spec/context-compaction-controls.md §2 D6/D12）。
 *
 * 创建期 override 必须"条件省略键"：写成 `{bufferTokens: x ?? undefined}` 时键仍在，
 * 展开进 runtimeConfig.compact 会把 CLI 文件里的同名值清成 undefined——文件配置静默失效，
 * 且 schema / 类型都拦不住。热更新则相反：必须全量 present，否则用户改回默认值时不生效。
 */

function preferences(overrides: Partial<typeof DEFAULT_ZCODE_COMPACTION_PREFERENCES> = {}) {
  return { ...DEFAULT_ZCODE_COMPACTION_PREFERENCES, ...overrides };
}

test("全默认偏好：创建期 override 返回空对象（整段省略，文件 compact 段完整生效）", () => {
  assert.deepEqual(compactionPreferencesToPolicyOverride(preferences()), {});
});

test("创建期 override：bufferTokens 为 null 时不写键，非 null 时写值", () => {
  const auto = compactionPreferencesToPolicyOverride(preferences({ bufferTokens: null }));
  assert.equal("bufferTokens" in auto, false);

  const explicit = compactionPreferencesToPolicyOverride(preferences({ bufferTokens: 20_000 }));
  assert.equal(explicit.bufferTokens, 20_000);
});

test("创建期 override：轮末提前量为 0 时不写键（0 是默认值，写它会覆盖文件值）", () => {
  const zero = compactionPreferencesToPolicyOverride(
    preferences({ postTurnThresholdOffsetTokens: 0 }),
  );
  assert.equal("postTurnThresholdOffsetTokens" in zero, false);

  const positive = compactionPreferencesToPolicyOverride(
    preferences({ postTurnThresholdOffsetTokens: 6_000 }),
  );
  assert.equal(positive.postTurnThresholdOffsetTokens, 6_000);
});

test("创建期 override：偏好为 false 的开关不写键（不产出 explicit false）", () => {
  const policy = compactionPreferencesToPolicyOverride(
    preferences({ bufferTokens: 20_000, postTurnThresholdOffsetTokens: 6_000 }),
  );
  assert.equal("postTurnEnabled" in policy, false);
  assert.equal("modelDownshiftEnabled" in policy, false);
  assert.equal("microcompact" in policy, false);
});

test("热更新 mapper：全量 present，改回默认值也能真的下发", () => {
  const policy = compactionPreferencesToPolicy(preferences());
  assert.equal(policy.bufferTokens, null);
  assert.equal(policy.postTurnThresholdOffsetTokens, 0);
  assert.equal(policy.postTurnEnabled, false);
  assert.equal(policy.modelDownshiftEnabled, false);
  assert.deepEqual(policy.microcompact, {
    enabled: false,
    keepRecentToolResults: 5,
    clearErrorResults: false,
  });
});

test("两个 mapper 都不产出 contextWindow / maxOutputTokens（由模型推导）", () => {
  const prefs = preferences({ bufferTokens: 20_000 });
  for (const policy of [
    compactionPreferencesToPolicy(prefs),
    compactionPreferencesToPolicyOverride(prefs),
  ]) {
    assert.equal("contextWindow" in policy, false);
    assert.equal("maxOutputTokens" in policy, false);
  }
});
