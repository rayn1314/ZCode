import assert from "node:assert/strict";
import test from "node:test";
import { ConfigScope, mergeCompactConfig } from "@zcode/contracts";
import { createPrioritizedConfig, mergeConfigs } from "../src/config/config-merger.js";
import { createConfigPort } from "../src/config/index.js";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../src/config/schema.js";

/**
 * CLI 文件通道 `compact` 段端到端（spec: core/spec/context-compaction-controls.md §2 D5）。
 *
 * 只断言 schema 能解析**不构成证明**：通道断在 merger / ConfigStore 上时 schema 依然绿，
 * 而配置文件会静默不生效。因此这里走真实路径：
 *   config.json 原始对象 → schema 校验 → 多层合并 → ConfigStore.getAll()
 * 并断言最终 RuntimeConfig 里文件值仍然存在。
 */

test("文件 compact 段经 schema → ConfigStore.getAll() 端到端保留", () => {
  const parsed = parseConfigFileToRuntimePatchWithDiagnostics({
    compact: {
      enabled: false,
      thresholdPercent: 70,
      microcompact: { enabled: true, thresholdTokens: 1234, keepRecentToolResults: 20 },
      postTurnEnabled: true,
    },
  });

  const port = createConfigPort(
    mergeConfigs(createPrioritizedConfig(parsed.config, ConfigScope.User)),
  );
  const compact = port.getAll().compact;

  assert.equal(compact.enabled, false);
  assert.equal(compact.thresholdPercent, 70);
  assert.equal(compact.postTurnEnabled, true);
  assert.equal(compact.microcompact?.enabled, true);
  assert.equal(compact.microcompact?.thresholdTokens, 1234);
  assert.equal(compact.microcompact?.keepRecentToolResults, 20);
});

test("多层配置合并：高优先级只表达一项时不吞掉低优先级的其余子键", () => {
  const merged = mergeConfigs(
    createPrioritizedConfig(
      { compact: { microcompact: { enabled: true, thresholdTokens: 1234 } } },
      ConfigScope.Project,
    ),
    createPrioritizedConfig({ compact: { postTurnEnabled: true } }, ConfigScope.User),
  );

  assert.equal(merged.compact?.postTurnEnabled, true);
  assert.equal(merged.compact?.microcompact?.enabled, true);
  assert.equal(merged.compact?.microcompact?.thresholdTokens, 1234);
});

test("会话级覆盖合并（mergeCompactConfig）逐字段：文件值在未被表达时存活", () => {
  const merged = mergeCompactConfig(
    { enabled: false, microcompact: { enabled: true, thresholdTokens: 1234 } },
    // 会话级稀疏覆盖：只表达 postTurnEnabled。
    { postTurnEnabled: true },
  );

  assert.equal(merged.enabled, false);
  assert.equal(merged.postTurnEnabled, true);
  assert.equal(merged.microcompact?.enabled, true);
  assert.equal(merged.microcompact?.thresholdTokens, 1234);
});

test("越界阈值百分比被 schema 拒绝，不静默夹紧", () => {
  for (const thresholdPercent of [0, 101, 1.5]) {
    assert.throws(() =>
      parseConfigFileToRuntimePatchWithDiagnostics({ compact: { thresholdPercent } }),
    );
  }
});

test("没有 compact 段时得到空对象，行为与升级前一致", () => {
  const parsed = parseConfigFileToRuntimePatchWithDiagnostics({ ui: { locale: "zh-CN" } });
  const port = createConfigPort(
    mergeConfigs(createPrioritizedConfig(parsed.config, ConfigScope.User)),
  );

  assert.deepEqual(port.getAll().compact, {});
});
