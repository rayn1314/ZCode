import * as executionAdapters from "@zcode/adapters/exec";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import type { ModelRequest } from "@zcode/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createRegistryBackedTestApp,
  createTestProviderRegistry,
} from "./helpers/registry-backed-test-app.js";

// 本 fork 的决定：workflow child（legacy/expert 两条路径）显式关闭子代理派发
// （`subagents: { enabled: false }`，见 core/spec/subagent-session-as-first-class.md 第 24 条）。
// Agent 工具与构造移交端口由同一个门控，所以这个 runtime 里模型即使点名 Agent 也只会拿到
// `No such tool available`。
//
// 上游同名用例断言「workflow child 里调 Agent 会按 profile 的模型解析并执行」，那与上述不变式
// 相反。放开不是本 merge 能顺手做的事：该 runtime 不走会话构造入口、在 `context.sessions` 里
// 也没有 record，补上端口只会让孙会话的 `parentSessionId` 指向一条查不到的会话。
// 因此这里钉住本 fork 的实际契约：工具面没有 Agent，模型解析端口不被触达。
describe("Workflow child 的子代理能力面", () => {
  it.each(["yolo", "guarded"] as const)(
    "%s 的真实 Workflow child 不注册 Agent 工具，也不解析子代理模型",
    async (mode) => {
      const root = await mkdtemp(join(tmpdir(), "zcode-workflow-selection-"));
      const store = await createSqliteSessionStore({ dbPath: ":memory:" });
      const parent = {
        providerId: "parent",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      const original = {
        providerId: "old-account",
        modelId: "model",
        options: { reasoningLevel: "high" },
      };
      const effective = { ...original, providerId: "new-account" };
      const resolve = vi.fn(() => ({ effectiveSelection: effective }));
      const executed: string[] = [];
      const requests: ModelRequest[] = [];
      let requestedChild = false;
      const execution = vi.spyOn(executionAdapters, "createNodeExecutionAdapter");
      const app = await createRegistryBackedTestApp({
        env: { ZCODE_HOME: root },
        skipUserConfig: true,
        sessionStore: store,
        providerRegistry: createTestProviderRegistry([parent, effective]),
        resolveEffectiveModelSelection: resolve,
        runtimeConfig: {
          mode,
          workingDirectory: root,
          mcp: { enabled: false },
          modelSelection: parent,
          subagents: {
            profiles: [
              {
                name: "researcher",
                description: "Research",
                source: "user",
                tools: ["Read"],
                systemPrompt: "Return a result.",
                modelSelection: original,
              },
            ],
          },
        },
        modelExecutor: {
          async generateText(request, execution) {
            requests.push(request);
            executed.push(execution.providerId);
            const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
            if (!requestedChild) {
              requestedChild = true;
              return {
                finishReason: "tool-calls",
                text: "",
                usage,
                toolCalls: [
                  {
                    id: "workflow-research",
                    name: "Agent",
                    input: {
                      description: "Research",
                      prompt: "Research",
                      subagent_type: "researcher",
                    },
                  },
                ],
              };
            }
            return {
              finishReason: "stop",
              text: JSON.stringify({ reasoning: "ok", verdict: "pass" }),
              usage,
            };
          },
        },
      });
      try {
        await app.runExpertWorkflow({ task: "Research with the researcher." });
        // 模型主动点了 Agent，工具面里却没有它——这正是「Agent 与构造移交端口同生共死」的
        // 外在表现；父会话的这个工具仍在（见 create-app.ts 的装配路径）。
        expect((requests[0]?.tools ?? []).map((tool) => tool.name)).not.toContain("Agent");
        // 没有派发，子代理 profile 的模型选择就不该被解析，也不该有子会话执行记录。
        expect(resolve).not.toHaveBeenCalled();
        expect(executed).not.toContain("new-account");
        expect(executed).not.toContain("old-account");
        expect(new Set(executed)).toEqual(new Set(["parent"]));
        // 上游本轮新增的覆盖面照旧：父 runtime 与 workflow child 各自的执行适配器都拿到了
        // `bashOutputTempDir`（此前只有生产装配传了它，测试基座与子 runtime 一处都不传）。
        expect(execution.mock.calls.length).toBeGreaterThanOrEqual(2);
        for (const [options] of execution.mock.calls) {
          expect(options?.bashOutputTempDir).toBe(tmpdir());
        }
        expect(original.providerId).toBe("old-account");
        expect(app.runtime.getSessionModelSelection()).toEqual(parent);
        expect(app.runtime.getMode()).toBe(mode);
      } finally {
        execution.mockRestore();
        await app.close?.();
        store.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
