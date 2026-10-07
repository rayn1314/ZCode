// ============================================================
// App 启动期的磁盘解析（解析一次、供多个 App 复用）
// ============================================================
//
// `createZCodeApp` 过去把这几件事写在函数体里：解析配置（用户/项目配置文件）、加载
// agent profile、发现插件（`discoverNodePluginsSync`，**同步**）、解析内置技能包。它们没有
// 进程级缓存，也不该有——"冷恢复会重建 App，天然拿到新 catalog；已有 Session 不热加载新
// Plugin"是既有语义，加缓存会改掉它。
//
// 但子代理子会话是**模型在轮内派发**的（一轮三五个是常态），每次派发都重做这四项等于每次
// 派发付一次会话启动成本。因此把这段抽成显式的一步：正常会话每次调用它（`createZCodeApp`
// 的默认路径），子会话由构造入口传入父已解析好的结果（`ZCodeAppOptions.startupInputs`）。
// 详见 spec `subagent-session-as-first-class.md` 的「约束二」与 S1b。
//
// 这份结果的语义是**本次 App 创建时观测到的启动输入快照**，不是可变状态：除 `configResult`
// 由 App 自己的 facade 原地更新 ui.locale（既有行为）外，其余都是只读派生。

import { createConfig, resolvePath, type ConfigResult } from "@zcode/adapters/config";
import type { AgentProfile, AgentRuntimeConfig } from "@zcode/core";
import type { Logger, McpServerConfig, PluginLoadOutcome, SkillRoot } from "@zcode/contracts";
import { resolveZCodeRuntimeEnv } from "@zcode/shared";

import { createConfigCliOverrides, resolveEffectiveConfigResult } from "./app-config-options.js";
import { resolveBundledSkillRoots } from "./bundled-skills.js";
import { resolveBuiltInNodeReplMcpServers } from "./built-in-node-repl.js";
import { getCliStorageRoot, getModelIoDir } from "./paths.js";
import { resolvePluginRuntimeFeatures } from "./plugin-runtime-features.js";
import { resolveStartupPlugins } from "./startup-marks.js";
import type { StartupTimer } from "../startup-logging.js";
import { loadPluginAgentProfiles, loadZCodeAgentProfiles } from "../subagents.js";
import type { ZCodeAppOptions } from "./types.js";

type ZCodeAgentProfileOutcome = Awaited<ReturnType<typeof loadZCodeAgentProfiles>>;

export interface ZCodeAppStartupInputs {
  /** 已应用 CLI/会话级覆盖（mode / 工具面 / ui locale）的配置结果。 */
  configResult: ConfigResult;
  /** `configResult.config.storage.dir` 解析后的绝对路径。 */
  storageRoot: string;
  /** CLI 自身的存储根（`<storageRoot>/cli`）。 */
  cliStorageRoot: string;
  /** 调用轨迹（model IO）落盘目录。 */
  modelIoDir: string;
  /** 用户 / 项目 agent profile 的加载结果（含 model selection override）。 */
  zcodeSubagentProfileOutcome: ZCodeAgentProfileOutcome;
  /** 用户 + 项目 + 插件 profile 的合并清单，进入 `runtimeConfig.subagents.profiles`。 */
  subagentProfiles: readonly AgentProfile[];
  /** 插件发现结果（列表、hook、MCP、技能根、命令行根）。 */
  pluginOutcome: PluginLoadOutcome;
  /** 由插件清单推导的运行时能力位（browser-use / computer-use）。 */
  pluginRuntimeFeatures: NonNullable<AgentRuntimeConfig["runtimeFeatures"]>;
  /** 内置 node_repl MCP server（browser-use / computer-use 共用的宿主产物）。 */
  builtInMcpServers: Record<string, McpServerConfig>;
  /** 随 CLI 内置的技能包根（不属于任何插件，用户无法停用）。 */
  bundledSkillRoots: readonly SkillRoot[];
}

export interface ResolveStartupInputsInput {
  options: ZCodeAppOptions;
  /** 已规范化的执行工作目录（`runtimeConfig.workingDirectory` 或进程 cwd）。 */
  workingDirectory: string;
  logger: Logger;
  startupTimer: StartupTimer;
}

/**
 * 按当前磁盘现状解析启动输入。**每次都读盘**，没有缓存；复用只由调用方显式传
 * `ZCodeAppOptions.startupInputs` 表达（子会话复用父会话这一份）。
 */
export async function resolveStartupInputs(
  input: ResolveStartupInputsInput,
): Promise<ZCodeAppStartupInputs> {
  const { logger, options, startupTimer, workingDirectory } = input;
  const configResult = resolveEffectiveConfigResult(
    createConfig({
      env: options.env,
      projectConfigPath: options.projectConfigPath,
      workingDirectory,
      workspaceIdentity: options.runtimeConfig?.memory?.workspaceIdentity,
      skipUserConfig: options.skipUserConfig,
      userConfigPath: options.userConfigPath,
      cliOverrides: createConfigCliOverrides(options),
    }),
    options,
  );
  const storageRoot = resolvePath(configResult.config.storage.dir);
  const cliStorageRoot = getCliStorageRoot(storageRoot);
  const modelIoDir = getModelIoDir(
    cliStorageRoot,
    resolveZCodeRuntimeEnv(options.env ?? process.env) === "development",
  );
  const zcodeSubagentProfileOutcome = await loadZCodeAgentProfiles({
    logger,
    storageRoot,
    workingDirectory,
  });
  const zcodeSubagentProfiles = zcodeSubagentProfileOutcome.profiles;
  const pluginOutcome = resolveStartupPlugins({
    cliStorageRoot,
    configResult,
    env: options.env,
    logger,
    options,
    startupTimer,
    workingDirectory,
  });
  const bundledSkillRoots = await resolveBundledSkillRoots({ cliStorageRoot, logger });
  const pluginSubagentProfiles = loadPluginAgentProfiles({
    logger,
    plugins: pluginOutcome.plugins,
    reservedProfileNames: zcodeSubagentProfiles.map((profile) => profile.name),
    modelSelectionOverrides: zcodeSubagentProfileOutcome.pluginAgentModelSelectionOverrides,
  }).profiles;
  const pluginRuntimeFeatures = resolvePluginRuntimeFeatures(pluginOutcome);
  const builtInMcpServers = resolveBuiltInNodeReplMcpServers({
    pluginOutcome,
    workingDirectory,
  });

  return {
    configResult,
    storageRoot,
    cliStorageRoot,
    modelIoDir,
    zcodeSubagentProfileOutcome,
    // 用户目录已在 loader 前完成原地迁移；不能给项目/插件旧身份加内存兼容旁路。
    subagentProfiles: [...zcodeSubagentProfiles, ...pluginSubagentProfiles],
    pluginOutcome,
    pluginRuntimeFeatures,
    builtInMcpServers,
    bundledSkillRoots,
  };
}
