import type { InstructionScope } from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 指令文件（AGENTS.md）读写服务的契约。
 *
 * 作用域语义与 Agent 侧读取器一致：
 * - user：固定 `<home>/.zcode/AGENTS.md`；
 * - workspace：自工作目录向上逐级查找，每级按候选顺序取第一个存在者（命中即停）。
 */

/** 一个作用域的指令文件现状。`targetPath` 之外的字段描述的是「写入落点」自身，供设置页做新建/编辑决策。 */
export interface InstructionFileState {
  scope: InstructionScope;
  /** 新建/写入落点：user = `<home>/.zcode/AGENTS.md`；workspace = `<workspacePath>/AGENTS.md`。 */
  targetPath: string;
  /** 当前实际被 Agent 读取的那份；不存在则 null。仓库级命中上级目录时可能不等于 `targetPath`。 */
  effectivePath: string | null;
  /** 与生效文件同目录、存在但未被读取的候选（不含 `effectivePath` 本身）。 */
  ignoredCandidates: string[];
  /** 写入落点是否已存在。（不变式：`exists === true` 时 `effectivePath === targetPath`。） */
  exists: boolean;
  /** 落点文件的磁盘字节数（含超过上限的部分）。不存在时为 0。 */
  bytes: number;
  /** 落点文件的 mtime，写入冲突判定基线；不存在时为 null（UI 据此以「新建」提交）。 */
  mtimeMs: number | null;
  /** `bytes > INSTRUCTION_FILE_MAX_BYTES`，与 Agent 侧同语义：超出部分不会被读取。 */
  truncated: boolean;
  /** 落点文件内容，只返回前 `INSTRUCTION_FILE_MAX_BYTES` 字节（与 Agent 侧一致）。 */
  content: string;
  /** 落点是否可写；false 时 `readonlyReason` 说明原因。 */
  writable: boolean;
  readonlyReason?: string;
}

export type InstructionFileWriteFailureReason = "conflict" | "not-writable" | "failed";

export interface IInstructionsService {
  /** 读取一个作用域的指令文件现状（含生效文件、被忽略候选与可写性）。 */
  readInstructionFile(params: {
    /** 身份隔离键；本服务只用 `workspacePath` 定位文件，保留该字段以对齐其它 workspace 级服务。 */
    workspaceIdentity?: string;
    workspacePath: string;
    scope: InstructionScope;
  }): Promise<InstructionFileState>;

  /**
   * 写入一个作用域的指令文件。
   *
   * `expectedMtimeMs` 是写入落点的并发基线：与磁盘现状不一致时返回 `conflict` 而不是覆盖；
   * `null` 表示「我认为落点不存在」，此时落点已存在同样返回 `conflict`。
   */
  writeInstructionFile(params: {
    workspaceIdentity?: string;
    workspacePath: string;
    scope: InstructionScope;
    content: string;
    expectedMtimeMs: number | null;
  }): Promise<
    { ok: true } | { ok: false; reason: InstructionFileWriteFailureReason; message?: string }
  >;
}

export const IInstructionsService = createServiceDescriptor<IInstructionsService>(
  ServiceChannels.Instructions,
);
