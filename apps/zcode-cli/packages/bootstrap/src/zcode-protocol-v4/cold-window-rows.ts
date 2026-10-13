// 冷打开窗口态的行号换算（spec: apps/zcode-cli/packages/bootstrap/spec/cold-open-window-first.md）。
//
// 背景：窗口态首帧的投影只灌入尾部窗口，投影内部按 1..k 连续编号；补全后同一 publisher
// 被全量重放原子替换，行号变成全序 1..N。两代行号不能混用，所以窗口态的「更早行」
// （由 store 分页供给）需要一个自带全序、且不依赖投影内部计数的编号空间：
//
//   rowId = -((totalCount - ordinal + 1) * STRIDE) + indexWithinMessage
//
// - `ordinal` 是消息在会话规范顺序里的 1-based 全局序号（= sequence - minSequence + 1），
//   只由 store 的 COUNT/MIN(sequence) 元信息与分页片自身给出，不需要读全表；
// - `indexWithinMessage` 是该行在其来源消息内的 0-based 行序号；
// - 因此行号只由「消息序号 + 消息内行序」决定，是会话的稳定属性，与窗口无关，
//   所以两页之间不会重叠、也不会留缝（页按 ordinal 递减）。
//
// 全序与「到顶」判定：本空间从最旧消息的 ordinal=1 起底，
// `coldWindowFirstRowId(totalCount)` 正好等于最旧消息首行的行号。客户端
// `hasOlderRows` = `window[0].rowId > firstRowId`，于是翻到会话开头时自动变为 false，
// 与完整态（全序 1）的行为一致。
//
// 窗口态是临时态：补全的 snapshot 会整体替换这些行号（客户端 snapshot 帧语义为整份替换），
// 所以这里的负数行号不会进入完整态 wire。
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";

/**
 * 单条消息的行号跨度。消息内行数远小于它（一条消息最多几十行），
 * 因此不同消息的行号区间天然不重叠。
 */
export const COLD_WINDOW_ROW_STRIDE = 100_000;

/** 窗口态首帧读取的尾部消息条数：wire 只发尾部 60 行，这里留足余量以覆盖整轮。 */
export const COLD_WINDOW_MESSAGE_LIMIT = 120;

/** 窗口态翻页一次读的消息条数（页按消息对齐，行数随内容浮动）。 */
export const COLD_WINDOW_PAGE_MESSAGE_LIMIT = 60;

export function coldWindowRowId(
  totalCount: number,
  ordinal: number,
  indexWithinMessage: number,
): number {
  return -((totalCount - ordinal + 1) * COLD_WINDOW_ROW_STRIDE) + indexWithinMessage;
}

/** 全序首行行号 = 窗口态「还有更早行」哨兵（也是翻到会话开头时的终止行号）。 */
export function coldWindowFirstRowId(totalCount: number): number {
  return coldWindowRowId(totalCount, 1, 0);
}

/**
 * 由游标行号反推「本行所属消息的全局序号」。分页语义是 `rowId < beforeRowId`，
 * 故下一页取 ordinal < 返回值的消息：返回的是 beforeRowId 所在消息的序号，
 * 该消息自身的其余行已被上一页取走。
 */
export function coldWindowOrdinalOfRow(rowId: number, totalCount: number): number {
  const distance = Math.ceil(-rowId / COLD_WINDOW_ROW_STRIDE);
  return totalCount - distance + 1;
}

/**
 * 把「一页消息合成出的行」（投影内部 1..m 连续编号、升序）改写成窗口态全序行号。
 *
 * - `ordinalByMessageId` 给出每个来源消息的全局序号（来自本页消息切片）；
 * - 行没有来源消息锚点（非 message 事件产出的行）时并入当前消息区间继续编号，
 *   保持升序不破；
 * - 行上的 actions 一律清空：窗口态行号只是临时代数，命令目标在补全后按全序行号
 *   重新解析，页内行也不具备「是否最新一轮」的全序上下文，不能下发可点的动作位。
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
