import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogContext, Logger, SessionEvent, TraceContext } from "@zcode/contracts";
import {
  createExploreSubagentPort,
  type ExploreSubagentRuntimeRequest,
} from "../src/subagent/runner.js";
import type {
  AgentProfile,
  BuiltInSubagentModelSelectionOverrides,
  ModelSelection,
} from "../src/subagent/profile.js";

/**
 * 端口迟绑定契约（spec: core/spec/subagent-settings-sync.md D3）：
 * 子代理配置不得在构造期烘焙——构造期烘焙正是「改完设置、已打开会话仍继承父模型」的机理。
 * 每次派发必须按 getter 当前值现算 profile 清单与内置覆盖；整份替换（含删键改回继承、
 * 插件 profile 换模型、启用状态变化）立即反映到下一发。
 */

const TRACE = {
  traceId: "trace_late_read",
  spanId: "span_late_read",
  sessionId: "sess_parent",
  turnId: "turn_1",
  parentToolCallId: "toolu_late",
};

function createSilentLogger(): Logger {
  const logger: Logger = {
    debug() {},
    error() {},
    info() {},
    warn() {},
    child() {
      return logger;
    },
    childContext(_context: LogContext): Logger {
      return logger;
    },
  };
  return logger;
}

function launchRequest(agentType: string): never {
  return {
    sessionId: "sess_parent",
    turnId: "turn_1",
    parentToolCallId: "toolu_late",
    agentType,
    description: "迟读覆盖测试",
    prompt: "两次派发之间修改配置",
    workingDirectory: "/tmp",
    workspaceRoot: "/tmp",
    trace: TRACE,
  } as never;
}

function pluginProfile(modelSelection: ModelSelection): AgentProfile {
  return {
    description: "plugin reviewer",
    name: "demo:reviewer",
    source: "user",
    systemPrompt: "review",
    ...{ modelSelection },
  };
}

test(
  "构造后修改配置：下一发派发立即用新值；删键回继承、插件 profile 换模型同轮生效",
  { timeout: 30_000 },
  async () => {
    const outputRootDir = await mkdtemp(join(tmpdir(), "zcode-subagent-late-read-"));
    let overrides: BuiltInSubagentModelSelectionOverrides = {};
    let profiles: readonly AgentProfile[] = [];
    const seenSelections: Array<ModelSelection | undefined> = [];
    const seenAgentTypes: string[] = [];

    try {
      const port = createExploreSubagentPort({
        outputRootDir,
        logger: createSilentLogger(),
        // 配置热重载只写 runtime config，端口经 getter 迟读（与 maxConcurrent 同一模式）。
        getProfiles: () => profiles,
        getBuiltInModelSelectionOverrides: () => overrides,
        inactivityTimeoutMs: 0,
        emitParentEvent: async (_event: SessionEvent, _trace: TraceContext) => {},
        runExploreAgent: async (request: ExploreSubagentRuntimeRequest) => {
          seenAgentTypes.push(request.profile.name);
          seenSelections.push(request.profile.modelSelection);
          return { events: [], response: "ok" };
        },
      });

      // ① 无覆盖：built-in profile 不带具体模型（= 继承父会话）。
      await port.start(launchRequest("general-purpose"));

      // ② 热重载（模拟 runtime.updateSubagentsConfig 整份替换）。
      overrides = { "general-purpose": { providerId: "prov-1", modelId: "u2-flash" } };
      await port.start(launchRequest("general-purpose"));

      // ③ 改回继承 = 删键，同样必须反映到下一发。
      overrides = {};
      await port.start(launchRequest("general-purpose"));

      // ④ 插件 profile 与其覆盖：同一补丁里换模型后，下一发即用新值（原来构造期烘焙会一直用旧值）。
      profiles = [pluginProfile({ providerId: "prov-1", modelId: "old-model" })];
      await port.start(launchRequest("demo:reviewer"));
      profiles = [pluginProfile({ providerId: "prov-1", modelId: "new-model" })];
      await port.start(launchRequest("demo:reviewer"));

      assert.equal(seenSelections[0], undefined);
      assert.equal(seenSelections[1]?.providerId, "prov-1");
      assert.equal(seenSelections[1]?.modelId, "u2-flash");
      assert.equal(seenSelections[2], undefined);
      assert.deepEqual(seenAgentTypes.slice(3), ["demo:reviewer", "demo:reviewer"]);
      assert.equal(seenSelections[3]?.modelId, "old-model");
      assert.equal(seenSelections[4]?.modelId, "new-model");
    } finally {
      // start 返回后仍有元数据落盘在跑，套件并行负载下 rm 会抢跑（ENOTEMPTY）；
      // 与 SealedDataRoot 同一重试口径。
      await rm(outputRootDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 50 });
    }
  },
);
