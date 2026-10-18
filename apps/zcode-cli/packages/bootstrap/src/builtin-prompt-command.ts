import { join } from "node:path";
import {
  BUILTIN_WORKFLOW_COMMAND_NAME,
  expandBuiltinWorkflowCommandPrompt,
} from "./builtin-workflow-command.js";

const BUILTIN_PROMPT_COMMAND_PATTERN = /^\/([^\s]+)(?:\s+([\s\S]*))?$/;
const INIT_COMMAND_NAME = "init";

export interface ResolveZCodeBuiltinPromptCommandOptions {
  /**
   * 动态工作流灰度门（docs/dynamic-workflow/launch.md「Gray release」）。**只有显式 false 才挡下**
   * `/workflow`：TUI / headless 从不设置该字段，那里的功能始终开启。挡下时返回 undefined，
   * 与「命令不存在」同形——`workflow` 是保留名，后续的自定义命令解析同样拒绝展开，于是原文作为
   * 普通 prompt 交给模型，与目录侧剔除它的结论一致（DWG-03）。
   */
  dynamicWorkflowEnabled?: boolean;
  workingDirectory?: string;
}

export interface ResolvedZCodeBuiltinPromptCommand {
  /** 命中的内置命令名（`init` / `workflow`），调用方据此挂命令特有的副作用（如 onDemand 激活）。 */
  name: string;
  prompt: string;
}

export function resolveZCodeBuiltinPromptCommand(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): string | undefined {
  return resolveZCodeBuiltinPromptCommandInvocation(input, options)?.prompt;
}

export function resolveZCodeBuiltinPromptCommandInvocation(
  input: string,
  options: ResolveZCodeBuiltinPromptCommandOptions = {},
): ResolvedZCodeBuiltinPromptCommand | undefined {
  const invocation = parseBuiltinPromptCommandInvocation(input);
  if (!invocation) {
    return undefined;
  }

  if (invocation.name === INIT_COMMAND_NAME) {
    const workingDirectory = options.workingDirectory ?? process.cwd();
    return {
      name: INIT_COMMAND_NAME,
      prompt: buildInitAgentsPrompt({
        args: invocation.args,
        targetPath: join(workingDirectory, "AGENTS.md"),
        workingDirectory,
      }),
    };
  }

  if (invocation.name === BUILTIN_WORKFLOW_COMMAND_NAME) {
    if (options.dynamicWorkflowEnabled === false) {
      return undefined;
    }
    return {
      name: BUILTIN_WORKFLOW_COMMAND_NAME,
      prompt: expandBuiltinWorkflowCommandPrompt(invocation.args),
    };
  }

  return undefined;
}

function parseBuiltinPromptCommandInvocation(input: string): { args: string; name: string } | null {
  const match = BUILTIN_PROMPT_COMMAND_PATTERN.exec(input.trim());
  if (!match?.[1]) {
    return null;
  }
  return {
    args: match[2]?.trim() ?? "",
    name: match[1].toLowerCase(),
  };
}

function buildInitAgentsPrompt(params: {
  args: string;
  targetPath: string;
  workingDirectory: string;
}): string {
  const additionalInstructions = params.args
    ? [
        "",
        "Additional user instructions supplied with /init:",
        "```text",
        params.args,
        "```",
      ].join("\n")
    : "";

  return [
    "You are running ZCode's built-in /init command.",
    "",
    "Your task is to create or update a concise workspace instruction file for future ZCode agents.",
    "",
    "Target:",
    `- Workspace directory: ${params.workingDirectory}`,
    `- Instruction file to create or update: ${params.targetPath}`,
    `- Hidden alternatives, read only when the workspace root AGENTS.md is absent: ${join(params.workingDirectory, ".zcode", "AGENTS.md")} and ${join(params.workingDirectory, ".agents", "AGENTS.md")}`,
    "- File name must be exactly AGENTS.md.",
    "- The workspace root AGENTS.md wins. Only write a hidden alternative when the user explicitly wants the instructions kept inside the tool directory.",
    "- This command targets the current workspace only. Do not write ~/.zcode/AGENTS.md.",
    additionalInstructions,
    "",
    "Process:",
    "1. Check the workspace root AGENTS.md and the hidden candidates .zcode/AGENTS.md and .agents/AGENTS.md before writing anything.",
    "2. When both the workspace root AGENTS.md and a hidden candidate exist, the root one is what agents read and the hidden candidate is ignored: report which path is read and which is ignored, never pick one silently.",
    "3. When only a hidden candidate exists, tell the user they already have an instructions file at that path, mention the path found, and ask whether to keep it there or move the instructions to the workspace root AGENTS.md.",
    "4. Inspect the repository before writing. Prefer Read, Glob, Grep, and safe Bash commands such as ls, find, git status, and package-manager script inspection.",
    "5. If AGENTS.md already exists, read it first and update it with Edit instead of replacing it wholesale.",
    "6. If AGENTS.md does not exist, create it at the workspace root. Write .zcode/AGENTS.md instead only when the user explicitly wants the instructions kept inside the tool directory.",
    "7. Keep the file practical and short enough for future agents to read quickly.",
    "8. Include only project-specific facts future ZCode agents would otherwise miss.",
    "9. Ask the user only if a repository-specific decision cannot be inferred and would materially change the file.",
    "",
    "Recommended AGENTS.md content:",
    "- Repository purpose and major directories.",
    "- Build, typecheck, lint, and focused test commands discovered from the repo.",
    "- Architecture boundaries and layer rules that matter for edits.",
    "- Coding conventions, import/path rules, logging rules, UI/design rules, and platform compatibility constraints if present.",
    "- Known gotchas for desktop app, web, remote, stdio, protocols, or agent runtime if this repo has them.",
    "- Any documentation files that agents should read before changing sensitive areas.",
    "",
    "After creating or editing AGENTS.md, summarize the main sections you wrote and mention the file path.",
  ].join("\n");
}
