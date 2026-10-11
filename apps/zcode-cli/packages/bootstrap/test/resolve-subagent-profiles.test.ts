import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { PluginMetadata } from "@zcode/contracts";
import { createAgentStateId, createPluginAgentStateId } from "@zcode/shared";
import { resolveSubagentProfiles } from "../src/subagents.js";

/**
 * 启动装配与设置热重载共用同一条解析路径（spec: core/spec/subagent-settings-sync.md D4）：
 * - 内置覆盖、插件覆盖、用户 agent 启用状态三项都来自同一份 `agents-state.json`；
 * - 每次调用都重读磁盘，因此「改回继承 / 重新启用 / 换个模型」都只需重跑本函数；
 * - 插件 profile 的覆盖键是 `plugin:<pluginId>:<bareName>`，与设置页写入的键同源。
 */

async function withTempRoots(
  run: (roots: { projectDir: string; storageRoot: string; pluginRoot: string }) => Promise<void>,
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), "zcode-resolve-subagents-"));
  const storageRoot = join(base, "data");
  const projectDir = join(base, "project");
  const pluginRoot = join(base, "plugin");
  try {
    await run({ projectDir, pluginRoot, storageRoot });
  } finally {
    await rm(base, { force: true, maxRetries: 5, recursive: true, retryDelay: 50 });
  }
}

function agentMarkdown(name: string, model?: string): string {
  return [
    "---",
    `name: ${name}`,
    `description: ${name} agent`,
    ...(model ? [`model: ${model}`] : []),
    "---",
    `${name} system prompt`,
  ].join("\n");
}

function pluginFixture(pluginRoot: string, agentName: string): PluginMetadata {
  return {
    components: [{ items: [{ name: agentName }], kind: "agent" }],
    enabled: true,
    id: "demo-plugin",
    name: "demo",
    rootPath: pluginRoot,
    source: "marketplace",
  } as unknown as PluginMetadata;
}

test("用同一条路径解析：插件覆盖生效、禁用用户 agent 被过滤、内置覆盖原样返回", async () => {
  await withTempRoots(async ({ projectDir, pluginRoot, storageRoot }) => {
    const pluginAgent = "reviewer";
    const disabledAgent = "old-helper";
    const pluginId = "demo-plugin";
    await mkdir(join(storageRoot, "agents"), { recursive: true });
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await mkdir(join(pluginRoot, "agents"), { recursive: true });
    await writeFile(
      join(storageRoot, "agents", `${disabledAgent}.md`),
      agentMarkdown(disabledAgent),
    );
    await writeFile(join(pluginRoot, "agents", `${pluginAgent}.md`), agentMarkdown(pluginAgent));
    await writeFile(
      join(storageRoot, "v2", "agents-state.json"),
      JSON.stringify({
        builtInModelSelectionOverrides: { Explore: { modelId: "u2-flash", providerId: "prov-1" } },
        pluginAgentModelSelectionOverrides: {
          [createPluginAgentStateId(pluginId, pluginAgent)]: {
            modelId: "u2-override",
            providerId: "prov-1",
          },
        },
        disabledAgentIds: [
          createAgentStateId({ name: disabledAgent, scope: "user", source: "user" }),
        ],
      }),
    );

    const outcome = await resolveSubagentProfiles({
      plugins: [pluginFixture(pluginRoot, pluginAgent)],
      storageRoot,
      workingDirectory: projectDir,
    });

    assert.deepEqual(outcome.builtInModelSelectionOverrides, {
      Explore: { modelId: "u2-flash", providerId: "prov-1" },
    });
    assert.equal(
      outcome.profiles.some((profile) => profile.name === disabledAgent),
      false,
      "禁用集合里的用户 agent 不应进入派发清单",
    );
    const pluginProfile = outcome.profiles.find(
      (profile) => profile.name === `demo:${pluginAgent}`,
    );
    assert.ok(pluginProfile, "插件 agent 应以其命名空间名进入清单");
    assert.deepEqual(pluginProfile.modelSelection, {
      modelId: "u2-override",
      providerId: "prov-1",
    });
  });
});

test("重跑同一函数即读到新的磁盘状态：改回继承 / 重新启用都不需要额外路径", async () => {
  await withTempRoots(async ({ projectDir, pluginRoot, storageRoot }) => {
    const helper = "helper";
    await mkdir(join(storageRoot, "agents"), { recursive: true });
    await mkdir(join(storageRoot, "v2"), { recursive: true });
    await writeFile(join(storageRoot, "agents", `${helper}.md`), agentMarkdown(helper));
    const stateFile = join(storageRoot, "v2", "agents-state.json");
    await writeFile(
      stateFile,
      JSON.stringify({
        builtInModelSelectionOverrides: { Explore: { modelId: "u2-flash", providerId: "prov-1" } },
        disabledAgentIds: [createAgentStateId({ name: helper, scope: "user", source: "user" })],
        pluginAgentModelSelectionOverrides: {},
      }),
    );

    const before = await resolveSubagentProfiles({
      plugins: [],
      storageRoot,
      workingDirectory: projectDir,
    });
    assert.deepEqual(before.builtInModelSelectionOverrides.Explore, {
      modelId: "u2-flash",
      providerId: "prov-1",
    });
    assert.equal(
      before.profiles.some((profile) => profile.name === helper),
      false,
    );

    // 设置页把两项都改回默认后的磁盘状态：缺键 = 继承、id 不在集合里 = 启用。
    await writeFile(stateFile, JSON.stringify({ builtInModelSelectionOverrides: {} }));
    const after = await resolveSubagentProfiles({
      plugins: [],
      storageRoot,
      workingDirectory: projectDir,
    });
    assert.deepEqual(after.builtInModelSelectionOverrides, {});
    assert.equal(
      after.profiles.some((profile) => profile.name === helper),
      true,
    );
    assert.equal(pluginRoot.length > 0, true);
  });
});
