import {
  INSTRUCTION_FILE_MAX_BYTES,
  isInstructionFileTooLarge,
  userInstructionFilePath,
  workspaceInstructionCandidatePaths,
  type InstructionScope,
} from "@zcode/shared";
import { constants } from "node:fs";
import { access, open, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import type {
  IInstructionsService,
  InstructionFileState,
  InstructionFileWriteFailureReason,
} from "./instructions.js";

/**
 * 指令文件（AGENTS.md）读写服务。
 *
 * 路径解析的唯一真相源在 `@zcode/shared` 的 `instruction-files`（候选顺序、用户级相对路径、读取上限）：
 * 本文件只把它变成磁盘事实——向上逐级查找、可写性探测、原子写。
 *
 * 与 Agent 侧读取器（`@zcode/adapters` 的 NodeContextSourceAdapter）保持同一语义：
 * - user：固定 `<home>/.zcode/AGENTS.md`；
 * - workspace：从 `workspacePath` 向上到 projectRoot（有 `.git` 的目录；没有就一路到文件系统根），
 *   每级目录按候选顺序取第一个存在者，命中即停；
 * - 读取上限 100KB，只把前 100KB 交给 UI 编辑，超出部分不会被 Agent 读到。
 */

/** 仓库根判定标记：与 adapters 的 `findProjectRoot` 同口径（存在即视为 project root）。 */
const GIT_MARKER_DIRECTORY_NAME = ".git";

/**
 * 并发写入冲突的哨兵错误。
 *
 * 只有「锁内复验发现磁盘已变」会抛出它，用来把 CAS 失败与真实 IO 失败区分开：
 * 前者是并发事实（返回 `conflict`），后者是错误（返回 `failed`）。
 */
class InstructionFileConflictError extends Error {}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** 权限类错误：写入时实时映射为 `not-writable`，避免把「不可写」报成「写失败」。 */
function isNotWritableError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EACCES" || code === "EPERM" || code === "EROFS";
}

/** `@zcode/shared` 产出规范 `/` 路径；Node 侧落盘与比较必须还原为平台分隔符。 */
function toNativePath(candidate: string): string {
  return normalize(candidate);
}

/**
 * 用户级指令文件所在的 home：与 Agent 侧读取器（`@zcode/adapters`）逐字同口径（`HOME` → `USERPROFILE` → `homedir()`）。
 *
 * 这里**不能**用 `#src/paths.js` 的 `resolveUserHomeDir`：那一份带 `ZCODE_DESKTOP_HOME_DIR` 覆盖，
 * 而 `~/.zcode/AGENTS.md` 属于「共享类用户资产」，桌面与 CLI 必须落在同一个文件上
 * （见 paths.ts 中 `ZCODE_USER_DIR_NAME` 的说明）。改到 Dev/e2e 的临时 home 会让设置页编辑一份
 * Agent 永远不会读的文件。
 */
