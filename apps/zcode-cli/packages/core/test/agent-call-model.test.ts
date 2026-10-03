import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentInputJsonSchema,
  AgentInputSchema,
  type ModelCatalogEntry,
  type ModelSelection,
  type SubagentPort,
} from "@zcode/contracts";
import { agentToolEntry } from "../src/tool/handlers/agent.js";
import { resolveSubagentSelection } from "../src/runtime/helpers/subagent-selection.js";
import { createExploreSubagentPort, type ExploreSubagentRuntimeRequest } from "../src/subagent/runner.js";
import type { ToolHandlerFailure, ToolInputResolutionResult } from "../src/tool/types.js";

/**
 * Agent 调用级 `model` 的核心契约（spec: core/spec/subagent-session-messaging.md D6 / 阶段 4）：
 * - `resolveInput` 用宿主模型目录解析成规范形（`providerId/modelId[$level]`），解不开即整次调用
 *   业务失败；目录缺席而字段在场同样明确拒绝；
 * - 省略时逐字节恒等（零回归）；
 * - 规范形只进 handler → `subagentPort.launch` 的本次 options；
 * - 解析顺序：`modelOverride(turn) > callModelSelection(调用级) > profile > 父模型`，且调用级与
 *   profile 一样要过 `resolveSelection`，失败不回退；
 * - 记录在案的不对称：后台 spawn 不携带调用级选型（round 4 有意为之，见 runner.launch 注释）。
 */

const CATALOG: ModelCatalogEntry[] = [
  {
    providerId: "zcode",
    modelId: "glm-5.3",
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "high",
    current: true,
  },
  {
    providerId: "anthropic",
    modelId: "claude-haiku",
    reasoningLevels: ["low", "high"],
    defaultReasoningLevel: "low",
    current: false,
  },
];

const CATALOG_PORT = { listModels: (): ModelCatalogEntry[] => CATALOG };

function resolveInput(input: unknown, withCatalog = true): Promise<ToolInputResolutionResult> {
  return Promise.resolve(
    agentToolEntry.resolveInput!(input, (withCatalog ? { modelCatalogPort: CATALOG_PORT } : {}) as never),
  );
}

function asFailure(resolution: ToolInputResolutionResult): ToolHandlerFailure {
  assert.equal(resolution.result, false, `expected a failure, got ${JSON.stringify(resolution)}`);
  return resolution as ToolHandlerFailure;
}

function resolvedInput(resolution: ToolInputResolutionResult): Record<string, unknown> {
  assert.equal(resolution.result, true);
  return (resolution as { result: true; input: unknown }).input as Record<string, unknown>;
}

function agentInput(model?: string): Record<string, unknown> {
  return { description: "委派测试", prompt: "回复 OK", ...(model === undefined ? {} : { model }) };
}

interface LaunchCall {
  options: Record<string, unknown>;
  request: Record<string, unknown>;
}

function createContext(overrides: Record<string, unknown> = {}): { context: never; calls: LaunchCall[] } {
  const calls: LaunchCall[] = [];
  const port: SubagentPort = {
    async launch(request, options): Promise<never> {
      calls.push({
        options: (options ?? {}) as Record<string, unknown>,
        request: request as unknown as Record<string, unknown>,
      });
      return { status: "completed" } as never;
    },
    async run(): Promise<never> {
      throw new Error("run must not be used by the handler");
    },
  };
  const context = {
    toolCallId: "toolu_agent_model",
    sessionId: "sess_parent",
    turnId: "turn_1",
    traceId: "trace_agent_model",
    spanId: "span_agent_model",
    abortSignal: new AbortController().signal,
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    subagentPort: port,
    ...overrides,
  } as never;
  return { calls, context };
}

test("输入契约：model 是可选字符串，出现在 provider JSON schema 里", () => {
  const properties = (AgentInputJsonSchema as { properties?: Record<string, { type?: string }> })
    .properties;
  assert.equal(properties?.model?.type, "string");
  assert.equal(
    (AgentInputJsonSchema as { required?: string[] }).required?.includes("model") ?? false,
    false,
  );
  // 空字符串是 schema 错误，不是「等于没给」。
  assert.equal(AgentInputSchema.safeParse(agentInput(" ")).success, false);
});

test("resolveInput：合法 model 归一成规范形（默认档位、大小写、裸 modelId 都归一到注册表拼写）", async () => {
  assert.equal(resolvedInput(await resolveInput(agentInput("zcode/glm-5.3"))).model, "zcode/glm-5.3$high");
  assert.equal(
    resolvedInput(await resolveInput(agentInput("ANTHROPIC/Claude-Haiku$HIGH"))).model,
    "anthropic/claude-haiku$high",
  );
  assert.equal(
    resolvedInput(await resolveInput(agentInput("claude-haiku"))).model,
    "anthropic/claude-haiku$low",
  );
});

test("resolveInput：省略 model 时逐字节恒等（零回归）", async () => {
  const input = agentInput();
  const resolution = await resolveInput(input);
  assert.equal(resolvedInput(resolution), input);
});

test("resolveInput：解不出来的 model 是整次调用的业务失败，不是静默回退", async () => {
  const unknown = asFailure(await resolveInput(agentInput("does-not-exist")));
  assert.equal(unknown.errorCode, 400);
  assert.match(unknown.message, /No configured model matches/);

  const badLevel = asFailure(await resolveInput(agentInput("zcode/glm-5.3$ultra")));
  assert.match(badLevel.message, /not a reasoning level/);
});

