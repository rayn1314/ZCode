import assert from "node:assert/strict";
import test from "node:test";
import { join, resolve } from "node:path";
import { inferScriptWorkflowScope } from "../src/app/script-workflow-utils.js";

/**
 * 工作流脚本可见范围（契约）：项目级跟仓库走，用户级跟**身份数据根**走。
 *
 * 关键不变式是「用户级不再按 home 判定」——并排安装的两个产品身份各自有独立数据根，
 * 若脚本查找根写死 `{home}/.zcode/workflows`，两个身份会共用同一份用户脚本。
 */

const WORKSPACE = resolve("repo-root");
const OFFICIAL_ROOT = resolve("home", ".zcode");
const SELF_BUILT_ROOT = resolve("home", ".zcode-rayn");

test("项目级：{workspace}/.zcode/workflows 内的脚本归 project", () => {
  const script = join(WORKSPACE, ".zcode", "workflows", "demo.json");
  assert.equal(inferScriptWorkflowScope(script, WORKSPACE, OFFICIAL_ROOT), "project");
});

test("用户级：身份数据根的 workflows 目录归 user（官方与自建各自成立）", () => {
  const official = join(OFFICIAL_ROOT, "workflows", "demo.json");
  const selfBuilt = join(SELF_BUILT_ROOT, "workflows", "demo.json");
  assert.equal(inferScriptWorkflowScope(official, WORKSPACE, OFFICIAL_ROOT), "user");
  assert.equal(inferScriptWorkflowScope(selfBuilt, WORKSPACE, SELF_BUILT_ROOT), "user");
});

test("自建身份不把官方共享的 home 工作流目录认成 user", () => {
  const officialPath = join(OFFICIAL_ROOT, "workflows", "demo.json");
  assert.equal(inferScriptWorkflowScope(officialPath, WORKSPACE, SELF_BUILT_ROOT), "explicit");
});

test("身份数据根之外、也不在项目目录内的脚本归 explicit", () => {
  const script = resolve("tmp", "adhoc.json");
  assert.equal(inferScriptWorkflowScope(script, WORKSPACE, OFFICIAL_ROOT), "explicit");
});