function resolveInstructionHomeDir(): string {
  return process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || homedir();
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 严格存在性：只把常规文件算作存在（目录/符号链接到目录一律按不存在处理，避免落点被目录占位时误判）。 */
async function statRegularFile(path: string): Promise<{ size: number; mtimeMs: number } | null> {
  try {
    const info = await stat(path);
    return info.isFile() ? { size: info.size, mtimeMs: info.mtimeMs } : null;
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * 宽容存在性（只用于向上查找的候选扫描）：权限等原因导致 stat 失败时按「该层无候选」继续向上。
 * 上层目录不可读不能连带阻断更高层合法指令文件的读取；写入落点仍走严格版本，不掩盖错误。
 */
async function existsAsRegularFile(path: string): Promise<boolean> {
  try {
    return (await statRegularFile(path)) !== null;
  } catch {
    return false;
  }
}

/** 只读前 `maxBytes` 字节：与 Agent 侧同语义（按字节截断，跨多字节字符边界处解码为替换字符）。 */
async function readHeadBytes(path: string, maxBytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** 从 `startDirectory` 向上找到最近的 project root（含 `.git` 标记的目录）；没有则 null。 */
async function findProjectRoot(startDirectory: string): Promise<string | null> {
  let current = resolve(startDirectory);
  while (current !== dirname(current)) {
    if (await isDirectory(join(current, GIT_MARKER_DIRECTORY_NAME))) {
      return current;
    }
    current = dirname(current);
  }
  return null;
}

/** 最近的存在目录：不存在落点要靠它建目录树，因此它的可写性就是「能否新建」的真实能力。 */
async function findNearestExistingDirectory(startDirectory: string): Promise<string | null> {
  let current = startDirectory;
  for (;;) {
    if (await isDirectory(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function notWritableReason(path: string): string {
  return `无写入权限：${path}`;
}

/**
 * 可写性探测：落点已存在就看落点本身，否则看最近的已存在祖先目录（写入会先建目录树）。
 * 这是「当前真实能力」的探测，不做乐观假设；真实写入错误仍会被二次映射（见 writeInstructionFile）。
 */
async function inspectWritability(
  targetPath: string,
): Promise<{ writable: boolean; readonlyReason?: string }> {
  const probePath = (await statRegularFile(targetPath))
    ? targetPath
    : await findNearestExistingDirectory(dirname(targetPath));
  if (!probePath) {
    return { writable: false, readonlyReason: notWritableReason(dirname(targetPath)) };
  }
  try {
    await access(probePath, constants.W_OK);
    return { writable: true };
  } catch {
    return { writable: false, readonlyReason: notWritableReason(probePath) };
  }
}

/** 写入落点：用户级固定 `<home>/.zcode/AGENTS.md`；仓库级是候选顺序的第一项（即 UI 的新建落点）。 */
function resolveTargetPath(scope: InstructionScope, workspacePath: string): string {
  if (scope === "user") {
    return toNativePath(userInstructionFilePath(resolveInstructionHomeDir()));
  }
  const target = workspaceInstructionCandidatePaths(workspacePath)[0];
  if (!target) {
    // 候选表为空属于共享常量被改坏，不能静默回落到别的路径写文件。
    throw new Error("WORKSPACE_INSTRUCTION_FILE_CANDIDATES 不能为空");
  }
  return toNativePath(target);
}

/**
 * 仓库级生效文件：逐级向上，每级按候选顺序取第一个存在者。
 * 只有命中层会继续扫描其余候选（`ignoredCandidates` 表达「同级被遮蔽」）；命中层之外的层不做事后存在性扫描。
 */
async function resolveWorkspaceEffectiveFile(
  workspacePath: string,
): Promise<{ effectivePath: string | null; ignoredCandidates: string[] }> {
  const projectRoot = await findProjectRoot(workspacePath);
  let current = resolve(workspacePath);

  for (;;) {
    const present: string[] = [];
    for (const candidate of workspaceInstructionCandidatePaths(current)) {
      const candidatePath = toNativePath(candidate);
      if (await existsAsRegularFile(candidatePath)) {
        present.push(candidatePath);
      }
    }
    const [effectivePath, ...ignoredCandidates] = present;
    if (effectivePath) {
      return { effectivePath, ignoredCandidates };
    }
    // 与 adapters 的向上查找同口径：到 projectRoot 或文件系统根就停。
    if (current === projectRoot || current === dirname(current)) {
      break;
    }
    current = dirname(current);
  }

  return { effectivePath: null, ignoredCandidates: [] };
}

/**
 * 创建指令文件服务实例。
 */
export function createInstructionsService(): IInstructionsService {
  async function readInstructionFile(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope: InstructionScope;
  }): Promise<InstructionFileState> {
    const targetPath = resolveTargetPath(params.scope, params.workspacePath);
    const target = await statRegularFile(targetPath);

    let effectivePath: string | null;
    let ignoredCandidates: string[];
    if (params.scope === "user") {
      // 用户级只有一个候选：落点自身就是 Agent 读取的文件。
      effectivePath = target ? targetPath : null;
      ignoredCandidates = [];
    } else {
      const workspaceEffective = await resolveWorkspaceEffectiveFile(params.workspacePath);
      effectivePath = workspaceEffective.effectivePath;
      ignoredCandidates = workspaceEffective.ignoredCandidates;
    }

    const writability = await inspectWritability(targetPath);

    return {
      scope: params.scope,
      targetPath,
      effectivePath,
      ignoredCandidates,
      exists: target !== null,
      bytes: target?.size ?? 0,
      mtimeMs: target?.mtimeMs ?? null,
      truncated: target !== null && isInstructionFileTooLarge(target.size),
      content: target ? await readHeadBytes(targetPath, INSTRUCTION_FILE_MAX_BYTES) : "",
      writable: writability.writable,
      ...(writability.readonlyReason ? { readonlyReason: writability.readonlyReason } : {}),
    };
  }

  async function writeInstructionFile(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope: InstructionScope;
    content: string;
    expectedMtimeMs: number | null;
  }): Promise<
    { ok: true } | { ok: false; reason: InstructionFileWriteFailureReason; message?: string }
  > {
    const targetPath = resolveTargetPath(params.scope, params.workspacePath);

    const writability = await inspectWritability(targetPath);
    if (!writability.writable) {
      return {
        ok: false,
        reason: "not-writable",
        ...(writability.readonlyReason ? { message: writability.readonlyReason } : {}),
      };
    }

    /** 并发基线是否已被打破：`null` 表示「按新建提交」，此时落点已存在即为冲突。 */
    const isStale = async (): Promise<boolean> => {
      const current = await statRegularFile(targetPath);
      if (params.expectedMtimeMs === null) {
        return current !== null;
      }
      return current === null || current.mtimeMs !== params.expectedMtimeMs;
    };

    if (await isStale()) {
      return { ok: false, reason: "conflict" };
    }

    try {
      await atomicWriteText(targetPath, params.content, {
        // CAS 必须在锁内、rename 之前复验：否则「检查 → 替换」之间被并发写入就会悄悄覆盖别人的改动。
        // 原子写还负责建目录、Windows 上 rename 的短暂重试与失败临时文件清理。
        beforeRename: async () => {
          if (await isStale()) {
            throw new InstructionFileConflictError();
          }
        },
      });
      return { ok: true };
    } catch (error) {
      if (error instanceof InstructionFileConflictError) {
        return { ok: false, reason: "conflict" };
      }
      if (isNotWritableError(error)) {
        return { ok: false, reason: "not-writable", message: notWritableReason(targetPath) };
      }
      return {
        ok: false,
        reason: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  return { readInstructionFile, writeInstructionFile };
}
