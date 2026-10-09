import assert from "node:assert/strict";
import test from "node:test";
import { CompactPhase, CompactReason, CompactTrigger } from "@zcode/contracts";
import { maybeCompactForModelDownshift } from "../src/runtime/methods/model-downshift-compact.js";
import { maybeCompactAfterTurn } from "../src/runtime/methods/post-turn-compact.js";
import { evaluateRuntimeAutoCompactDecision } from "../src/runtime/methods/compact-decision.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { ActiveTurnSteeringState } from "../src/runtime/types.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

/**
 * 轮末压缩与降档提前压的接线契约（spec: core/spec/context-compaction-controls.md §2 D8/D9、§3.3/§3.4）：
 * - 开关为 false / 未配置时不下手；
 * - 阈值未到时不下手；
 * - 窗口没有变小（升级或同窗口）时降档压缩不下手；
 * - 条件满足时必须以正确的 trigger/phase/reason 真的调用 compactActiveConversation。
 *
 * 这是"开关真的接到了生产路径"的证据：仅靠 config 字段存在不能证明路径会被调用。
 */

const LONG_TEXT = "上下文内容 ".repeat(400);
const MODEL_WINDOW = 128_000;

const MODEL = {
  modelId: "small-model",
  optionSpecs: { maxOutputTokens: { max: 32_000 }, reasoningLevel: { values: [] } },
  options: {},
  properties: { contextWindow: MODEL_WINDOW, supportsMidConversationSystem: false },
  providerId: "test-provider",
} as unknown as Parameters<typeof maybeCompactForModelDownshift>[1]["model"];

function entry(role: "user" | "assistant", text: string): RuntimeMessageEntry {
  return {
    message: { role, content: text },
    metadata: role === "user" ? { source: "real_user" } : undefined,
  };
}

function history(): RuntimeMessageEntry[] {
  return [
    entry("user", "第一轮问题"),
    entry("assistant", LONG_TEXT),
    entry("user", "第二轮问题"),
    entry("assistant", LONG_TEXT),
  ];
}

interface CompactCall {
  readonly options: Record<string, unknown> | undefined;
}

function stubRuntime(input: {
  compact: Record<string, unknown>;
  hasQueuedCommand?: boolean;
  calls: CompactCall[];
  entries?: RuntimeMessageEntry[];
}): AgentRuntimeInternal {
  return {
    autoCompactConsecutiveFailures: 0,
    compactActiveConversation: async (
      _instructions: unknown,
      _traceContext: unknown,
      _events: unknown,
      options: Record<string, unknown>,
    ) => {
      input.calls.push({ options });
      return { displayText: "", entries: history(), outcome: "compacted" as const, tokenCount: 0 };
    },
    config: { compact: input.compact, midConversationSystem: undefined },
    logger: undefined,
    messageHistory: { borrowReadOnlyRuntimeEntries: () => input.entries ?? history() },
    runtimeCommandQueue: { hasPending: () => input.hasQueuedCommand === true },
  } as unknown as AgentRuntimeInternal;
}

const TRACE_CONTEXT = {
  sessionId: "sess_test",
  traceId: "trace_test",
} as unknown as Parameters<typeof maybeCompactForModelDownshift>[1]["traceContext"];

/**
 * 安全余量 106000 让"阈值已达到"只依赖少量文本（128K 窗口 → 输入侧上限 107000 → 阈值 1000），
 * 判定稳定、不依赖估算细节。
 */
const REACHED_THRESHOLD = { enabled: true, bufferTokens: 106_000 };

