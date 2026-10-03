import assert from "node:assert/strict";
import test from "node:test";
import { ListAgentsOutputSchema, type ListAgentsOutput } from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { listAgentsToolEntry } from "../src/tool/handlers/list-agents.js";

/**
 * ListAgents 的核心契约：只读本会话 runtimeTaskRegistry 的 `local_agent` 任务，投影出
 * agentId / childSessionId / agentType / description / status / isBackgrounded / startedAt
 * （终态附 endedAt）；status 与 agent_type 过滤生效；空注册表回空列表而不是报错。
 */

const STARTED_AT = new Date("2026-10-03T08:00:00.000Z");
const COMPLETED_AT = new Date("2026-10-03T08:05:00.000Z");

function registerLocalAgent(
  registry: InMemoryRuntimeTaskRegistry,
  overrides: {
    agentId: string;
    agentType?: string;
    status?: "running" | "completed";
    childSessionId?: string;
    completedAt?: Date;
    isBackgrounded?: boolean;
  },
): void {
  registry.register({
    taskId: overrides.agentId,
    agentId: overrides.agentId,
    agentType: overrides.agentType ?? "coder",
    childSessionId: overrides.childSessionId ?? `sess_subagent_${overrides.agentId}`,
    description: `task for ${overrides.agentId}`,
    isBackgrounded: overrides.isBackgrounded === true,
    startedAt: STARTED_AT,
    status: overrides.status ?? "running",
    taskType: "local_agent",
    type: "local_agent",
    ...(overrides.completedAt === undefined ? {} : { completedAt: overrides.completedAt }),
  });
}

async function runListAgents(
  registry: InMemoryRuntimeTaskRegistry,
  input: unknown = {},
): Promise<ListAgentsOutput> {
  const output = await listAgentsToolEntry.handler(input, {
    runtimeTaskRegistry: registry,
    sessionId: "sess_parent",
  } as never);
  // 用运行时 schema 校验一次：投影必须满足对外契约。
  return ListAgentsOutputSchema.parse(output);
}

test("投影：字段、epoch ms 时间戳、终态带 endedAt", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, {
    agentId: "agent_done",
    agentType: "coder",
    status: "completed",
    completedAt: COMPLETED_AT,
    isBackgrounded: true,
  });

  const output = await runListAgents(registry);

  assert.deepEqual(output.agents, [
    {
      agentId: "agent_done",
      childSessionId: "sess_subagent_agent_done",
      agentType: "coder",
      description: "task for agent_done",
      status: "completed",
      isBackgrounded: true,
      startedAt: STARTED_AT.getTime(),
      endedAt: COMPLETED_AT.getTime(),
    },
  ]);
});

test("只列 local_agent：bash/workflow 任务被排除", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_kept" });
  registry.register({
    taskId: "bash_1",
    agentId: "bash_1",
    agentType: "bash",
    description: "background bash",
    startedAt: STARTED_AT,
    status: "running",
    type: "local_bash",
  } as Parameters<InMemoryRuntimeTaskRegistry["register"]>[0]);

  const output = await runListAgents(registry);

  assert.deepEqual(
    output.agents.map((agent) => agent.agentId),
    ["agent_kept"],
  );
});

test("过滤：status 与 agent_type 生效", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_running", agentType: "coder" });
  registerLocalAgent(registry, {
    agentId: "agent_reviewer",
    agentType: "reviewer",
    status: "completed",
    completedAt: COMPLETED_AT,
  });

  const running = await runListAgents(registry, { status: "running" });
  assert.deepEqual(
    running.agents.map((agent) => agent.agentId),
    ["agent_running"],
  );

  const reviewers = await runListAgents(registry, { agent_type: "reviewer" });
  assert.deepEqual(
    reviewers.agents.map((agent) => agent.agentId),
    ["agent_reviewer"],
  );

  const both = await runListAgents(registry, { status: "running", agent_type: "reviewer" });
  assert.deepEqual(both.agents, []);
});

test("空注册表：返回空列表而不是失败", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();

  const output = await runListAgents(registry);

  assert.deepEqual(output, { agents: [] });
});

test("模型面：空的与带行的投影都是可读容器", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_one" });

  const output = await runListAgents(registry);
  const content = listAgentsToolEntry.formatModelContent?.(output);

  assert.equal(typeof content, "string");
  assert.match(content as string, /<agents count="1">/);
  assert.match(content as string, /id="agent_one"/);
  assert.match(content as string, /child_session="sess_subagent_agent_one"/);
});
