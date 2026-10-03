import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInputSchema } from "@zcode/contracts";
import { createExploreSubagentPort, type ExploreSubagentRuntimeRequest } from "../src/subagent/runner.js";

/**
 * Agent「派发即句柄」的核心契约（spec: core/spec/subagent-session-messaging.md D1 / 行为 1）：
 * - 不传 wait：立即返回 async_launched 句柄（agentId/childSessionId），不等子代理完成；
 * - wait: true：走原前台路径，阻塞到完成并返回 completed 正文；
 * - modelOverride.background === "deny"（闲时轮借用前台模型）禁止后台：默认路径降级为前台并
 *   在结果里如实标注，而不是抛 BACKGROUND_UNAVAILABLE；
 * - 输入契约：run_in_background 已删除（非 strict schema 静默剥离该旧键），wait 为唯一开关。
 *
 * 数据源是 createExploreSubagentPort 的 launch 分叉——它是前台/后台的唯一判据，handler 只透传。
 */

const TRACE = { traceId: "trace_test", spanId: "span_test", sessionId: "sess_parent", turnId: "turn_1" };

const CHILD_RESPONSE = "子代理完成正文";
const DENIED_NOTICE_FRAGMENT = "ran in the foreground";

function createLaunchRequest(wait?: boolean): never {
  const base = {
    sessionId: "sess_parent",
    turnId: "turn_1",
    parentToolCallId: "toolu_launch_1",
    agentType: "general-purpose",
    description: "测试子代理",
    prompt: "回复 OK",
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    trace: TRACE,
  };
  return (wait === undefined ? base : { ...base, wait }) as never;
}

interface Harness {
  outputRootDir: string;
  port: ReturnType<typeof createExploreSubagentPort>;
  /** 释放子代理的模型调用（仅 createGatedHarness 返回）。 */
  releaseChild?: () => void;
}

async function createHarness(options: { gateChild?: boolean } = {}): Promise<Harness> {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-launch-"));
  let releaseChild: (() => void) | undefined;
  const childGate = options.gateChild
    ? new Promise<void>((resolve) => {
        releaseChild = resolve;
      })
    : Promise.resolve();

  const port = createExploreSubagentPort({
    outputRootDir,
    runExploreAgent: async (request: ExploreSubagentRuntimeRequest) => {
      // 真实 runtime 在 persist 之后、首次模型调用之前调用；测试里同样先报 ready 再等 gate。
      await request.onSessionReady?.();
      await childGate;
      return { response: CHILD_RESPONSE, traceId: request.traceContext.traceId, events: [] };
    },
    emitParentEvent: async () => {},
  });

  return { outputRootDir, port, ...(releaseChild ? { releaseChild } : {}) };
}

async function cleanup(harness: Harness, agentId?: string): Promise<void> {
  harness.releaseChild?.();
  if (agentId) {
    // 等后台收尾结束再删输出目录，避免和 finalize 的写文件竞态。
    await harness.port.waitForTask?.(agentId);
  }
  await rm(harness.outputRootDir, { force: true, recursive: true });
}

test("默认不传 wait：立即返回 async_launched 句柄，不等子代理模型调用", async () => {
  const harness = await createHarness({ gateChild: true });
  try {
    const output = await harness.port.launch(createLaunchRequest());

    assert.equal(output.status, "async_launched");
    assert.match(output.agentId, /^agent_/);
    assert.equal(output.childSessionId, `sess_subagent_${output.agentId}`);
    assert.equal(output.backgroundTaskId, output.agentId);
    assert.ok(output.outputFile.length > 0);
    await cleanup(harness, output.agentId);
  } finally {
    await cleanup(harness);
  }
});

test("wait: true：前台阻塞并返回 completed 正文", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.port.launch(createLaunchRequest(true));

    assert.equal(output.status, "completed");
    assert.equal(output.content.map((block) => block.text).join("\n"), CHILD_RESPONSE);
    assert.match(output.agentId, /^agent_/);
  } finally {
    await cleanup(harness);
  }
});

test("闲时轮借用前台模型（deny）：默认路径降级为前台并在结果里标注", async () => {
  const harness = await createHarness();
  try {
    const output = await harness.port.launch(createLaunchRequest(), {
      modelOverride: {
        selection: { modelId: "idle-model", providerId: "idle-provider" },
        background: "deny",
      },
    });

    assert.equal(output.status, "completed");
    assert.match(
      output.content.map((block) => block.text).join("\n"),
      new RegExp(DENIED_NOTICE_FRAGMENT),
    );
  } finally {
    await cleanup(harness);
  }
});

test("闲时轮 + profile 显式后台：保持 BACKGROUND_UNAVAILABLE 硬失败，不改写配置语义", async () => {
  const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-launch-"));
  try {
    const port = createExploreSubagentPort({
      outputRootDir,
      profiles: [
        {
          name: "always-background",
          background: true,
          description: "profile 显式要求后台",
          source: "project",
          systemPrompt: "",
          tools: ["*"],
        },
      ],
      runExploreAgent: async (request: ExploreSubagentRuntimeRequest) => {
        await request.onSessionReady?.();
        return { response: CHILD_RESPONSE, traceId: request.traceContext.traceId, events: [] };
      },
      emitParentEvent: async () => {},
    });

    await assert.rejects(
      port.launch(
        {
          sessionId: "sess_parent",
          parentToolCallId: "toolu_launch_bg",
          agentType: "always-background",
          description: "后台 profile",
          prompt: "回复 OK",
          workingDirectory: "/tmp",
          workspaceRoot: "/tmp",
          trace: TRACE,
        } as never,
        {
          modelOverride: {
            selection: { modelId: "idle-model", providerId: "idle-provider" },
            background: "deny",
          },
        },
      ),
      /Idle-time tasks do not support background agents/,
    );
  } finally {
    await rm(outputRootDir, { force: true, recursive: true });
  }
});

test("输入契约：run_in_background 被剥离，wait 是唯一开关", () => {
  const parsed = AgentInputSchema.parse({
    description: "旧端调用",
    prompt: "回复 OK",
    run_in_background: true,
  });

  assert.deepEqual(parsed, { description: "旧端调用", prompt: "回复 OK" });
  assert.equal(AgentInputSchema.parse({ description: "d", prompt: "p", wait: true }).wait, true);
});
