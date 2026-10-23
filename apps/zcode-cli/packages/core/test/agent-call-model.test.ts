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
 * - 三态：省略时逐字节恒等（零回归）、`null` = 本发显式继承父会话（不需要目录）、字符串 = 钉模型；
 * - 规范形只进 handler → `subagentPort.launch` 的本次 options；
 * - 解析顺序：`modelOverride(turn) > 调用级 > profile > 父模型`，且调用级与 profile 一样要过
 *   `resolveSelection`，失败不回退；
 * - 记录在案的不对称：后台 spawn 不携带调用级**选型**（round 4 有意为之，见 runner.launch 注释）。
 *   显式继承不在其列——它是开关不是选型，两条派发路都带（2026-10-17 补）。
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

function agentInput(model?: string | null): Record<string, unknown> {
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

test("输入契约：model 是可选的三态（字符串 | null），出现在 provider JSON schema 里", () => {
  const properties = (
    AgentInputJsonSchema as { properties?: Record<string, Record<string, unknown>> }
  ).properties;
  // 归一化把 `.nullable()` 的 anyOf 收成 oneOf（json-schema.ts），provider 面看到的就是这两支。
  const oneOf = properties?.model?.oneOf as
    | Array<{ minLength?: number; type?: string }>
    | undefined;
  assert.deepEqual(
    oneOf?.map((branch) => branch.type),
    ["string", "null"],
  );
  assert.equal(oneOf?.[0]?.minLength, 1);
  assert.equal(
    (AgentInputJsonSchema as { required?: string[] }).required?.includes("model") ?? false,
    false,
  );
  // 空字符串是 schema 错误，不是「等于没给」；`null` 是合法入参（本发显式继承）。
  assert.equal(AgentInputSchema.safeParse(agentInput(" ")).success, false);
  assert.equal(AgentInputSchema.safeParse(agentInput(null)).success, true);
});

test("resolveInput：合法 model 归一成规范形（默认档位、大小写、裸 modelId 都归一到注册表拼写）", async () => {
  assert.equal(resolvedInput(await resolveInput(agentInput("zcode/glm-5.3"))).model, "zcode/glm-5.3$high");
  assert.equal(
    resolvedInput(await resolveInput(agentInput("ANTHROPIC/Claude-Haiku$HIGH"))).model,
    "anthropic/claude-haiku$high",
  );
  // 裸名只在会话自己的 provider 下命中（provider 边界，见 resolveModelReference 的第 2 档）。
  assert.equal(resolvedInput(await resolveInput(agentInput("GLM-5.3"))).model, "zcode/glm-5.3$high");
});

test("resolveInput：裸名只挂在别的 provider 下 → 整次调用失败，不悄悄跨账单", async () => {
  const resolution = asFailure(await resolveInput(agentInput("claude-haiku")));
  assert.equal(resolution.errorCode, 400);
  assert.match(resolution.message, /not configured under the session's provider/);
});

test("resolveInput：省略 model 时逐字节恒等（零回归）", async () => {
  const input = agentInput();
  const resolution = await resolveInput(input);
  assert.equal(resolvedInput(resolution), input);
});

test("resolveInput：null 是本发显式继承，逐字节恒等，且不需要模型目录", async () => {
  const input = agentInput(null);
  assert.equal(resolvedInput(await resolveInput(input)), input);
  // 继承不是一个模型引用：宿主没有模型目录（不能选模）时它照样成立。
  assert.equal(resolvedInput(await resolveInput(input, false)), input);
});

test("resolveInput：解不出来的 model 是整次调用的业务失败，不是静默回退", async () => {
  const unknown = asFailure(await resolveInput(agentInput("does-not-exist")));
  assert.equal(unknown.errorCode, 400);
  assert.match(unknown.message, /No configured model matches/);

  const badLevel = asFailure(await resolveInput(agentInput("zcode/glm-5.3$ultra")));
  assert.match(badLevel.message, /not a reasoning level/);
});

test("resolveInput：目录缺席而 model 是字符串 → 明确拒绝；省略或 null 则恒等放行", async () => {
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
  assert.equal("callModelInherit" in calls[0]!.options, false);
});

test("handler：省略 model 时 options 里既没有 callModelSelection 也没有 callModelInherit", async () => {
  const { calls, context } = createContext();
  await agentToolEntry.handler(agentInput(), context);

  assert.equal(calls.length, 1);
  assert.equal("callModelSelection" in calls[0]!.options, false);
  assert.equal("callModelInherit" in calls[0]!.options, false);
});

test("handler：model = null 只送 callModelInherit（继承是开关，不是选型）", async () => {
  const { calls, context } = createContext();
  await agentToolEntry.handler({ ...agentInput(null), wait: true }, context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.options.callModelInherit, true);
  assert.equal("callModelSelection" in calls[0]!.options, false);
  assert.equal("modelOverride" in calls[0]!.options, false);
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
  await agentToolEntry.handler(agentInput(null), context);

  assert.deepEqual(
    calls.map((call) => call.options.callModelSelection),
    [
      { providerId: "zcode", modelId: "glm-5.3", options: { reasoningLevel: "low" } },
      { providerId: "anthropic", modelId: "claude-haiku" },
      undefined,
    ],
  );
  assert.deepEqual(
    calls.map((call) => call.options.callModelInherit),
    [undefined, undefined, true],
  );
  // 第一次的选型没有沉淀成第二次的缺省，继承也没有沉淀成第三次的缺省；turn override 没被写回。
  assert.deepEqual(turnOverride, snapshot);
  assert.deepEqual(calls[0]!.options.modelOverride, snapshot);
  assert.deepEqual(calls[2]!.options.modelOverride, snapshot);
});

test("选型顺序：modelOverride(turn) > 调用级（选型 / 显式继承）> profile > 父模型", () => {
  const profile: ModelSelection = { providerId: "profile-provider", modelId: "profile-model" };
  const parent: ModelSelection = { providerId: "parent-provider", modelId: "parent-model" };
  const call: ModelSelection = { providerId: "call-provider", modelId: "call-model" };
  const turn: ModelSelection = { providerId: "turn-provider", modelId: "turn-model" };

  assert.deepEqual(resolveSubagentSelection({ profileSelection: profile, parentSelection: parent }).selection, profile);
  assert.deepEqual(
    resolveSubagentSelection({ profileSelection: profile, parentSelection: parent, callSelection: call }),
    { hasConcreteModel: true, selection: call },
  );
  // 显式继承跳过 profile：用户说「这一发跟着会话走」时，设置页那个模型必须让位。
  // `hasConcreteModel` 同时为假，调用方才会照常复用父模型实例（含父 turn 的执行模型）。
  assert.deepEqual(
    resolveSubagentSelection({
      profileSelection: profile,
      parentSelection: parent,
      callInherit: true,
    }),
    { hasConcreteModel: false, selection: parent },
  );
  // 跨 provider 的临时执行选型仍是最高优先级，且继承与选型互斥（handler 二选一）。
  assert.deepEqual(
    resolveSubagentSelection({
      profileSelection: profile,
      parentSelection: parent,
      callInherit: true,
      overrideSelection: turn,
    }).selection,
    turn,
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

/**
 * 观察两条派发路实际交给 runtime 的调用级模型字段：前台走 `run`、后台走 `start`，但两者共用
 * 同一个 `runExploreAgent` 回调，所以差别只在 runOptions 里带了什么。
 */
async function observeLaunchModelOptions(
  launches: Array<{ options: Record<string, unknown>; wait?: boolean }>,
): Promise<Array<{ callModelInherit?: true; callModelSelection?: ModelSelection }>> {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-agent-call-model-"));
  const observed: Array<{ callModelInherit?: true; callModelSelection?: ModelSelection }> = [];
  try {
    const port = createExploreSubagentPort({
      outputRootDir,
      runExploreAgent: async (request: ExploreSubagentRuntimeRequest, options) => {
        observed.push({
          callModelSelection: options?.callModelSelection,
          callModelInherit: options?.callModelInherit,
        });
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
      trace: {
        traceId: "trace_test",
        spanId: "span_test",
        sessionId: "sess_parent",
        turnId: "turn_1",
      },
    };
    for (const launch of launches) {
      const handle = await port.launch(
        { ...base, ...(launch.wait ? { wait: true } : {}) } as never,
        launch.options as never,
      );
      await port.waitForTask?.(handle.agentId);
    }
    return observed;
  } finally {
    await rm(outputRootDir, { force: true, recursive: true });
  }
}

test("已记录的不对称：后台 spawn 不携带调用级选型，前台（wait: true）携带", async () => {
  const selection: ModelSelection = { providerId: "zcode", modelId: "glm-5.3" };
  const observed = await observeLaunchModelOptions([
    { options: { callModelSelection: selection } },
    { options: { callModelSelection: selection }, wait: true },
  ]);

  assert.deepEqual(
    observed.map((entry) => entry.callModelSelection),
    [undefined, selection],
  );
  assert.deepEqual(
    observed.map((entry) => entry.callModelInherit),
    [undefined, undefined],
  );
});

test("显式继承不在那个不对称里：后台派发同样携带 callModelInherit", async () => {
  const observed = await observeLaunchModelOptions([
    { options: { callModelInherit: true } },
    { options: { callModelInherit: true }, wait: true },
  ]);

  assert.deepEqual(
    observed.map((entry) => entry.callModelInherit),
    [true, true],
  );
  assert.deepEqual(
    observed.map((entry) => entry.callModelSelection),
    [undefined, undefined],
  );
});
