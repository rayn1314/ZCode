import assert from "node:assert/strict";
import test from "node:test";
import { updateCompactionPolicy } from "../src/runtime/methods/config.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";
import type { AgentRuntimeConfig } from "../src/runtime/types.js";

/**
 * 压缩策略热更新的**逐字段合并**契约（spec: core/spec/context-compaction-controls.md §2 D3/D6）。
 *
 * 关键不变式：设置页只拥有七个开关，它没表达的键（CLI 文件里的 `enabled: false`、
 * `microcompact.thresholdTokens` / `idleThresholdMinutes` / `minTokenSavings` 等）
 * 必须活过一次热更新。任何整体替换都会让文件配置静默失效。
 */

function createRuntime(compact: AgentRuntimeConfig["compact"]): AgentRuntimeInternal {
  return { config: { compact } } as unknown as AgentRuntimeInternal;
}

function compactOf(runtime: AgentRuntimeInternal): NonNullable<AgentRuntimeConfig["compact"]> {
  const compact = runtime.config.compact;
  assert.ok(compact);
  return compact;
}

// 设置页整份下发时的形态：bufferTokens 为 number | null，其余为数字/布尔。
function settingsPatch(overrides: {
  bufferTokens?: number | null;
  microcompactEnabled?: boolean;
  keepRecentToolResults?: number;
  clearErrorResults?: boolean;
  postTurnEnabled?: boolean;
  postTurnThresholdOffsetTokens?: number;
  modelDownshiftEnabled?: boolean;
}) {
  return {
    bufferTokens: overrides.bufferTokens ?? null,
    microcompact: {
      enabled: overrides.microcompactEnabled ?? false,
      keepRecentToolResults: overrides.keepRecentToolResults ?? 5,
      clearErrorResults: overrides.clearErrorResults ?? false,
    },
    postTurnEnabled: overrides.postTurnEnabled ?? false,
    postTurnThresholdOffsetTokens: overrides.postTurnThresholdOffsetTokens ?? 0,
    modelDownshiftEnabled: overrides.modelDownshiftEnabled ?? false,
  };
}

test("压缩总开关归文件所有：一次设置页热更新不会把 enabled:false 改回来", () => {
  const runtime = createRuntime({
    enabled: false,
    microcompact: { enabled: true, thresholdTokens: 1234 },
  });

  updateCompactionPolicy.call(runtime, settingsPatch({ postTurnEnabled: true }));

  assert.equal(compactOf(runtime).enabled, false);
  assert.equal(compactOf(runtime).postTurnEnabled, true);
});

test("microcompact 逐键合并：文件里的 thresholdTokens / idleThresholdMinutes 存活", () => {
  const runtime = createRuntime({
    microcompact: {
      enabled: true,
      thresholdTokens: 1234,
      idleThresholdMinutes: 60,
      minTokenSavings: 512,
    },
  });

  // 用户只打开了「轮末压缩」——设置页的七项全量里 microcompact 仍是默认关闭，
  // 因此 microcompact.enabled 会被显式关掉（用户表达的是「局部压缩关」），
  // 但用户没有表达的 thresholdTokens / idleThresholdMinutes / minTokenSavings 必须保留。
  updateCompactionPolicy.call(runtime, settingsPatch({ postTurnEnabled: true }));

  assert.equal(compactOf(runtime).microcompact?.enabled, false);
  assert.equal(compactOf(runtime).microcompact?.thresholdTokens, 1234);
  assert.equal(compactOf(runtime).microcompact?.idleThresholdMinutes, 60);
  assert.equal(compactOf(runtime).microcompact?.minTokenSavings, 512);
});

test("稀疏 patch：只改表达过的字段，其余保持不动", () => {
  const runtime = createRuntime({
    enabled: false,
    bufferTokens: 20_000,
    postTurnThresholdOffsetTokens: 6_000,
    microcompact: { enabled: true, thresholdTokens: 1234, keepRecentToolResults: 20 },
  });

  updateCompactionPolicy.call(runtime, { microcompact: { keepRecentToolResults: 8 } });

  assert.equal(compactOf(runtime).enabled, false);
  assert.equal(compactOf(runtime).bufferTokens, 20_000);
  assert.equal(compactOf(runtime).postTurnThresholdOffsetTokens, 6_000);
  assert.equal(compactOf(runtime).microcompact?.enabled, true);
  assert.equal(compactOf(runtime).microcompact?.keepRecentToolResults, 8);
  assert.equal(compactOf(runtime).microcompact?.thresholdTokens, 1234);
});

test("bufferTokens: null 显式清除覆盖，回到默认余量", () => {
  const runtime = createRuntime({ bufferTokens: 20_000 });

  updateCompactionPolicy.call(runtime, { bufferTokens: null });

  assert.equal("bufferTokens" in compactOf(runtime), false);
});

test("bufferTokens 数字覆盖写入，undefined 不修改", () => {
  const runtime = createRuntime({ bufferTokens: 20_000 });

  updateCompactionPolicy.call(runtime, { bufferTokens: 30_000 });
  assert.equal(compactOf(runtime).bufferTokens, 30_000);

  updateCompactionPolicy.call(runtime, { postTurnEnabled: true });
  assert.equal(compactOf(runtime).bufferTokens, 30_000);
});

test("轮末提前量数字覆盖写入，undefined 不修改", () => {
  const runtime = createRuntime({ postTurnThresholdOffsetTokens: 3_000 });

  updateCompactionPolicy.call(runtime, { postTurnThresholdOffsetTokens: 8_000 });
  assert.equal(compactOf(runtime).postTurnThresholdOffsetTokens, 8_000);

  updateCompactionPolicy.call(runtime, { postTurnEnabled: true });
  assert.equal(compactOf(runtime).postTurnThresholdOffsetTokens, 8_000);
});
