/**
 * subagent-pane-ui 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 *
 * 三段对应卡片的三个真实用途：①左栏子区块的行模型；②会话面板读形态能力位；③行身份空间翻转。
 * 组件用法（`SubagentSubBlock` / `SubagentStatusIcon` / `SubagentOpenProvider`）见各实现文件与
 * contract.ts 的 props 契约。
 */
import type { ConversationRow } from "@zcode/shared/zcode-protocol-v4";
import { createElement } from "react";
import { SubagentSubBlock } from "@/v4/SubagentSubBlock.js";
import { SubagentStatusIcon } from "@/v4/SubagentStatusIcon.js";
import {
  buildSubagentSubBlockRows,
  didRowIdentitySpaceFlip,
  resolveRowSpaceFlipScrollTop,
  resolveSessionPaneCapabilities,
  type RowSpaceBaseline,
  type SubagentSubBlockProps,
} from "./contract.js";

/** ① 左栏子区块：两种数据合成一份渲染输入，组件只画、不再算数。 */
export const subagentSubBlockModel = buildSubagentSubBlockRows({
  running: [
    {
      childSessionId: "child-1",
      subagentType: "Explore",
      title: "查找截断徽标的实现",
      status: "running",
      startedAt: 1_700_000_000_000,
    },
  ],
  endedItems: [
    {
      childSessionId: "child-0",
      subagentType: "general-purpose",
      title: "跑一遍单测",
      status: "success",
      startedAt: 1_699_000_000_000,
    },
  ],
  // 「还有 N 个」用投影总数，不是分页条数。
  endedTotal: 9,
  limit: 8,
});

/** 子区块的 props：workspace 坐标由调用方给（左栏是跨 workspace 混排视图）。 */
export const subagentSubBlockProps = {
  workspacePath: "/repo",
  parentSessionId: "session-1",
} satisfies SubagentSubBlockProps;

export const subagentSubBlockElement = createElement(SubagentSubBlock, subagentSubBlockProps);

/** 行图标：这一处图标是唯一的状态指示，所以给 label。 */
export const statusIconElement = createElement(SubagentStatusIcon, {
  status: "waiting",
  label: "等待确认",
});

/** ② 会话面板形态 → 能力位（`readOnly` 只是其中一列）。 */
const subagentChildPane = resolveSessionPaneCapabilities("subagentChild");
export const panePermissions = {
  readOnly: subagentChildPane.readOnly,
  composer: subagentChildPane.composer,
  editRetry: subagentChildPane.editRetry,
  fork: subagentChildPane.fork,
  permissionModeSelector: subagentChildPane.permissionModeSelector,
};

/** ③ 行身份空间翻转：每 commit 末记基线，翻转那一帧按 turn key 重锚定。 */
const flippedBaseline: RowSpaceBaseline = {
  coldWindow: true,
  anchor: { key: "turn-42", offsetTop: 120 },
};
const authoritativeRows = [{ rowId: 41 }, { rowId: 42 }] as ConversationRow[];
export const flipScrollTop = didRowIdentitySpaceFlip(flippedBaseline, authoritativeRows)
  ? resolveRowSpaceFlipScrollTop(flippedBaseline.anchor, { start: 6400 })
  : null;
