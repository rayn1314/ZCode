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
 * - 未配置 thresholdPercent 时阈值与改造前逐位一致（公式）；
 * - 配置了按"模型完整窗口 × 百分比"计算，并夹在输入侧上限之内；
 * - 越界百分比按未配置处理（fail-safe，不静默改成用户没要求的值）；
 * - 策略合成把模型推导字段放在展开之后强制覆盖，误带的 contextWindow 不能污染真实窗口。
 */

const CONTEXT_WINDOW = 200_000;
const MAX_OUTPUT_TOKENS = 32_000;
// 输入侧上限 = 200000 − min(32000, 21000)；再减 buffer 13000 = 166000（≈ 83%）。
const EFFECTIVE_WINDOW = CONTEXT_WINDOW - 21_000;
const FORMULA_THRESHOLD = EFFECTIVE_WINDOW - AUTOCOMPACT_BUFFER_TOKENS;

function policyConfig(overrides: { thresholdPercent?: number | undefined } = {}): {
  contextWindow: number;
  maxOutputTokens: number;
  thresholdPercent?: number;
} {
  return {
    contextWindow: CONTEXT_WINDOW,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    ...overrides,
  };
}

test("未配置 thresholdPercent：阈值等于 (窗口 − 输出预留) − buffer 公式值", () => {
  assert.equal(getAutoCompactThreshold(policyConfig()), FORMULA_THRESHOLD);
  assert.equal(getAutoCompactThresholdPercent(policyConfig()), 83);
});

test("配置 thresholdPercent：按模型完整窗口取百分比，而不是按输入侧上限", () => {
  const threshold = getAutoCompactThreshold(policyConfig({ thresholdPercent: 80 }));
  assert.equal(threshold, 160_000);
  assert.equal(getAutoCompactThresholdPercent(policyConfig({ thresholdPercent: 80 })), 80);
});

test("thresholdPercent 超过输入侧上限时夹到 effectiveContextWindow", () => {
  const threshold = getAutoCompactThreshold(policyConfig({ thresholdPercent: 100 }));
  assert.equal(threshold, EFFECTIVE_WINDOW);
});

test("越界 thresholdPercent 按未配置处理，回落公式阈值", () => {
  for (const outOfRange of [0, -5, 101, 150, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(
      getAutoCompactThreshold(policyConfig({ thresholdPercent: outOfRange })),
      FORMULA_THRESHOLD,
      `thresholdPercent=${String(outOfRange)} 应回落公式阈值`,
    );
    assert.equal(getAutoCompactThresholdPercent(policyConfig({ thresholdPercent: outOfRange })), 83);
  }
});

test("shouldAutoCompact 的阈值信息来源随 thresholdPercent 变化", () => {
  const messages = [
    { role: "user" as const, content: "hello" },
    { role: "assistant" as const, content: "world" },
    { role: "user" as const, content: "again" },
  ];
  const below = shouldAutoCompact({
    messages,
    config: policyConfig({ thresholdPercent: 1 }),
    tokenOverride: { source: "provider_usage", tokenCount: 1_000 },
  });
  assert.equal(below.shouldCompact, false);
  assert.equal(below.reason, "below_threshold");
  assert.equal(below.threshold, 2_000);

  const above = shouldAutoCompact({
    messages,
    config: policyConfig({ thresholdPercent: 1 }),
    tokenOverride: { source: "provider_usage", tokenCount: 5_000 },
  });
  assert.equal(above.shouldCompact, true);
  assert.equal(above.reason, "above_threshold");
});

test("新触发器不能绕过 disabled：enabled:false 依然优先于阈值判定", () => {
  const decision = shouldAutoCompact({
    messages: [
      { role: "user" as const, content: "a" },
      { role: "assistant" as const, content: "b" },
      { role: "user" as const, content: "c" },
    ],
    config: { ...policyConfig({ thresholdPercent: 1 }), enabled: false },
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
    compact: { contextWindow: 1, thresholdPercent: 50 },
    modelContextBudgetStrategy: "legacy",
  } as unknown as AgentRuntimeConfig;

  const policy = resolveRuntimeCompactPolicyConfig(config, model);
  assert.equal(policy.contextWindow, CONTEXT_WINDOW);
  assert.equal(policy.thresholdPercent, 50);
  assert.equal(getAutoCompactThreshold(policy), 100_000);
});

test("defaultCompactPhaseForTrigger / ReasonForTrigger 覆盖轮末与降档", () => {
  assert.equal(defaultCompactPhaseForTrigger(CompactTrigger.PostTurn), CompactPhase.PostTurn);
  assert.equal(defaultCompactPhaseForTrigger(CompactTrigger.ModelDownshift), CompactPhase.PreRequest);
  assert.equal(defaultCompactReasonForTrigger(CompactTrigger.PostTurn), CompactReason.ContextLimit);
  assert.equal(
    defaultCompactReasonForTrigger(CompactTrigger.ModelDownshift),
    CompactReason.ModelDownshift,
  );
});
