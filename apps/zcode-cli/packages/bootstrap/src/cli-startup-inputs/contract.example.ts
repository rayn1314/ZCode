/**
 * cli-startup-inputs 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { ZCodeAppOptions } from "../app/types.js";
import {
  resolveStartupInputs,
  type ResolveStartupInputsInput,
  type ZCodeAppStartupInputs,
} from "./contract.js";

/** 正常会话：每次创建 App 都按当前磁盘现状解析一次（`createZCodeApp` 的默认路径）。 */
export function exampleResolveForNewSession(
  input: ResolveStartupInputsInput,
): Promise<ZCodeAppStartupInputs> {
  return resolveStartupInputs(input);
}

/**
 * 子会话：复用父会话已解析的那一份，不再做四项磁盘解析（含同步插件发现）。
 * 父快照缺席就是编程错误——不要在这里悄悄自己解析一份，那会把父子的插件面解析成两份。
 */
export function exampleReuseParentStartupInputs(
  parent: Pick<ZCodeAppOptions, "startupInputs">,
  childOptions: ZCodeAppOptions,
): ZCodeAppOptions {
  const inherited = parent.startupInputs;
  if (inherited === undefined) {
    throw new Error("Subagent child requires the parent startup inputs snapshot");
  }
  return { ...childOptions, startupInputs: inherited };
}

/** 快照是只读派生：这里按需取派生值，不改写快照本身。 */
export function exampleReadStartupSnapshot(inputs: ZCodeAppStartupInputs) {
  return {
    storageRoot: inputs.storageRoot,
    cliStorageRoot: inputs.cliStorageRoot,
    modelIoDir: inputs.modelIoDir,
    enabledPluginCount: inputs.pluginOutcome.plugins.filter((plugin) => plugin.enabled).length,
    bundledSkillRootCount: inputs.bundledSkillRoots.length,
  };
}
