// ============================================================
// Environment Info Section Builder
// ============================================================

import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { resolveZCodeDataRoot } from "@zcode/contracts";
import type { Model } from "@zcode/contracts";
import type { ContextSection, EnvInfo } from "../types.js";
import { estimateTokens } from "../utils.js";

const ENVIRONMENT_HEADING = "# Environment";
const WORKING_DIRECTORY_LABEL = "Primary working directory";
const IS_GIT_REPOSITORY_LABEL = "Is a git repository";
const PLATFORM_LABEL = "Platform";
const SHELL_LABEL = "Shell";
const OS_VERSION_LABEL = "OS Version";
const USER_DATA_ROOT_LABEL = "User data root";
// const NODE_VERSION_LABEL = "Node version";
// const OPERATING_SYSTEM_LABEL = "Operating system";
const GIT_LABEL = "Git";
const NOT_A_GIT_REPOSITORY = "not a git repository";
const YES_LABEL = "yes";
const NO_LABEL = "no";
const GIT_SYSTEM_CONTEXT_PREFIX =
  "gitStatus: This is the git status at the start of the conversation. Note that this status is a snapshot in time, and will not update during the conversation.";
const CURRENT_BRANCH_LABEL = "Current branch";
const MAIN_BRANCH_LABEL = "Main branch (you will usually use this for PRs)";
const GIT_USER_LABEL = "Git user";
const STATUS_LABEL = "Status";
const RECENT_COMMITS_LABEL = "Recent commits";
const CLEAN_GIT_STATUS = "(clean)";
const DIRTY_GIT_STATUS = "(dirty)";
const UNKNOWN_GIT_STATUS = "(unknown)";

export function buildEnvInfoSection(envInfo: EnvInfo, model?: Model): ContextSection {
  const content = buildEnvInfoContent(envInfo, model);

  return {
    name: "Environment Info",
    source: "env_info",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

export function buildGitSystemContextSection(envInfo: EnvInfo): ContextSection | null {
  if (!isEnvInfoGitRepository(envInfo)) {
    return null;
  }

  const content = buildGitSystemContextContent(envInfo);

  return {
    name: "System Context",
    source: "system_context",
    injectionTarget: "system",
    cacheHint: "dynamic",
    chars: content.length,
    tokens: estimateTokens(content),
    content,
    preview: content.slice(0, 100),
  };
}

function buildEnvInfoContent(info: EnvInfo, model?: Model): string {
  const hasGitRepository = isEnvInfoGitRepository(info);
  const lines: string[] = [
    ENVIRONMENT_HEADING,
    "You have been invoked in the following environment:",
    `- ${WORKING_DIRECTORY_LABEL}: ${info.cwd}`,
    `- ${IS_GIT_REPOSITORY_LABEL}: ${hasGitRepository ? YES_LABEL : NO_LABEL}`,
    `- ${PLATFORM_LABEL}: ${info.platform}`,
    `- ${SHELL_LABEL}: ${info.shell}`,
    `- ${OS_VERSION_LABEL}: ${info.osVersion}`,
    ...buildUserDataRootLines(resolveZCodeDataRoot()),
    // 旧环境快照可能携带历史模型字段；渲染只读取本步骤实际执行的 Model。
    ...(model
      ? [`- You are powered by the model named ${model.providerId}/${model.modelId}.`]
      : []),
  ];

  return lines.join("\n");
}

/**
 * 身份数据根非常规时（产品身份后缀 / ZCODE_DATA_ROOT 覆盖）把真实数据根写进 Environment 段。
 * 模型对「数据根在哪」的认知只来自提示词里出现过的路径字面量——不声明，它就按习惯猜共享域
 * `~/.zcode`，把会话库、凭据、日志查到另一个产品身份头上。与常规根 `~/.zcode` 相同时不注入，
 * 官方构建的提示词保持原文。共享域（skills/commands/plugins/AGENTS.md）判据见 desktop spec
 * `product-identity-data-root.md`。
 */
function buildUserDataRootLines(dataRoot: string): string[] {
  const conventionalRoot = join(homedir(), ".zcode");
  if (normalizePathForCompare(dataRoot) === normalizePathForCompare(conventionalRoot)) {
    return [];
  }
  return [
    `- ${USER_DATA_ROOT_LABEL}: ${dataRoot} (user-level skills / commands / plugins / AGENTS.md are intentionally shared and stay under ${conventionalRoot})`,
  ];
}

/** Windows 路径大小写不敏感、分隔符可混用；比较前统一 resolve，避免误判非常规根。 */
function normalizePathForCompare(path: string): string {
  const resolved = resolve(path);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function buildGitSystemContextContent(info: EnvInfo): string {
  const lines: string[] = [GIT_SYSTEM_CONTEXT_PREFIX];

  if (info.gitBranch) {
    lines.push("", `${CURRENT_BRANCH_LABEL}: ${info.gitBranch}`);
  }
  if (info.gitMainBranch) {
    lines.push("", `${MAIN_BRANCH_LABEL}: ${info.gitMainBranch}`);
  }
  if (info.gitUser) {
    lines.push("", `${GIT_USER_LABEL}: ${info.gitUser}`);
  }

  lines.push("", `${STATUS_LABEL}:\n${formatGitStatus(info)}`);
  lines.push("", `${RECENT_COMMITS_LABEL}:\n${formatRecentCommits(info)}`);

  return lines.join("\n");
}

export function isEnvInfoGitRepository(info: EnvInfo): boolean {
  return (
    info.isGitRepository ??
    (info.gitStatus !== undefined ? info.gitStatus !== "not_repo" : Boolean(info.gitBranch))
  );
}

function formatGitStatus(info: EnvInfo): string {
  if (info.gitStatusLines && info.gitStatusLines.length > 0) {
    return info.gitStatusLines.join("\n");
  }
  if (info.gitStatus === "dirty") {
    return DIRTY_GIT_STATUS;
  }
  if (info.gitStatus === "clean") {
    return CLEAN_GIT_STATUS;
  }
  return UNKNOWN_GIT_STATUS;
}

function formatRecentCommits(info: EnvInfo): string {
  if (info.recentCommits && info.recentCommits.length > 0) {
    return info.recentCommits.join("\n");
  }
  return "";
}
