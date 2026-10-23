/**
 * instructions 对外契约：调用方要想正确调用就必须知道的一切都写在这里；其余对外不可见。
 *
 * 模块意图：把 Agent 真正会读的指令文件（`AGENTS.md`）变成设置页可读可写的对象，
 * 并让「读哪一份」与 Agent 侧读取器同口径——路径候选顺序、读取上限、向上查找规则都来自
 * `@zcode/shared` 的 `instruction-files`（唯一真相源），本模块只把它们变成磁盘事实。
 *
 * 作用域语义：
 * - `user`：固定 `<home>/.zcode/AGENTS.md`（`HOME` → `USERPROFILE` → `homedir()`，与 Agent 侧逐字同口径）；
 * - `workspace`：自 `workspacePath` 向上到 projectRoot（含 `.git` 的目录；没有就一路到文件系统根），
 *   每级目录按候选顺序 `AGENTS.md` → `.zcode/AGENTS.md` → `.agents/AGENTS.md` 取第一个存在者，命中即停。
 *
 * 全局不变量：
 * 1. 读取是只读探测，不建目录、不写任何文件；写入是唯一的写路径，且是原子替换（先写临时文件再 rename）。
 * 2. `targetPath` 是**写入落点**（仓库级恒为 `workspacePath/AGENTS.md`），`effectivePath` 是**当前生效文件**，
 *    两者可以不同：仓库级命中上级目录、或同目录 `.zcode/AGENTS.md` 被 `AGENTS.md` 遮蔽时都会如此；
 *    `exists === true` 时 `effectivePath === targetPath`。
 * 3. `truncated`（`bytes > 100KB`）与 `content`（只回传前 100KB）与 Agent 侧同语义：
 *    超出的部分根本不会被 Agent 读到，因此编辑界面也不展示。
 * 4. 写入用 `expectedMtimeMs` 做乐观并发基线（CAS）：调用方拿到的基线过期就返回 `conflict`，
 *    绝不覆盖；服务端在锁内、rename 之前复验一次，失败不改动磁盘。
 */
import { ServiceChannels, type InstructionScope } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";
import type {
  IInstructionsService as IInstructionsServiceImplementation,
  InstructionFileState,
  InstructionFileWriteFailureReason,
} from "./instructions.js";

export type { InstructionScope } from "@zcode/shared";
export type { InstructionFileState, InstructionFileWriteFailureReason } from "./instructions.js";

/** 读一个作用域：`workspacePath` 必传，`workspaceIdentity` 只为对齐其它 workspace 级服务的调用形状。 */
export interface ReadInstructionFileParams {
  workspaceIdentity?: string;
  workspacePath: string;
  scope: InstructionScope;
}

/** 写一个作用域：`expectedMtimeMs === null` 表示「按新建提交」。 */
export interface WriteInstructionFileParams extends ReadInstructionFileParams {
  content: string;
  expectedMtimeMs: number | null;
}

/**
 * 写结果（判别联合，三个失败原因彼此不重叠）：
 * - `conflict`：磁盘现状与 `expectedMtimeMs` 不一致，磁盘未被改动，由调用方裁决（覆盖 / 放弃并重载）；
 * - `not-writable`：落点或最近存在祖先目录不可写（实时探测，不乐观假设），磁盘未被改动；
 * - `failed`：真实 IO 错误，`message` 为原始错误文案。
 */
export type InstructionFileWriteResult =
  | { ok: true }
  | { ok: false; reason: InstructionFileWriteFailureReason; message?: string };

export interface IInstructionsService {
  /**
   * 读取一个作用域的指令文件现状：落点、生效文件、同目录被遮蔽的候选、字节数与 mtime、可写性。
   *
   * 前置：无（幂等、无副作用；路径不存在时返回 `exists: false` 而不是抛错）。
   * 后置：`content` 是最多 100KB 的落点内容（不存在时为空串）；`mtimeMs` 同时是后续写入的并发基线。
   * 失败：路径解析或磁盘探测的真实错误向上抛（服务未注册由调用方降级为「加载失败」态）。
   */
  readInstructionFile(params: ReadInstructionFileParams): Promise<InstructionFileState>;

  /**
   * 写入一个作用域的指令文件（建目录 + 原子替换），返回时已落盘。
   *
   * 幂等：同一 `content` + 同一基线重复提交，第二次因 mtime 变化返回 `conflict`（不会写出两份内容）。
   * 冲突语义：`expectedMtimeMs` 与磁盘现状不一致（含「传 null 但落点已存在」）即 `conflict`，
   * 磁盘原样保留；不可写返回 `not-writable`；其它错误返回 `failed`。
   */
  writeInstructionFile(params: WriteInstructionFileParams): Promise<InstructionFileWriteResult>;
}

export const IInstructionsService = createServiceDescriptor<IInstructionsService>(
  ServiceChannels.Instructions,
);

/**
 * 编译期断言：契约与实现互相覆盖，任一侧增删方法或改签名都会在这里报类型错。
 * 契约是调用方唯一需要读的那份说明，实现在 `./instructions.js`。
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

export type InstructionsContractMatchesImplementation = Assert<
  MutuallyAssignable<IInstructionsService, IInstructionsServiceImplementation>
>;
