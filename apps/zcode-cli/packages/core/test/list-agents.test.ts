import assert from "node:assert/strict";
import test from "node:test";
import {
  ListAgentsOutputSchema,
  type ListAgentsOutput,
  type SessionId,
  type SubagentRosterEntry,
  type SubagentRosterPort,
} from "@zcode/contracts";
import { InMemoryRuntimeTaskRegistry } from "../src/runtime-task/registry.js";
import { listAgentsToolEntry } from "../src/tool/handlers/list-agents.js";

/**
 * ListAgents 的核心契约：合并本会话的两个数据源——进程内 runtimeTaskRegistry（`source: "live"`，
 * 实时状态、可用 agent_* 寻址）与 SubagentRosterPort 的历史投影（`source: "history"`，只能按
 * childSessionId 寻址）。同 agentId 以注册表为准；历史读取失败只降级并标注，不假装没有历史。
 */

const STARTED_AT = new Date("2026-10-03T08:00:00.000Z");
const COMPLETED_AT = new Date("2026-10-03T08:05:00.000Z");
const PARENT_SESSION_ID = "sess_parent" as SessionId;

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

interface RosterSpy {
  port: SubagentRosterPort;
  calls: Array<{ sessionId: SessionId; signal?: AbortSignal }>;
}

function createRosterSpy(
  result: SubagentRosterEntry[] | Error | ((parentSessionId: SessionId) => SubagentRosterEntry[]),
): RosterSpy {
  const calls: RosterSpy["calls"] = [];
  return {
    calls,
    port: {
      async listByParentSession(parentSessionId, options) {
        calls.push({ sessionId: parentSessionId, signal: options?.signal });
        if (result instanceof Error) throw result;
        return typeof result === "function" ? result(parentSessionId) : result;
      },
    },
  };
}

async function runListAgents(
  registry: InMemoryRuntimeTaskRegistry,
  input: unknown = {},
  options: { roster?: SubagentRosterPort; signal?: AbortSignal } = {},
): Promise<ListAgentsOutput> {
  const output = await listAgentsToolEntry.handler(input, {
    runtimeTaskRegistry: registry,
    sessionId: PARENT_SESSION_ID,
    abortSignal: options.signal ?? new AbortController().signal,
    ...(options.roster ? { subagentRosterPort: options.roster } : {}),
  } as never);
  // 用运行时 schema 校验一次：投影必须满足对外契约。
  return ListAgentsOutputSchema.parse(output);
}

function rosterEntry(
  overrides: Partial<SubagentRosterEntry> & { agentId: string },
): SubagentRosterEntry {
  return {
    childSessionId: `sess_subagent_${overrides.agentId}`,
    agentType: "coder",
    description: `history for ${overrides.agentId}`,
    status: "completed",
    isBackgrounded: false,
    startedAt: STARTED_AT.getTime(),
    ...overrides,
  };
}

test("投影：字段、epoch ms 时间戳、终态带 endedAt、来源为 live", async () => {
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
      source: "live",
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

test("只有注册表（老装配没有 roster）：全为 live，不置 historyUnavailable", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_live_only" });

  const output = await runListAgents(registry);

  assert.deepEqual(
    output.agents.map((agent) => ({ id: agent.agentId, source: agent.source })),
    [{ id: "agent_live_only", source: "live" }],
  );
  // 能力缺席不是「不可读」：不能借用 historyUnavailable 的措辞。
  assert.equal("historyUnavailable" in output, false);
});

test("只有历史（注册表空）：全为 history，带 endedAt", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const spy = createRosterSpy([
    rosterEntry({
      agentId: "agent_hist",
      childSessionId: "sess_subagent_agent_hist",
      agentType: "reviewer",
      status: "failed",
      isBackgrounded: true,
      startedAt: STARTED_AT.getTime(),
      endedAt: COMPLETED_AT.getTime(),
    }),
  ]);

  const output = await runListAgents(registry, {}, { roster: spy.port });

  assert.deepEqual(output.agents, [
    {
      agentId: "agent_hist",
      childSessionId: "sess_subagent_agent_hist",
      agentType: "reviewer",
      description: "history for agent_hist",
      status: "failed",
      isBackgrounded: true,
      startedAt: STARTED_AT.getTime(),
      endedAt: COMPLETED_AT.getTime(),
      source: "history",
    },
  ]);
  assert.equal("historyUnavailable" in output, false);
  assert.equal(spy.calls.length, 1);
  assert.equal(spy.calls[0]?.sessionId, PARENT_SESSION_ID);
});

