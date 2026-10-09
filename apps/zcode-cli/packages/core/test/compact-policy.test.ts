import assert from "node:assert/strict";
import test from "node:test";
import { CompactReason, CompactTrigger, CompactPhase } from "@zcode/contracts";
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  getAutoCompactThreshold,
  getAutoCompactThresholdPercent,
  shouldAutoCompact,
} from "../src/compact/policy.js";
import { resolveRuntimeCompactPolicyConfig } from "../src/runtime/methods/compact-policy-config.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
} from "../src/runtime/helpers/compact.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";
import type { Model } from "../src/runtime/deps.js";

/**
 * 压缩阈值与策略合成契约（spec: core/spec/context-compaction-controls.md §2 D7、§4 I3）：
 * - 阈值的用户可调项是**安全余量**（tokens）：阈值 = 输入侧上限 − 余量；
 * - 未配置余量时与改造前逐位一致（默认余量 13000 → 200K 窗口 166000 ≈ 83%）；
 * - 百分比只是反算出来的只读展示值，不可覆盖，不存在"百分比配置"路径；
 * - 策略合成把模型推导字段放在展开之后强制覆盖，误带的 contextWindow 不能污染真实窗口。
 */

const CONTEXT_WINDOW = 200_000;
const MAX_OUTPUT_TOKENS = 32_000;
// 输入侧上限 = 200000 − min(32000, 21000) = 179000；再减默认余量 13000 = 166000（≈ 83%）。
const EFFECTIVE_WINDOW = CONTEXT_WINDOW - 21_000;
const DEFAULT_THRESHOLD = EFFECTIVE_WINDOW - AUTOCOMPACT_BUFFER_TOKENS;

function policyConfig(overrides: { bufferTokens?: number } = {}): {
  contextWindow: number;
  maxOutputTokens: number;
  bufferTokens?: number;
} {
  return {
    contextWindow: CONTEXT_WINDOW,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...overrides,
  };
}

test("未配置安全余量：阈值等于 (窗口 − 输出预留) − 默认余量，百分比为反算值", () => {
  assert.equal(getAutoCompactThreshold(policyConfig()), DEFAULT_THRESHOLD);
  assert.equal(getAutoCompactThresholdPercent(policyConfig()), 83);
});

test("配置安全余量：阈值 = 输入侧上限 − 余量（绝对 tokens，不是按窗口比例）", () => {
  const config = policyConfig({ bufferTokens: 30_000 });
  assert.equal(getAutoCompactThreshold(config), EFFECTIVE_WINDOW - 30_000);
  assert.equal(getAutoCompactThresholdPercent(config), 74);
});

test("余量大于输入侧上限时阈值夹到 0，不会变成负数", () => {
  assert.equal(getAutoCompactThreshold(policyConfig({ bufferTokens: 500_000 })), 0);
});

test("shouldAutoCompact 的阈值随安全余量变化，并据此判定是否压缩", () => {
  const messages = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "world" },
    { role: "user" as const, content: "again" },
  ];
  // 余量 177000 → 阈值 2000，让判定只依赖 tokenOverride，稳定不依赖估算细节。
  const config = policyConfig({ bufferTokens: 177_000 });
  const below = shouldAutoCompact({
    messages,
    config,
    tokenOverride: { source: "provider_usage", tokenCount: 1_000 },
  });
  assert.equal(below.shouldCompact, false);
  assert.equal(below.reason, "below_threshold");
  assert.equal(below.threshold, 2_000);

  const above = shouldAutoCompact({
    messages,
    config,
    tokenOverride: { source: "provider_usage", tokenCount: 5_000 },
  });
  assert.equal(above.shouldCompact, true);
  assert.equal(above.reason, "above_threshold");
});

test("enabled:false 依然优先于阈值判定", () => {
  const decision = shouldAutoCompact({
    messages: [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ],
    config: { ...policyConfig({ bufferTokens: 177_000 }), enabled: false },
    tokenOverride: { source: "provider_usage", tokenCount: 10_000 },
  });
  assert.equal(decision.shouldCompact, false);
  assert.equal(decision.reason, "disabled");
});

test("resolveRuntimeCompactPolicyConfig 用模型真实窗口覆盖策略里误带的 contextWindow", () => {
  const model = {
    modelId: "test-model",
    optionSpecs: { maxOutputTokens: { max: MAX_OUTPUT_TOKENS } },
    properties: { contextWindow: CONTEXT_WINDOW },
    providerId: "test-provider",
  } as unknown as Model;
  const config = {
    compact: { contextWindow: 1, bufferTokens: 20_000 },
    modelContextBudgetStrategy: "legacy",
  } as unknown as AgentRuntimeConfig;

  const policy = resolveRuntimeCompactPolicyConfig(config, model);
  assert.equal(policy.contextWindow, CONTEXT_WINDOW);
  assert.equal(policy.bufferTokens, 20_000);
  assert.equal(getAutoCompactThreshold(policy), EFFECTIVE_WINDOW - 20_000);
});

test("defaultCompactPhaseForTrigger / ReasonForTrigger 覆盖轮末与降档", () => {
  assert.equal(defaultCompactPhaseForTrigger(CompactTrigger.PostTurn), CompactPhase.PostTurn);
  assert.equal(
    defaultCompactPhaseForTrigger(CompactTrigger.ModelDownshift),
    CompactPhase.PreRequest,
  );
  assert.equal(defaultCompactReasonForTrigger(CompactTrigger.PostTurn), CompactReason.ContextLimit);
  assert.equal(
    defaultCompactReasonForTrigger(CompactTrigger.ModelDownshift),
    CompactReason.ModelDownshift,
  );
});
