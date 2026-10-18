// ============================================================
// Instruction Files — 指令文件（AGENTS.md）路径与上限的单一真相源
// ============================================================

/**
 * 用户级 / 仓库级指令文件（AGENTS.md）的候选顺序、路径解析与读取上限的唯一来源。
 *
 * 浏览器安全：本文件只做字符串运算，不依赖 `node:*`、不依赖 zod，UI 与 Host 共享同一份定义。
 *
 * 路径约定：`joinInstructionPath` 用 `/` 拼出规范形式（消除 `\` 与 `/` 混用与重复分隔符），
 * Node 侧消费点（读取器、指令文件服务）用 `path.normalize` 还原为平台分隔符后再落盘/比较。
 * 「有哪些候选、按什么顺序、拼到哪个 home / 工作目录」只在本文件定义，分隔符差异不构成第二份真相。
 */

/** 单个指令文件的读取上限：超出部分 Agent 不读（读取器与设置页同值）。 */
export const INSTRUCTION_FILE_MAX_BYTES = 100 * 1024;

/** 用户级指令文件相对用户 home 的固定路径。 */
export const USER_INSTRUCTION_FILE_RELATIVE_PATH = ".zcode/AGENTS.md";

/**
 * 仓库级候选：自工作目录向上逐级查找，每级目录按本顺序取第一个存在者
 * （对齐 Codex「每目录最多一个指令文件」）。`AGENTS.md` 在前，保证仓库根的
 * 普通 `AGENTS.md` 优先于工具目录 `.zcode` / `.agents` 下的同名文件。
 */
export const WORKSPACE_INSTRUCTION_FILE_CANDIDATES = [
  "AGENTS.md",
  ".zcode/AGENTS.md",
  ".agents/AGENTS.md",
] as const;

/** 指令文件作用域：用户级（home）与仓库级（工作区及其上级）。 */
export type InstructionScope = "user" | "workspace";

/**
 * 拼接路径片段：统一处理 `/` 与 `\`，保留首个非空片段的根前缀（POSIX 根 `/`、UNC 双斜杠、盘符）。
 * 空片段与重复分隔符被折叠，因此 `joinInstructionPath("C:\\a\\", "/b")` 得到 `C:/a/b`。
 */
export function joinInstructionPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    for (const part of segment.split(/[\\/]+/)) {
      if (part.length > 0) parts.push(part);
    }
  }

  const first = segments.find((segment) => segment.length > 0) ?? "";
  const root = /^[\\/]{2}/.test(first) ? "//" : /^[\\/]/.test(first) ? "/" : "";
  if (parts.length === 0) {
    return root;
  }
  return `${root}${parts.join("/")}`;
}

/** 某个目录下的仓库级候选绝对路径，顺序与 `WORKSPACE_INSTRUCTION_FILE_CANDIDATES` 一致。 */
export function workspaceInstructionCandidatePaths(directory: string): string[] {
  return WORKSPACE_INSTRUCTION_FILE_CANDIDATES.map((candidate) =>
    joinInstructionPath(directory, candidate),
  );
}

/** 用户级指令文件的绝对路径（`<home>/.zcode/AGENTS.md`）。 */
export function userInstructionFilePath(homeDir: string): string {
  return joinInstructionPath(homeDir, USER_INSTRUCTION_FILE_RELATIVE_PATH);
}

/** 是否超过单文件读取上限（与读取器 `truncated` 同语义：严格大于）。 */
export function isInstructionFileTooLarge(bytes: number): boolean {
  return bytes > INSTRUCTION_FILE_MAX_BYTES;
}
