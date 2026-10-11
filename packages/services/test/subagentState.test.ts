import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { sealDataRoot } from "./helpers/sealedDataRoot.js";
import { createSubagentsService } from "../src/subagents/subagentsService.js";

/**
 * 子代理配置的写入契约（spec: core/spec/subagent-settings-sync.md D1/D2）：
 * - 三条写入路径（内置覆盖 / 插件覆盖 / 启用状态）都返回**写盘后的全量快照**，
 *   调用方原样推给运行中会话与远端环境；
 * - 「改回继承 / 重新启用」= 删除，全量快照必须反映删除（增量补丁表达不了）；
 * - `getSubagentState` 与写入同一份文件（同源读取）；
 * - `replaceSubagentState` 整份替换远端副本，未在快照里的项必须消失。
 */
test("三条写入路径都返回全量快照，删除可见，读取与写入同源", async () => {
  await using root = await sealDataRoot("zcode-subagent-state-");
  const service = createSubagentsService();

  const first = await service.setBuiltInModelOverride({
    agentName: "general-purpose",
    modelSelection: { providerId: "prov-1", modelId: "u2-flash" },
  });
  assert.deepEqual(first.builtInModelSelectionOverrides, {
    "general-purpose": { providerId: "prov-1", modelId: "u2-flash" },
  });

  const second = await service.setPluginAgentModelOverride({
    agentId: "plugin:demo:reviewer",
    modelSelection: { providerId: "prov-1", modelId: "u2-override" },
  });
  assert.deepEqual(second.builtInModelSelectionOverrides, {
    "general-purpose": { providerId: "prov-1", modelId: "u2-flash" },
  });
  assert.deepEqual(second.pluginAgentModelSelectionOverrides, {
    "plugin:demo:reviewer": { providerId: "prov-1", modelId: "u2-override" },
  });

  const disabled = await service.setEnabled({ agentId: "helper", enabled: false });
  assert.deepEqual(disabled.disabledAgentIds, ["helper"]);
  assert.deepEqual(disabled.pluginAgentModelSelectionOverrides, {
    "plugin:demo:reviewer": { providerId: "prov-1", modelId: "u2-override" },
  });

  // 改回继承 = 删键；全量快照必须把删除也报出来，否则重推会把删除丢失。
  const cleared = await service.setBuiltInModelOverride({
    agentName: "general-purpose",
    modelSelection: undefined,
  });
  assert.deepEqual(cleared.builtInModelSelectionOverrides, {});
  const reEnabled = await service.setEnabled({ agentId: "helper", enabled: true });
  assert.deepEqual(reEnabled.disabledAgentIds, []);
  // 一次写入不得抹掉另两项：三条路径改的是同一份快照的不同字段。
  assert.deepEqual(reEnabled.pluginAgentModelSelectionOverrides, {
    "plugin:demo:reviewer": { providerId: "prov-1", modelId: "u2-override" },
  });

  const readBack = await service.getSubagentState();
  assert.deepEqual(readBack, reEnabled);

  // 同源钉死在盘上：读取路径与写入路径必须是封根内的同一份 agents-state.json。
  const onDisk = JSON.parse(await readFile(join(root.configDir, "agents-state.json"), "utf8"));
  assert.deepEqual(onDisk.builtInModelSelectionOverrides, {});
  assert.deepEqual(onDisk.pluginAgentModelSelectionOverrides, {
    "plugin:demo:reviewer": { providerId: "prov-1", modelId: "u2-override" },
  });
  assert.deepEqual(onDisk.disabledAgentIds, []);
});

test("replaceSubagentState 整份替换：远端副本里多出来的项必须消失", async () => {
  await using _root = await sealDataRoot("zcode-subagent-state-replace-");
  const service = createSubagentsService();

  await service.setBuiltInModelOverride({
    agentName: "Explore",
    modelSelection: { providerId: "prov-1", modelId: "stale-model" },
  });
  await service.setPluginAgentModelOverride({
    agentId: "plugin:demo:stale",
    modelSelection: { providerId: "prov-1", modelId: "stale-model" },
  });

  const replaced = await service.replaceSubagentState({
    builtInModelSelectionOverrides: { Explore: { providerId: "prov-1", modelId: "u2-flash" } },
    disabledAgentIds: ["helper"],
    pluginAgentModelSelectionOverrides: {},
  });

  assert.deepEqual(replaced, {
    builtInModelSelectionOverrides: { Explore: { providerId: "prov-1", modelId: "u2-flash" } },
    disabledAgentIds: ["helper"],
    pluginAgentModelSelectionOverrides: {},
  });
  assert.deepEqual(await service.getSubagentState(), replaced);
});
