// 冷打开窗口态的行号换算（spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md）。
//
// 背景：窗口态首帧的投影只灌入尾部窗口，投影内部按 1..k 连续编号；补全后同一 publisher
// 被全量重放原子替换，行号变成全序 1..N。两代行号不能混用：窗口行若沿用投影局部编号，
// 会与权威全序撞号（同一个 rowId 在两代指向不同行），客户端也无法识别手里的是「临时窗口」。
// 因此窗口态行号使用负数空间：
//
//   rowId = -((totalCount - ordinal + 1) * STRIDE) + indexWithinMessage
//
// - `ordinal` 是消息在会话规范顺序里的 1-based 全局序号（= sequence - minSequence + 1），
//   只由 store 的 COUNT/MIN(sequence) 元信息与窗口片自身给出，不需要读全表；
// - `indexWithinMessage` 是该行在其来源消息内的 0-based 行序号；
// - 因此行号只由「消息序号 + 消息内行序」决定，是会话的稳定属性，与窗口无关。
//
// 窗口态是纯预览（spec §A）：客户端在这一阶段不提供更早历史——snapshot 的
// `rows.firstRowId` 就是窗口自身首行，客户端 `hasOlderRows` 恒为 false。所以本空间
// 只需要「跨帧稳定」「与权威行号不撞号」「能被客户端识别为窗口态」三条性质，负数同时满足。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * 单条消息的行号跨度。消息内行数远小于它（一条消息最多几十行），
 * 因此不同消息的行号区间天然不重叠。
 */
export const COLD_WINDOW_ROW_STRIDE = 100_000;

/** 窗口态首帧读取的尾部消息条数：wire 只发尾部 60 行，这里留足余量以覆盖整轮。 */
export const COLD_WINDOW_MESSAGE_LIMIT = 120;

export function coldWindowRowId(
  totalCount: number,
  ordinal: number,
  indexWithinMessage: number,
): number {
  return -((totalCount - ordinal + 1) * COLD_WINDOW_ROW_STRIDE) + indexWithinMessage;
}

/**
 * 把窗口投影的行（投影内部 1..k 连续编号、升序）改写成窗口态负数行号。
 *
 * - `ordinalByMessageId` 给出每个来源消息的全局序号（来自窗口消息切片）；
 * - 行没有来源消息锚点（非 message 事件产出的行）时并入当前消息区间继续编号，
 *   保持升序不破；
 * - 行上的 actions 一律清空：窗口态行号只是临时代数，命令目标在补全后按全序行号
 *   重新解析，窗口态也不具备「是否最新一轮」的全序上下文，不能下发可点的动作位。
 */
export function assignColdWindowRowIds(input: {
  rows: readonly ConversationRow[];
  totalCount: number;
  ordinalByMessageId: ReadonlyMap<string, number>;
  messageIdOf: (row: ConversationRow) => string | null;
  fallbackOrdinal: number;
}): ConversationRow[] {
  let ordinal = input.fallbackOrdinal;
  let indexWithinMessage = 0;
  return input.rows.map((row) => {
    const messageId = input.messageIdOf(row);
    const rowOrdinal = messageId === null ? undefined : input.ordinalByMessageId.get(messageId);
    if (rowOrdinal !== undefined && rowOrdinal !== ordinal) {
      ordinal = rowOrdinal;
      indexWithinMessage = 0;
    }
    const rowId = coldWindowRowId(input.totalCount, ordinal, indexWithinMessage);
    indexWithinMessage += 1;
    return { ...row, rowId, actions: undefined } as ConversationRow;
  });
}