test("resolveInput：目录缺席而 model 在场 → 明确拒绝；省略则恒等放行", async () => {
  const rejected = asFailure(await resolveInput(agentInput("zcode/glm-5.3"), false));
  assert.equal(rejected.errorCode, 400);
  assert.match(rejected.message, /omit `model`/);

  const input = agentInput();
  assert.equal(resolvedInput(await resolveInput(input, false)), input);
});

test("handler：规范形 model 进 launch 的本次 options（随 wait 一起透传）", async () => {
  const { calls, context } = createContext();
  await agentToolEntry.handler(
    { ...agentInput("anthropic/claude-haiku$high"), wait: true },
    context,
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0]!.options.callModelSelection, {
    providerId: "anthropic",
    modelId: "claude-haiku",
    options: { reasoningLevel: "high" },
  });
  assert.equal(calls[0]!.request.wait, true);
  // 调用级选型不是后台请求，也不允许冒充 turn override。
  assert.equal("modelOverride" in calls[0]!.options, false);
});

test("handler：省略 model 时 options 里没有 callModelSelection 键", async () => {
  const { calls, context } = createContext();
  await agentToolEntry.handler(agentInput(), context);

  assert.equal(calls.length, 1);
  assert.equal("callModelSelection" in calls[0]!.options, false);
});

test("handler：调用级选型只活这一次——两次调用各带各的，turn override 与配置不被改写", async () => {
  const turnOverride = {
    selection: { providerId: "idle", modelId: "idle-model" } as ModelSelection,
    background: "deny" as const,
  };
  const snapshot = JSON.parse(JSON.stringify(turnOverride));
  const { calls, context } = createContext({ subagentModelOverride: turnOverride });

  await agentToolEntry.handler(agentInput("zcode/glm-5.3$low"), context);
  await agentToolEntry.handler(agentInput("anthropic/claude-haiku"), context);

  assert.deepEqual(
    calls.map((call) => call.options.callModelSelection),
    [
      { providerId: "zcode", modelId: "glm-5.3", options: { reasoningLevel: "low" } },
      { providerId: "anthropic", modelId: "claude-haiku" },
    ],
  );
  // 第一次的选型没有沉淀成第二次的缺省，也没有写回 turn override。
  assert.deepEqual(turnOverride, snapshot);
  assert.deepEqual(calls[0]!.options.modelOverride, snapshot);
  assert.deepEqual(calls[1]!.options.modelOverride, snapshot);
});

test("选型顺序：modelOverride(turn) > 调用级 > profile > 父模型", () => {
  const profile: ModelSelection = { providerId: "profile-provider", modelId: "profile-model" };
  const parent: ModelSelection = { providerId: "parent-provider", modelId: "parent-model" };
  const call: ModelSelection = { providerId: "call-provider", modelId: "call-model" };
  const turn: ModelSelection = { providerId: "turn-provider", modelId: "turn-model" };

  assert.deepEqual(resolveSubagentSelection({ profileSelection: profile, parentSelection: parent }).selection, profile);
  assert.deepEqual(
    resolveSubagentSelection({ profileSelection: profile, parentSelection: parent, callSelection: call }),
    { hasConcreteModel: true, selection: call },
  );
  assert.deepEqual(
    resolveSubagentSelection({
      profileSelection: profile,
      parentSelection: parent,
      callSelection: call,
      overrideSelection: turn,
    }).selection,
    turn,
  );
});

test("调用级选型与 profile 同一条纪律：过 resolveSelection，解不开不回退", () => {
  const call: ModelSelection = { providerId: "zcode", modelId: "glm-5.3" };
  const resolved: ModelSelection = { providerId: "zcode-account", modelId: "glm-5.3" };

  assert.deepEqual(
    resolveSubagentSelection({
      parentSelection: { providerId: "p", modelId: "m" },
      callSelection: call,
      resolveSelection: () => ({ effectiveSelection: resolved }),
    }).selection,
    resolved,
  );

  assert.throws(
    () =>
      resolveSubagentSelection({
        parentSelection: { providerId: "p", modelId: "m" },
        callSelection: call,
        resolveSelection: () => ({
          effectiveSelection: null,
          selectionIssue: "account-connection-unavailable",
        }),
      }),
    /Cannot start subagent: Account connection unavailable[\s\S]*selection=zcode\/glm-5\.3/,
  );
});

test("已记录的不对称：后台 spawn 不携带调用级选型，前台（wait: true）携带", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-agent-call-model-"));
  const observed: (ModelSelection | undefined)[] = [];
  try {
    const port = createExploreSubagentPort({
      outputRootDir,
      runExploreAgent: async (request: ExploreSubagentRuntimeRequest, options) => {
        observed.push(options?.callModelSelection);
        await request.onSessionReady?.();
        return { response: "OK", traceId: request.traceContext.traceId, events: [] };
      },
      emitParentEvent: async () => {},
    });
    const base = {
      sessionId: "sess_parent",
      turnId: "turn_1",
      parentToolCallId: "toolu_launch_model",
      agentType: "general-purpose",
      description: "测试子代理",
      prompt: "回复 OK",
      workingDirectory: "/tmp",
      workspaceRoot: "/tmp",
      trace: { traceId: "trace_test", spanId: "span_test", sessionId: "sess_parent", turnId: "turn_1" },
    };
    const selection: ModelSelection = { providerId: "zcode", modelId: "glm-5.3" };

    const background = await port.launch(base as never, { callModelSelection: selection });
    await port.waitForTask?.(background.agentId);
    await port.launch({ ...base, wait: true } as never, { callModelSelection: selection });

    assert.deepEqual(observed, [undefined, selection]);
  } finally {
    await rm(outputRootDir, { force: true, recursive: true });
  }
});