test("roster 返回空：只有 live，不置 historyUnavailable", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_live" });
  const spy = createRosterSpy([]);

  const output = await runListAgents(registry, {}, { roster: spy.port });

  assert.deepEqual(
    output.agents.map((agent) => agent.source),
    ["live"],
  );
  assert.equal("historyUnavailable" in output, false);
});

test("同 agentId 同时存在：取注册表那条（状态与 isBackgrounded 以 live 为准）", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, {
    agentId: "agent_shared",
    status: "running",
    isBackgrounded: true,
  });
  const spy = createRosterSpy([
    rosterEntry({
      agentId: "agent_shared",
      status: "lost",
      isBackgrounded: false,
      description: "stale history",
      endedAt: COMPLETED_AT.getTime(),
    }),
  ]);

  const output = await runListAgents(registry, {}, { roster: spy.port });

  assert.equal(output.agents.length, 1);
  assert.equal(output.agents[0]?.source, "live");
  assert.equal(output.agents[0]?.status, "running");
  assert.equal(output.agents[0]?.isBackgrounded, true);
  assert.equal(output.agents[0]?.description, "task for agent_shared");
  assert.equal(output.agents[0]?.endedAt, undefined);
});

test("顺序：注册表派发序在前，历史按 startedAt 倒序", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_first" });
  registerLocalAgent(registry, { agentId: "agent_second" });
  const spy = createRosterSpy([
    rosterEntry({ agentId: "agent_old", startedAt: STARTED_AT.getTime() - 1000 }),
    rosterEntry({ agentId: "agent_new", startedAt: COMPLETED_AT.getTime() }),
    rosterEntry({ agentId: "agent_first", startedAt: STARTED_AT.getTime() - 5000 }),
  ]);

  const output = await runListAgents(registry, {}, { roster: spy.port });

  assert.deepEqual(
    output.agents.map((agent) => agent.agentId),
    ["agent_first", "agent_second", "agent_new", "agent_old"],
  );
});

test("roster 抛错：仍返回 live 行 + historyUnavailable: true", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_live" });
  const spy = createRosterSpy(new Error("event store read failed"));

  const output = await runListAgents(registry, {}, { roster: spy.port });

  assert.deepEqual(
    output.agents.map((agent) => agent.agentId),
    ["agent_live"],
  );
  assert.equal(output.historyUnavailable, true);
});

test("过滤：status 与 agent_type 作用于合并后的集合", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_running", agentType: "coder" });
  registerLocalAgent(registry, {
    agentId: "agent_reviewer",
    agentType: "reviewer",
    status: "completed",
    completedAt: COMPLETED_AT,
  });
  const spy = createRosterSpy([
    rosterEntry({ agentId: "agent_hist_running_type", agentType: "coder", status: "lost" }),
    rosterEntry({ agentId: "agent_hist_reviewer", agentType: "reviewer", status: "failed" }),
  ]);

  const running = await runListAgents(registry, { status: "running" }, { roster: spy.port });
  assert.deepEqual(
    running.agents.map((agent) => agent.agentId),
    ["agent_running"],
  );

  const reviewers = await runListAgents(registry, { agent_type: "reviewer" }, { roster: spy.port });
  assert.deepEqual(
    reviewers.agents.map((agent) => agent.agentId),
    ["agent_reviewer", "agent_hist_reviewer"],
  );

  // 历史行只能给出终态或 lost，所以 status:"running" 不会命中历史。
  const both = await runListAgents(
    registry,
    { status: "running", agent_type: "reviewer" },
    { roster: spy.port },
  );
  assert.deepEqual(both.agents, []);
});

test("请求的 abortSignal 透传给 roster", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  const spy = createRosterSpy([]);
  const controller = new AbortController();

  await runListAgents(registry, {}, { roster: spy.port, signal: controller.signal });

  assert.equal(spy.calls[0]?.signal, controller.signal);
});

test("模型面：行带 source，空行与历史不可读都有明确措辞", async () => {
  const registry = new InMemoryRuntimeTaskRegistry();
  registerLocalAgent(registry, { agentId: "agent_one" });

  const output = await runListAgents(registry);
  const content = listAgentsToolEntry.formatModelContent?.(output);

  assert.equal(typeof content, "string");
  assert.match(content as string, /<agents count="1">/);
  assert.match(content as string, /id="agent_one"/);
  assert.match(content as string, /child_session="sess_subagent_agent_one"/);
  assert.match(content as string, /source="live"/);

  const broken = await runListAgents(
    registry,
    {},
    { roster: createRosterSpy(new Error("boom")).port },
  );
  const brokenContent = listAgentsToolEntry.formatModelContent?.(broken) as string;
  assert.match(brokenContent, /history_unavailable="true"/);
  assert.match(brokenContent, /could not be read/);
});
