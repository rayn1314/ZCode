/**
 * cold-open-window 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 窗口态首帧下发前，先给投影里的行算一份负数行号空间——这是该模块最常见的一次调用。
 */
import { coldWindowRowId, type ColdOpenWindowContract } from "./contract.js";

/**
 * 把一份尾部窗口的消息序号映射到窗口态行号空间。
 *
 * 参数都是真实入参：`totalCount` 取自 store 的会话消息总数，`windowOrdinals` 是窗口内消息的
 * 1-based 全局序号（升序），`rowsPerMessage` 是每条消息产出的行数。
 */
export function exampleColdOpenWindowRows(input: {
  totalCount: number;
  windowOrdinals: readonly number[];
  rowsPerMessage: readonly number[];
}): number[] {
  const rowIds: number[] = [];
  input.windowOrdinals.forEach((ordinal, messageIndex) => {
    const rowCount = input.rowsPerMessage[messageIndex] ?? 0;
    for (let indexWithinMessage = 0; indexWithinMessage < rowCount; indexWithinMessage += 1) {
      rowIds.push(coldWindowRowId(input.totalCount, ordinal, indexWithinMessage));
    }
  });
  return rowIds;
}

/** 整批改写同一次窗口的投影行（行号全部落回负数空间）。 */
export function exampleAssignColdWindowRowIds(
  contract: Pick<ColdOpenWindowContract, "assignColdWindowRowIds">,
  input: Parameters<ColdOpenWindowContract["assignColdWindowRowIds"]>[0],
): ReturnType<ColdOpenWindowContract["assignColdWindowRowIds"]> {
  return contract.assignColdWindowRowIds(input);
}
