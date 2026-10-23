// cold-open-window 契约测试：窗口态行号空间的两条不变量（负数空间、跨帧稳定、actions 清空）。
// 只 import 本模块自己的文件（契约 + 实现），不依赖任何其它模块的实现。
import { describe, expect, it } from "vitest";
import {
  COLD_WINDOW_ROW_STRIDE,
  assignColdWindowRowIds,
  coldWindowRowId,
  type ColdWindowRowIdAssignment,
} from "../../src/cold-open-window/contract.js";

/** 行类型直接取自契约入参，避免另引一份 schema（测试不依赖实现之外的形状来源）。 */
type ColdWindowRow = ColdWindowRowIdAssignment["rows"][number];

function reasoningRow(input: {
  rowId: number;
  turnId: string;
  text: string;
  actions?: ColdWindowRow["actions"];
}): ColdWindowRow {
  return {
    rowId: input.rowId,
    turnId: input.turnId,
    createdAt: 1,
    createdAtSeq: 1,
    kind: "reasoning",
    text: input.text,
    state: "complete",
    ...(input.actions ? { actions: input.actions } : {}),
  };
}

describe("窗口态行号空间", () => {
  it("落在负数空间，且只由消息全局序号与消息内行序决定（跨帧稳定）", () => {
    const totalCount = 10;
    const firstMessageFirstRow = coldWindowRowId(totalCount, 1, 0);
    // 序号 1 是会话最早的消息：它是该空间里最负的一个（离 0 最远）。
    expect(firstMessageFirstRow).toBe(-totalCount * COLD_WINDOW_ROW_STRIDE);
    // 消息内行序只是区间内偏移，不跨消息。
    expect(coldWindowRowId(totalCount, 1, 3)).toBe(firstMessageFirstRow + 3);
    // 相邻消息的区间相差一个 STRIDE，永不重叠。
    expect(coldWindowRowId(totalCount, 2, 0)).toBe(firstMessageFirstRow + COLD_WINDOW_ROW_STRIDE);
    // 最后一条消息落在 -STRIDE（仍是负数）。
    expect(coldWindowRowId(totalCount, totalCount, 0)).toBe(-COLD_WINDOW_ROW_STRIDE);
    for (const ordinal of [1, 5, totalCount]) {
      expect(coldWindowRowId(totalCount, ordinal, 0)).toBeLessThan(0);
      // 同参数重复调用恒等：窗口边界变化不改变行号。
      expect(coldWindowRowId(totalCount, ordinal, 0)).toBe(coldWindowRowId(totalCount, ordinal, 0));
    }
  });

  it("整批改写：全部为负、保持升序、actions 清空，且不就地改写输入行", () => {
    const rows = [
      reasoningRow({
        rowId: 1,
        turnId: "turn-a",
        text: "先想",
        actions: { canFork: true, canEdit: true },
      }),
      reasoningRow({ rowId: 2, turnId: "turn-a", text: "再想" }),
      reasoningRow({ rowId: 3, turnId: "turn-a", text: "继续" }),
    ];

    const assigned = assignColdWindowRowIds({
      rows,
      totalCount: 10,
      ordinalByMessageId: new Map([["msg-a", 9]]),
      messageIdOf: (row) => (row.turnId === "turn-a" ? "msg-a" : null),
      fallbackOrdinal: 9,
    });

    expect(assigned.map((row) => row.rowId)).toEqual([
      coldWindowRowId(10, 9, 0),
      coldWindowRowId(10, 9, 1),
      coldWindowRowId(10, 9, 2),
    ]);
    expect(assigned.every((row) => row.rowId < 0)).toBe(true);
    // 窗口态行号是临时代数：命令目标只能在补全后按全序行号解析，动作位必须清空。
    expect(assigned.map((row) => row.actions)).toEqual([undefined, undefined, undefined]);
    // 原行不被就地改写（同一批行可能要按别的窗口复用）。
    expect(rows.map((row) => row.rowId)).toEqual([1, 2, 3]);
    expect(rows[0]?.actions).toEqual({ canFork: true, canEdit: true });
  });

  it("缺来源消息锚点的行并入当前消息区间继续编号，不破升序", () => {
    const rows = [
      reasoningRow({ rowId: 1, turnId: "turn-a", text: "a" }),
      reasoningRow({ rowId: 2, turnId: "turn-b", text: "b" }),
      reasoningRow({ rowId: 3, turnId: "turn-b", text: "c" }),
    ];

    const assigned = assignColdWindowRowIds({
      rows,
      totalCount: 10,
      ordinalByMessageId: new Map([["msg-b", 9]]),
      // 第一行没有来源消息锚点 → 沿用 fallbackOrdinal，第二行切到 msg-b 的序号。
      messageIdOf: (row) => (row.turnId === "turn-b" ? "msg-b" : null),
      fallbackOrdinal: 8,
    });

    expect(assigned.map((row) => row.rowId)).toEqual([
      coldWindowRowId(10, 8, 0),
      coldWindowRowId(10, 9, 0),
      coldWindowRowId(10, 9, 1),
    ]);
    expect(assigned[0]!.rowId).toBeLessThan(assigned[1]!.rowId);
    expect(assigned[1]!.rowId).toBeLessThan(assigned[2]!.rowId);
  });
});