test("降档提前压：窗口变小且阈值已达到时，以 model_downshift 真调用压缩", async () => {
  const calls: CompactCall[] = [];
  const runtime = stubRuntime({
    calls,
    compact: { ...REACHED_THRESHOLD, modelDownshiftEnabled: true },
  });

  await maybeCompactForModelDownshift(runtime, {
    events: [],
    model: MODEL,
    previousContextWindow: 200_000,
    traceContext: TRACE_CONTEXT,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.trigger, CompactTrigger.ModelDownshift);
  assert.equal(calls[0]?.options?.phase, CompactPhase.PreRequest);
  assert.equal(calls[0]?.options?.compactReason, CompactReason.ModelDownshift);
});

test("降档提前压：窗口变大（升级）或未知时不下手", async () => {
  const calls: CompactCall[] = [];
  const runtime = stubRuntime({
    calls,
    compact: { ...REACHED_THRESHOLD, modelDownshiftEnabled: true },
  });

  // 同窗口（未变）、升级（新窗口更大）、上一窗口未知——三种都不该压。
  await maybeCompactForModelDownshift(runtime, {
    events: [],
    model: MODEL,
    previousContextWindow: MODEL_WINDOW,
    traceContext: TRACE_CONTEXT,
  });
  await maybeCompactForModelDownshift(runtime, {
    events: [],
    model: MODEL,
    previousContextWindow: 64_000,
    traceContext: TRACE_CONTEXT,
  });
  await maybeCompactForModelDownshift(runtime, {
    events: [],
    model: MODEL,
    traceContext: TRACE_CONTEXT,
  });

  assert.equal(calls.length, 0);
});

test("降档提前压：开关为 false 时不下手", async () => {
  const calls: CompactCall[] = [];
  const runtime = stubRuntime({
    calls,
    compact: { ...REACHED_THRESHOLD, modelDownshiftEnabled: false },
  });

  await maybeCompactForModelDownshift(runtime, {
    events: [],
    model: MODEL,
    previousContextWindow: 200_000,
    traceContext: TRACE_CONTEXT,
  });

  assert.equal(calls.length, 0);
});

test("轮末压缩：开关打开且无排队输入时，以 post_turn 真调用压缩", async () => {
  const calls: CompactCall[] = [];
  const runtime = stubRuntime({ calls, compact: { ...REACHED_THRESHOLD, postTurnEnabled: true } });

  await maybeCompactAfterTurn(runtime, {
    activeTurn: { pendingInputs: [] } as unknown as ActiveTurnSteeringState,
    events: [],
    model: MODEL,
    traceContext: TRACE_CONTEXT,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options?.trigger, CompactTrigger.PostTurn);
  assert.equal(calls[0]?.options?.phase, CompactPhase.PostTurn);
  assert.equal(calls[0]?.options?.compactReason, CompactReason.ContextLimit);
});

test("轮末压缩：有排队输入或开关关闭时不下手", async () => {
  const queuedCalls: CompactCall[] = [];
  await maybeCompactAfterTurn(
    stubRuntime({
      calls: queuedCalls,
      compact: { ...REACHED_THRESHOLD, postTurnEnabled: true },
      hasQueuedCommand: true,
    }),
    {
      activeTurn: { pendingInputs: [] } as unknown as ActiveTurnSteeringState,
      events: [],
      model: MODEL,
      traceContext: TRACE_CONTEXT,
    },
  );
  await maybeCompactAfterTurn(
    stubRuntime({
      calls: queuedCalls,
      compact: { ...REACHED_THRESHOLD, postTurnEnabled: true },
    }),
    {
      activeTurn: { pendingInputs: [{}] } as unknown as ActiveTurnSteeringState,
      events: [],
      model: MODEL,
      traceContext: TRACE_CONTEXT,
    },
  );

  const disabledCalls: CompactCall[] = [];
  await maybeCompactAfterTurn(
    stubRuntime({
      calls: disabledCalls,
      compact: { ...REACHED_THRESHOLD, postTurnEnabled: false },
    }),
    {
      activeTurn: { pendingInputs: [] } as unknown as ActiveTurnSteeringState,
      events: [],
      model: MODEL,
      traceContext: TRACE_CONTEXT,
    },
  );

  assert.equal(queuedCalls.length, 0);
  assert.equal(disabledCalls.length, 0);
});

test("轮末压缩：压缩抛错只吞掉，不向调用方冒泡", async () => {
  const runtime = stubRuntime({
    calls: [],
    compact: { ...REACHED_THRESHOLD, postTurnEnabled: true },
  });
  (runtime as unknown as { compactActiveConversation: unknown }).compactActiveConversation =
    async () => {
      throw new Error("compact exploded");
    };

  await assert.doesNotReject(
    maybeCompactAfterTurn(runtime, {
      activeTurn: { pendingInputs: [] } as unknown as ActiveTurnSteeringState,
      events: [],
      model: MODEL,
      traceContext: TRACE_CONTEXT,
    }),
  );
});

/**
 * 提前量真的接进了轮末判定（不是纯函数摆设）：
 * 让 token 数正好落在 (自动阈值 − 提前量, 自动阈值) 之间——传 `forPostTurn: true` 会压，
 * 不传（自动压缩语义）不会；低于 (自动阈值 − 提前量) 时传了也不压。
 *
 * 128K 窗口 → 输入侧上限 107000 → 默认自动阈值 94000；提前量 6000 → 轮末阈值 88000。
 */
function historyWithUsage(tokenCount: number): RuntimeMessageEntry[] {
  return [
    entry("user", "第一轮问题"),
    entry("assistant", LONG_TEXT),
    entry("user", "第二轮问题"),
    {
      message: { role: "assistant", content: LONG_TEXT },
      // usage 挂在最后一条 assistant 上：provider 基线 + 其后增量为 0，tokenCount 完全可控。
      tokens: {
        input: tokenCount - 1,
        output: 1,
        reasoning: 0,
        total: tokenCount,
        cache: { read: 0, write: 0 },
      },
    } as unknown as RuntimeMessageEntry,
  ];
}

function decisionRuntime(
  entries: RuntimeMessageEntry[],
  offsetTokens: number,
): AgentRuntimeInternal {
  return stubRuntime({
    calls: [],
    entries,
    compact: { enabled: true, postTurnThresholdOffsetTokens: offsetTokens },
  });
}

test("轮末提前量接进判定：token 落在 (自动阈值−提前量, 自动阈值) 时只有轮末会压", () => {
  const runtime = decisionRuntime(historyWithUsage(90_000), 6_000);

  const autoDecision = evaluateRuntimeAutoCompactDecision(runtime, MODEL);
  assert.equal(autoDecision.threshold, 94_000);
  assert.equal(autoDecision.shouldCompact, false);
  assert.equal(autoDecision.reason, "below_threshold");

  const postTurnDecision = evaluateRuntimeAutoCompactDecision(runtime, MODEL, {
    forPostTurn: true,
  });
  assert.equal(postTurnDecision.threshold, 88_000);
  assert.equal(postTurnDecision.shouldCompact, true);
  assert.equal(postTurnDecision.reason, "above_threshold");
});

test("轮末提前量接进判定：低于 (自动阈值−提前量) 时轮末也不压", () => {
  const runtime = decisionRuntime(historyWithUsage(87_000), 6_000);

  const postTurnDecision = evaluateRuntimeAutoCompactDecision(runtime, MODEL, {
    forPostTurn: true,
  });
  assert.equal(postTurnDecision.threshold, 88_000);
  assert.equal(postTurnDecision.shouldCompact, false);
});

test("轮末提前量为 0 时判定与自动压缩逐位相同", () => {
  const runtime = decisionRuntime(historyWithUsage(93_000), 0);

  const autoDecision = evaluateRuntimeAutoCompactDecision(runtime, MODEL);
  const postTurnDecision = evaluateRuntimeAutoCompactDecision(runtime, MODEL, {
    forPostTurn: true,
  });
  assert.equal(postTurnDecision.threshold, autoDecision.threshold);
  assert.equal(postTurnDecision.shouldCompact, autoDecision.shouldCompact);
});
