import assert from "node:assert/strict";
import test from "node:test";
import { ConfigScope, DEFAULT_SUBAGENT_MAX_CONCURRENT } from "@zcode/contracts";
import { parseEnvConfig } from "../src/config/env-config.adapter.js";
import { createPrioritizedConfig, mergeConfigs } from "../src/config/config-merger.js";
import { createConfigPort } from "../src/config/index.js";
import { parseConfigFileToRuntimePatchWithDiagnostics } from "../src/config/schema.js";

/**
 * `subagents.maxConcurrent` 配置通道端到端（spec: core/spec/subagent-seat-gate-and-registry-bounds.md）。
 * 只断言 schema 能解析不构成证明：通道断在 env 解析 / merger / ConfigStore 上时，
 * 座位闸门会静默退回默认值。因此走真实路径：env / config.json → merger → ConfigStore.getAll()。
 */

test("缺省 10：未配置任何来源时 getAll 给出默认容量", () => {
  const port = createConfigPort(mergeConfigs());
  assert.equal(port.getAll().subagents.maxConcurrent, DEFAULT_SUBAGENT_MAX_CONCURRENT);
  assert.equal(DEFAULT_SUBAGENT_MAX_CONCURRENT, 10);
});

test("ZCODE_SUBAGENT_MAX_CONCURRENT 进入配置并覆盖缺省", () => {
  const patch = parseEnvConfig({ ZCODE_SUBAGENT_MAX_CONCURRENT: "3" });
  assert.equal(patch.subagents?.maxConcurrent, 3);

  const port = createConfigPort(mergeConfigs(createPrioritizedConfig(patch, ConfigScope.Env)));
  assert.equal(port.getAll().subagents.maxConcurrent, 3);
});

test("env 越界/非法值不覆盖缺省（不静默降级到 1）", () => {
  for (const value of ["0", "-2", "65", "abc", "2.5"]) {
    const patch = parseEnvConfig({ ZCODE_SUBAGENT_MAX_CONCURRENT: value });
    assert.equal(patch.subagents, undefined, `非法值 ${value} 不得写入 subagents 配置`);
  }
  assert.equal(createConfigPort(mergeConfigs()).getAll().subagents.maxConcurrent, 10);
});

test("配置文件 subagents 段经 schema → merger → getAll 端到端保留（env 更高优先）", () => {
  const fileParsed = parseConfigFileToRuntimePatchWithDiagnostics({
    subagents: { maxConcurrent: 6 },
  });
  const envPatch = parseEnvConfig({ ZCODE_SUBAGENT_MAX_CONCURRENT: "4" });

  const port = createConfigPort(
    mergeConfigs(
      createPrioritizedConfig(fileParsed.config, ConfigScope.User),
      createPrioritizedConfig(envPatch, ConfigScope.Env),
    ),
  );

  // Env（40）高于 User（10）：env 覆盖文件值。
  assert.equal(port.getAll().subagents.maxConcurrent, 4);

  // 只有文件时取文件值；跨来源合并不丢段。
  const fileOnly = createConfigPort(
    mergeConfigs(createPrioritizedConfig(fileParsed.config, ConfigScope.User)),
  );
  assert.equal(fileOnly.getAll().subagents.maxConcurrent, 6);
});

test("配置文件越界值被 schema 拒绝", () => {
  assert.throws(() =>
    parseConfigFileToRuntimePatchWithDiagnostics({ subagents: { maxConcurrent: 0 } }),
  );
  assert.throws(() =>
    parseConfigFileToRuntimePatchWithDiagnostics({ subagents: { maxConcurrent: 65 } }),
  );
});
