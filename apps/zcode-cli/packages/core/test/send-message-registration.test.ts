import assert from "node:assert/strict";
import test from "node:test";
import { createToolRegistry, type ToolRegistry } from "../src/tool/registry.js";
import { initializeRuntimeTooling } from "../src/runtime/helpers/runtime-tools.js";

/**
 * SendMessage 注册门（spec: core/spec/subagent-session-messaging.md 行为 4）：
 * 门由「有 subagentPort.sendMessage」放宽为「有 subagentPort.sendMessage 或 sessionMessagePort」，
 * 于是子代理 runtime 也能装上 SendMessage 发 `sess_*`；Agent/Task 的门保持不变，子代理仍不能套娃。
 *
 * 测的是真实装配入口 initializeRuntimeTooling，而不是重写一份判据；让 runtime/deps 只保留注册
 * 真正读取的字段，其余以 never 兜住。
 */

const FAKE_EXECUTOR = { execute: async () => ({}) };

function createRuntime(taskType: "main" | "subagent_child"): {
  config: Record<string, unknown>;
  registry: ToolRegistry;
} {
  return {
    config: { taskType, toolset: "main" },
    registry: createToolRegistry(),
  };
}

function install(
  runtime: ReturnType<typeof createRuntime>,
  deps: Record<string, unknown>,
): ToolRegistry {
  initializeRuntimeTooling(
    runtime as never,
    { toolExecutor: FAKE_EXECUTOR, ...deps } as never,
    "sess_under_test",
  );
  return runtime.registry;
}

const SESSION_MESSAGE_PORT = { deliver: async () => ({}) };

test("子代理 runtime：有 sessionMessagePort 即注册 SendMessage，但没有 Agent/Task", () => {
  const registry = install(createRuntime("subagent_child"), {
    sessionMessagePort: SESSION_MESSAGE_PORT,
  });

  assert.equal(registry.has("SendMessage"), true);
  assert.equal(registry.has("Agent"), false);
  assert.equal(registry.has("Task"), false);
  assert.equal(registry.has("ListAgents"), false);
});

test("无任何投递端口：SendMessage 不注册", () => {
  const registry = install(createRuntime("main"), {});

  assert.equal(registry.has("SendMessage"), false);
});

test("子代理端口在场（含 sendMessage）：SendMessage 与 Agent 同门注册", () => {
  const runtime = createRuntime("main");
  (runtime as { subagentPort?: unknown }).subagentPort = { sendMessage: async () => ({}) };

  const registry = install(runtime, {});

  assert.equal(registry.has("SendMessage"), true);
  assert.equal(registry.has("Agent"), true);
});
