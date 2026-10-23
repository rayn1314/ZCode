import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { createAgentStateId, type SubagentRuntimeConfig } from "@zcode/shared";
import type { SubagentChildLaunchBundle, SubagentChildSessionHost } from "@zcode/core";
import { createNodeLoggerFactory } from "@zcode/adapters/logging";
import { parseRuntimeSubagentConfig } from "../src/runtime-subagents/index.js";
import * as subagents from "../src/subagents.js";
import { createRegistryBackedTestApp } from "./helpers/registry-backed-test-app.js";

describe("runtime subagent source parsing", () => {
  it("preserves complete profiles, strips project permission and applies disabled user ids", () => {
    const parsed = parseRuntimeSubagentConfig({
      documents: [
        {
          path: "/project/.zcode/agents/reviewer.md",
          source: "project",
          content:
            "---\nname: reviewer\ndescription: Review\npermissionMode: bypassPermissions\nmodel: custom:provider:model\nthoughtLevel: high\ntools: Read, Grep\n---\nNEW_PROMPT",
        },
      ],
      state: {
        disabledAgentIds: [],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      },
    });
    expect(parsed.profiles[0]).toMatchObject({
      name: "reviewer",
      systemPrompt: "NEW_PROMPT",
      tools: ["Read", "Grep"],
      modelSelection: {
        providerId: "provider",
        modelId: "model",
        options: { reasoningLevel: "high" },
      },
    });
    expect(parsed.profiles[0]?.permissionMode).toBeUndefined();
    const disabled = createAgentStateId({ name: "reviewer", scope: "user", source: "user" });
    const deleted = parseRuntimeSubagentConfig({
      documents: [
        {
          path: "/user/reviewer.md",
          source: "user",
          content: "---\nname: reviewer\ndescription: Review\n---\nPrompt",
        },
      ],
      state: {
        disabledAgentIds: [disabled],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      },
    });
    expect(deleted.profiles).toEqual([]);
  });
});

