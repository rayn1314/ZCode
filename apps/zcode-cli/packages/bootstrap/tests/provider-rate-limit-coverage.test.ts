import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSqliteSessionStore } from "@zcode/adapters/storage";
import {
  ApiKeyAccessConfig,
  ModelConfig,
  ModelOptionSpecsConfig,
  ModelPropertiesConfig,
  ProviderApiConfig,
  ProviderConfig,
  ProviderRegistry,
} from "@zcode/provider";
import {
  getCurrentModelInvocationContext,
  type Model,
  type ModelRequestAdmission,
} from "@zcode/contracts";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

/**
 * 每分钟请求数的覆盖面：`Workflow` 工具（legacy script workflow）与 expert workflow facade 的子
 * runtime 都不进进程级并发治理，但发的是**同一个 provider 账号**的请求，必须与主代理共享配额。
 *
 * 断言缝是模型句柄上的**调用上下文**：`createRuntimeModel` 把 runtime 的准入端口绑在句柄工厂上
 * （`core/runtime/methods/runtime-model.ts` 的 `withRuntimeInvocationLayer`），所以模型在
 * `generateText` 里读 `getCurrentModelInvocationContext()?.modelRequestAdmission` 拿到的正是
 * runner 每次尝试前 `admitAttempt` 要读的那一份。
 */

const PROVIDER_ID = "provider-a";
const MODEL_ID = "model-a";
const TEST_CRED = "test-credential-placeholder";

function providerRegistry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      providerId: PROVIDER_ID,
      config: new ProviderConfig({
        label: "rate limit coverage",
        access: new ApiKeyAccessConfig({ apiKey: TEST_CRED }),
        api: new ProviderApiConfig({
          type: "anthropic-messages",
          baseUrl: "https://rate-limit.example.com",
        }),
        builtinModelIds: [MODEL_ID],
        personalModelIds: [],
        enabled: true,
        visibility: "visible",
      }),
      models: [{ modelId: MODEL_ID, config: modelConfig() }],
    },
  ]);
}

function modelConfig(): ModelConfig {
  return new ModelConfig({
    enabled: true,
    visibility: "visible",
    properties: new ModelPropertiesConfig({
      requiresMfjsToolSchema: false,
      contextWindow: 200_000,
      inputFormat: {
        supportsText: true,
        supportsImage: false,
        supportsVideo: false,
        supportsAudio: false,
        supportsPdf: false,
      },
      outputFormat: { supportsText: true },
      supportsToolCall: true,
      supportsJsonSchemaOutput: true,
      supportsNativeWebSearch: false,
      supportsMidConversationSystem: false,
    }),
    optionSpecs: new ModelOptionSpecsConfig({
      reasoningLevel: { values: ["disabled"], map: "{}" },
      maxOutputTokens: { max: 32_000, map: '{"max_completion_tokens":maxOutputTokens}' },
    }),
  });
}

const MODEL_SELECTION = {
  providerId: PROVIDER_ID,
  modelId: MODEL_ID,
  options: { reasoningLevel: "disabled" as const },
};

/** 每次模型调用都记下当时句柄上绑的准入端口。 */
function recordingModel(options: {
  text: string;
  seen: (ModelRequestAdmission | undefined)[];
}): Model {
  return {
    providerId: PROVIDER_ID as Model["providerId"],
    modelId: MODEL_ID as Model["modelId"],
    properties: modelConfig().properties,
    optionSpecs: modelConfig().optionSpecs,
    options: { maxOutputTokens: 8_000, reasoningLevel: "disabled" },
    bind() {
      return this;
    },
    async generateText() {
      options.seen.push(getCurrentModelInvocationContext()?.modelRequestAdmission);
      return {
        finishReason: "stop",
        text: options.text,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      };
    },
    streamText() {
      throw new Error("not used");
    },
  };
}

function recordingModelAdapter(options: {
  text: string;
  seen: (ModelRequestAdmission | undefined)[];
}): never {
  return {
    addStatusSink() {},
    createModel: () => recordingModel(options),
    setModelIoFullRetentionEnabled() {},
  } as never;
}

/** 受限路径的共同形状：限速层在场，且**没有**并发闸门（`tryAcquire` 缺席）。 */
function expectQuotaOnlyAdmission(seen: readonly (ModelRequestAdmission | undefined)[]): void {
  expect(seen.length).toBeGreaterThan(0);
  for (const admission of seen) {
    expect(admission).toBeDefined();
    expect(admission?.tryAcquire).toBeUndefined();
    expect(admission?.awaitRateLimit).toBeTypeOf("function");
  }
}

describe("每分钟请求数的覆盖面", () => {
  it("legacy Workflow 工具的子代理带上 provider 配额端口", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "zcode-rate-limit-script-"));
    const scriptPath = join(tempRoot, "coverage.workflow.js");
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const seen: (ModelRequestAdmission | undefined)[] = [];
    await writeFile(
      scriptPath,
      `
        export const meta = {
          name: "rate-limit-coverage",
          description: "Verify the script workflow child carries the provider quota port",
          phases: [{ title: "Run" }],
        };

        phase("Run");
        return await agent("Say done.", {
          schema: {
            type: "object",
            properties: { done: { type: "boolean" } },
            required: ["done"],
          },
        });
      `,
      "utf8",
    );

    try {
      const app = await createRegistryBackedTestApp({
        env: {},
        modelAdapter: recordingModelAdapter({ seen, text: '```json\n{"done":true}\n```' }),
        providerRegistry: providerRegistry(),
        runtimeConfig: {
          mcp: { enabled: false },
          modelSelection: MODEL_SELECTION,
          workingDirectory: tempRoot,
        },
        sessionStore,
        skipUserConfig: true,
      });

      const result = await app.runWorkflowScript?.({ scriptPath });
      expect(result?.status).toBe("completed");
      expectQuotaOnlyAdmission(seen);
      await app.close?.();
    } finally {
      sessionStore.close();
      await rm(tempRoot, { force: true, recursive: true });
    }
  }, 30_000);

  it("expert workflow facade 的子 runtime 带上 provider 配额端口", async () => {
    const sessionStore = await createSqliteSessionStore({ dbPath: ":memory:" });
    const seen: (ModelRequestAdmission | undefined)[] = [];

    try {
      const app = await createRegistryBackedTestApp({
        env: {},
        modelAdapter: recordingModelAdapter({
          seen,
          text: JSON.stringify({ reasoning: "ok", verdict: "pass" }),
        }),
        providerRegistry: providerRegistry(),
        runtimeConfig: {
          mcp: { enabled: false },
          modelSelection: MODEL_SELECTION,
          workingDirectory: process.cwd(),
        },
        sessionStore,
        skipUserConfig: true,
      });

      const result = await app.runExpertWorkflow({ task: "verify quota coverage" });
      expect(["completed", "paused"]).toContain(result.status);
      expectQuotaOnlyAdmission(seen);
      await app.close?.();
    } finally {
      sessionStore.close();
    }
  }, 30_000);
});
