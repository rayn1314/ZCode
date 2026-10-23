/**
 * cold-open-window 对外契约
 * （spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md）。
 *
 * 模块意图：打开一个**未常驻**的历史会话时，先把「尾部窗口 + 窗口态行号空间」的首帧发出去让 UI
 * 立刻有画面，后台再完成完整 activation 并整份替换成权威投影——把「等全量读」的延迟从首帧路径上
 * 移走。首帧 config 只取持久化事实。
 *
 * 类型表达不了的不变量：
 * - 窗口态行号恒为负数、权威全序行号恒为正数。客户端只凭首帧首行的符号即可判定窗口态
 *   （`packages/ui/src/v4/conversationRowIdentitySpace.ts` 的 `isColdWindowRowSpace`），
 *   两代行号不得混用——同一个 rowId 在两代不能指向不同行。
 * - 窗口态是**纯预览**：不提供更早历史（`rows.firstRowId` = 实际下发窗口的首行，客户端
 *   `hasOlderRows` 恒为 false），行上的 `actions` 一律清空，命令目标只能在补全后按全序行号解析。
 * - 窗口态 → 权威态是整份原子替换，没有中间态；两态之间到达的 online delta 不得丢失。
 * - 首帧 config 只读持久化事实，**不伪造 runtime 能力**：拿不到的事实（如 thoughtLevels 属于当前
 *   provider registry）留空而不是猜。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import {
  COLD_WINDOW_MESSAGE_LIMIT,
  COLD_WINDOW_ROW_STRIDE,
  assignColdWindowRowIds,
  coldWindowRowId,
} from "../zcode-protocol-v4/cold-window-rows.js";

export {
  COLD_WINDOW_MESSAGE_LIMIT,
  COLD_WINDOW_ROW_STRIDE,
  assignColdWindowRowIds,
  coldWindowRowId,
};

/** `assignColdWindowRowIds` 的入参：窗口投影行 + 每条来源消息的全局序号 + 兜底序号。 */
export type ColdWindowRowIdAssignment = Parameters<typeof assignColdWindowRowIds>[0];
/** `coldWindowRowId` 的入参三元组：会话消息总数、消息全局序号、消息内行序。 */
export type ColdWindowRowIdOrdinal = Parameters<typeof coldWindowRowId>;
/** 窗口态行号是会话的稳定属性（只由消息序号与消息内行序决定），与窗口边界无关。 */
export type ColdWindowRowAssignments = ReturnType<typeof assignColdWindowRowIds>;

/**
 * 首帧 config 种子的真实实现（`../zcode-protocol/cold-open-config-seed.js`）。
 *
 * 这里只引类型不引值：那份实现的导入链会牵出整个 `server-operations`（bootstrap 主体），
 * 而契约只需要它的签名；值引用会把这份重量带给每个只想要类型的调用方。
 */
export type BuildPersistedSessionConfigSeed =
  typeof import("../zcode-protocol/cold-open-config-seed.js").buildPersistedSessionConfigSeed;
/** 首帧 config 种子；`null` 表示持久化事实里一条都取不到（调用方不落下任何猜测值）。 */
export type PersistedSessionConfigSeed = Awaited<ReturnType<BuildPersistedSessionConfigSeed>>;

/**
 * 模块对外契约面。三个意图都是纯计算/纯读，不落任何状态；真实实现分别在
 * `../zcode-protocol-v4/cold-window-rows.js` 与 `../zcode-protocol/cold-open-config-seed.js`。
 */
export interface ColdOpenWindowContract {
  /**
   * 窗口态行号：`-((totalCount - ordinal + 1) * STRIDE) + indexWithinMessage`。
   *
   * 前置：`ordinal` 是消息在会话规范顺序里的 1-based 全局序号（`sequence - minSequence + 1`），
   * `indexWithinMessage` 是该行在来源消息内的 0-based 行序。
   * 后置：返回负数；同参数恒等（纯函数，可重复调用）。不产生事件、不持久化。
   */
  coldWindowRowId(totalCount: number, ordinal: number, indexWithinMessage: number): number;

  /**
   * 把一份尾部窗口的投影行整批改写成窗口态行号。
   *
   * 前置：`rows` 是投影内部 1..k 升序编号的行；`ordinalByMessageId` 与窗口消息切片同源。
   * 后置：返回值行号全部为负数、保持升序、`actions` 一律为 `undefined`；原 `rows` 不被就地改写。
   * 幂等：纯函数、不改外部状态。缺来源消息锚点的行并入当前消息区间继续编号，不破升序。
   * 不产生事件、不持久化。
   */
  assignColdWindowRowIds(input: ColdWindowRowIdAssignment): ConversationRow[];

  /**
   * 首帧 config 种子：从持久化事实（`runtime/model_selection` entry + transcript 末条 assistant
   * 的 mode）取值。
   *
   * 前置：`messages` 是本次读到的那批消息；宿主没有 `sessionEntry` 能力时直接返回 `null`。
   * 后置：一条持久化事实都取不到时返回 `null`（不猜默认值）；`thoughtLevels` 恒不填充。
   * 幂等：纯读。不产生事件、不写持久化——补全后由 runtime 真值覆盖。
   */
  buildPersistedSessionConfigSeed(
    ...args: Parameters<BuildPersistedSessionConfigSeed>
  ): Promise<PersistedSessionConfigSeed>;
}