describe("subagent initialization source", () => {
  it.each(["host", "files"] as const)(
    "initializes from %s and preserves other storage settings",
    async (source) => {
      const root = await mkdtemp(join(tmpdir(), "subagent-initial-source-"));
      const workspace = join(root, "workspace"),
        storage = join(root, "cli-storage");
      const configPath = join(root, "config.json");
      const logDir = join(root, "logs");
      const invalidDocument = {
        path: join(workspace, ".zcode", "agents", "invalid.md"),
        source: "project" as const,
        content: "This document intentionally lacks frontmatter",
      };
      const readDiagnostics = async () =>
        (
          await Promise.all(
            (await readdir(logDir)).map((name) => readFile(join(logDir, name), "utf8")),
          )
        )
          .flatMap((text) =>
            text
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
          )
          .filter((entry) => entry.message === "Agent profile diagnostic");
      const expectedDiagnostic = {
        level: "warn",
        module: "bootstrap.subagents",
        context: {
          code: "agent_missing_frontmatter",
          path: invalidDocument.path,
          message: `Agent Markdown must include frontmatter: ${invalidDocument.path}`,
        },
      };
      const markdown = (prompt: string) =>
        `---\nname: reviewer\ndescription: Review\ntools: Read\n---\n${prompt}`;
      const hostConfig = (prompt: string): SubagentRuntimeConfig => ({
        kind: "ready",
        profiles: [
          {
            path: join(root, "host-agents", "reviewer.md"),
            source: "user",
            name: "reviewer",
            description: "Review",
            tools: ["Read"],
            systemPrompt: prompt,
          },
        ],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      });
      const initial = Promise.withResolvers<SubagentRuntimeConfig>();
      const readHost = vi.fn(async () => initial.promise);
      // 本用例只验证「子代理定义来自哪个来源」，不跑真实子会话：构造入口记录派发入参后
      // 直接失败，Agent 工具把这个失败当作工具结果回给父轮。
      const launched: SubagentChildLaunchBundle[] = [];
      const childHost: SubagentChildSessionHost = {
        async createChildSession(bundle) {
          launched.push(bundle);
          throw new Error("child runtime is not constructed in this test");
        },
      };
      const pluginLoader = vi.spyOn(subagents, "loadPluginAgentTemplates");
      let parentCalls = 0;
      let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
      let creating: ReturnType<typeof createRegistryBackedTestApp> | undefined;
      try {
        await mkdir(join(storage, "agents"), { recursive: true });
        await mkdir(join(workspace, ".zcode", "agents"), { recursive: true });
        if (source === "files") await writeFile(invalidDocument.path, invalidDocument.content);
        await writeFile(
          configPath,
          JSON.stringify({ storage: { dir: join(root, "unused-storage") } }),
        );
        await writeFile(join(storage, "agents", "reviewer.md"), markdown("DISK_PROFILE"));
        creating = createRegistryBackedTestApp({
          loggerFactory: createNodeLoggerFactory({ logDir }),
          env: {
            ZCODE_STORAGE_DIR: storage,
            ZCODE_SESSION_DB_PATH: join(storage, "cli", "db", "db.sqlite"),
          },
          userConfigPath: configPath,
          runtimeConfig: {
            workingDirectory: workspace,
            mode: "yolo",
            mcp: { enabled: false, servers: {} },
            modelSelection: {
              providerId: "zai",
              modelId: "glm-4.6",
              options: { reasoningLevel: "low" },
            },
          },
          ...(source === "host" ? { readSubagentRuntimeConfig: readHost } : {}),
          subagentChildHost: childHost,
          modelExecutor: {
            async generateText() {
              return ++parentCalls === 1
                ? {
                    finishReason: "tool-calls",
                    text: "",
                    usage: {},
                    toolCalls: [
                      {
                        id: "source_agent",
                        name: "Agent",
                        input: {
                          description: "Review",
                          prompt: "Review",
                          subagent_type: "reviewer",
                          // 前台派发：本轮结束前完成派发，断言才能看到构造入参；
                          // 后台派发会在 submitPrompt 返回后才开始。
                          wait: true,
                        },
                      },
                    ],
                  }
                : { finishReason: "stop", text: "done", usage: {} };
            },
          },
        });
        // 子代理定义按 turn 加载：创建不再阻塞在 host 读取上，创建阶段也不落盘解析。
        if (source === "host") initial.resolve(hostConfig("INITIAL_PROFILE"));
        app = await creating;
        expect(readHost).not.toHaveBeenCalled();
        expect(pluginLoader).toHaveBeenCalledTimes(1);
        readHost.mockResolvedValue(hostConfig("NEXT_PROFILE"));
        await app.submitPrompt("Please delegate the review");
        // 单一来源：host 来源每 turn 读一次 host 快照；files 来源只用启动期解析的磁盘 profile。
        expect(readHost).toHaveBeenCalledTimes(source === "host" ? 1 : 0);
        expect(launched).toHaveLength(1);
        expect(launched[0]?.agentType).toBe("reviewer");
        expect(launched[0]?.runtimeConfig.subagentContext?.agentPrompt).toContain(
          source === "host" ? "NEXT_PROFILE" : "DISK_PROFILE",
        );
        // 磁盘与 host 各自的解析诊断只由对应来源产生，不会互相补写。
        expect(await readDiagnostics()).toMatchObject(
          source === "files" ? [expectedDiagnostic] : [],
        );
        expect((await readdir(join(storage, "cli", "agents"))).length).toBeGreaterThan(0);
        const diagnostics = await readDiagnostics();
        expect(JSON.stringify(diagnostics)).not.toContain(invalidDocument.content);
        // 只替换 subagent 来源；实际 session 数据库仍在环境变量指定的位置。
        expect((await readFile(join(storage, "cli", "db", "db.sqlite"))).length).toBeGreaterThan(0);
      } finally {
        initial.resolve(hostConfig("INITIAL_PROFILE"));
        await (app ?? (await creating?.catch(() => undefined)))?.close?.();
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("keeps builtins and inline definitions through fallback and restores cached plugin templates", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-fallback-"));
    const profile = (name: string) => ({
      name,
      description: `${name} description`,
      systemPrompt: name,
      source: "user" as const,
    });
    const readHost = vi.fn(
      async (): Promise<SubagentRuntimeConfig> => ({ kind: "built-in-fallback" }),
    );
    const loadTemplates = vi.spyOn(subagents, "loadPluginAgentTemplates");
    const resolvePlugins = vi.spyOn(subagents, "resolvePluginAgentProfiles").mockReturnValue({
      profiles: [profile("fixture:worker")],
      diagnostics: [],
      builtInModelSelectionOverrides: {},
      pluginAgentModelSelectionOverrides: {},
    });
    const requests: ModelRequest[] = [];
    let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
    try {
      app = await createRegistryBackedTestApp({
        env: { ZCODE_STORAGE_DIR: root, ZCODE_SESSION_DB_PATH: join(root, "db.sqlite") },
        skipUserConfig: true,
        runtimeConfig: {
          workingDirectory: root,
          mcp: { enabled: false, servers: {} },
          subagents: { profiles: [profile("inline-reviewer")] },
        },
        readSubagentRuntimeConfig: readHost,
        modelExecutor: {
          async generateText(request) {
            requests.push(request);
            return { finishReason: "stop", text: "done", usage: {} };
          },
        },
      });
      await app.submitPrompt("Fallback turn");
      const first = JSON.stringify(requests[0]);
      for (const name of ["Explore", "general-purpose", "inline-reviewer"])
        expect(first).toContain(name);
      expect(first).not.toContain("fixture:worker");
      expect(resolvePlugins).not.toHaveBeenCalled();
      readHost.mockResolvedValue({
        kind: "ready",
        profiles: [profile("file-reviewer")],
        builtInModelSelectionOverrides: {},
        pluginAgentModelSelectionOverrides: {},
      });
      await app.submitPrompt("Recovered turn");
      expect(JSON.stringify(requests[1])).toContain("fixture:worker");
      expect(JSON.stringify(requests[1])).toContain("file-reviewer");
      readHost.mockResolvedValue({ kind: "built-in-fallback" });
      await app.submitPrompt("Fallback again");
      const last = JSON.stringify(requests[2]);
      expect(last).toMatch(/no longer available/);
      expect(last).toContain("inline-reviewer");
      expect(resolvePlugins).toHaveBeenCalledTimes(1);
      expect(loadTemplates).toHaveBeenCalledTimes(1);
      // 每个 turn 读一次 host 快照：共 3 个 turn。
      expect(readHost).toHaveBeenCalledTimes(3);
    } finally {
      await app?.close?.();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("propagates an initialization read failure without falling back to disk profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "subagent-initial-failure-"));
    const error = new Error("Host configuration unavailable");
    let app: Awaited<ReturnType<typeof createRegistryBackedTestApp>> | undefined;
    try {
      app = await createRegistryBackedTestApp({
        env: { ZCODE_STORAGE_DIR: root, ZCODE_SESSION_DB_PATH: join(root, "db.sqlite") },
        skipUserConfig: true,
        runtimeConfig: { workingDirectory: root, mcp: { enabled: false, servers: {} } },
        readSubagentRuntimeConfig: async () => {
          throw error;
        },
      });
      // 定义按 turn 加载：读取失败在首个 turn 的加载阶段上抛。turn 级包装是统一的
      // “Turn execution failed”，根因必须留在 cause 链里（见 core turn-errors），
      // 且失败意味着本轮不会静默改用磁盘 profile 继续跑。
      const failure = await app.submitPrompt("First turn").catch((caught: unknown) => caught);
      expect(failure).toMatchObject({ type: "unknown_error", recoverable: false });
      expect((failure as { cause?: unknown }).cause).toBe(error);
    } finally {
      await app?.close?.();
      vi.restoreAllMocks();
      await rm(root, { recursive: true, force: true });
    }
  });
});
