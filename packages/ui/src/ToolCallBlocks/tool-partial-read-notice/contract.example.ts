/**
 * tool-partial-read-notice 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 这是 Read 卡实际做的三件事：算范围、算徽标、把两者交给卡片。Search 卡把
 * `resolveReadRange` 换成 `resolveSearchRange`，其余逐字相同。
 */
import { createElement } from "react";

import type { TaskChatToolCall } from "@/lib/taskChatMessageTypes.js";
import { TruncationNoticeChip } from "@/ToolCallBlocks/TruncationNoticeChip.js";
import {
  detectTruncationNotice,
  formatReadRangeLabel,
  resolveOutputText,
  resolveReadRange,
} from "./contract.js";

/** 卡片拿到的调用快照就长这样：`input` 是结构化直传，`output` 是已落库的输出文本。 */
const readCall = {
  input: { offset: 2001, limit: 2000 },
  output: "<system-reminder>Showing a partial view of lines 2001-4000 of 9000.</system-reminder>",
} satisfies Pick<TaskChatToolCall, "input" | "output">;

/** ① 范围：输出标记优先，input.offset/limit 只作兜底；返回 null = 整读，卡片不显示范围。 */
const range = resolveReadRange(readCall.input, resolveOutputText(readCall));

/** ② 徽标：单卡最多一枚，按固定优先级取第一个命中；返回 null = 不渲染徽标。 */
const notice = detectTruncationNotice(readCall);

/** ③ 渲染：范围并入路径行（secondaryText），徽标挂状态区。 */
export const readCardParts = {
  rangeLabel: range ? formatReadRangeLabel(range, () => "第 2001–4000 行") : undefined,
  noticeChip: notice ? createElement(TruncationNoticeChip, { notice }) : undefined,
};
