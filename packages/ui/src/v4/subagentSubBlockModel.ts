/**
 * 左栏父条目下方「子代理子区块」的行模型。
 *
 * spec: apps/zcode-cli/packages/core/spec/subagent-session-as-first-class.md 的「左栏任务列表：层级态」。
 *
 * 两份数据来自两个 owner，这里只做合并与排序，不做取数：
 * - `running`：父会话 conversation 投影 `snapshot.subagents.running`（运行的唯一权威）。
 * - `endedItems` / `endedTotal`：`session/subagents` 的 ended 分页（`endedTotal` 走投影，不靠分页条数）。
 *
 * 纯函数模块：不 import React，只做类型层面的依赖，node:test 能直接跑。
 */
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";
import type { SubagentLifecycleStatus } from "@/v4/subagentLifecycleStatus.js";

export interface SubagentSubBlockRow {
  childSessionId: string;
  title: string;
  subagentType: string;
  /** 七态原值，供图标选形。 */
  status: SubagentLifecycleStatus;
  /** 区块行只画图标，状态词由 aria-label 消费；七态复用 `subagentDirectory.status.*`。 */
  statusMessageId: string;
}

export interface SubagentSubBlockModel {
  rows: SubagentSubBlockRow[];
  /** 未显示出来的已结束子代理数，0 表示不渲染「还有 N 个」那一行。 */
  hiddenEndedCount: number;
}

/** 缺 `startedAt` 的历史行排最后：没有时间不等于"很久以前"，但排在末尾比排在最前更接近用户预期。 */
function compareStartedAtDesc(left: { startedAt?: number }, right: { startedAt?: number }): number {
  const leftAt = left.startedAt;
  const rightAt = right.startedAt;
  if (leftAt === undefined && rightAt === undefined) return 0;
  if (leftAt === undefined) return 1;
  if (rightAt === undefined) return -1;
  return rightAt - leftAt;
}

function toRow(item: {
  childSessionId: string;
  title: string;
  subagentType: string;
  status: SubagentLifecycleStatus;
}): SubagentSubBlockRow {
  return {
    childSessionId: item.childSessionId,
    title: item.title,
    subagentType: item.subagentType,
    status: item.status,
    statusMessageId: `subagentDirectory.status.${item.status}`,
  };
}

export function buildSubagentSubBlockRows(options: {
  running: readonly RunningSubagentSummary[];
  endedItems: readonly ZCodeSessionEndedSubagent[];
  /** 已结束子代理的总数（投影 `endedTotal`），可能大于已加载的 `endedItems`。 */
  endedTotal: number;
  /** 区块里最多显示多少个已结束子代理；运行中的不受它限制。 */
  limit: number;
}): SubagentSubBlockModel {
  const running = [...options.running].sort(compareStartedAtDesc);
  const runningIds = new Set(running.map((item) => item.childSessionId));
  // 投影的脉动点比 ended 分页新：同一个子会话短暂地同时出现在两处时以投影为准，
  // 否则区块里会出现两行相同 childSessionId（React key 也会重）。
  const ended = options.endedItems
    .filter((item) => !runningIds.has(item.childSessionId))
    .sort(compareStartedAtDesc);
  const shownEnded = ended.slice(0, Math.max(0, Math.trunc(options.limit)));

  return {
    rows: [...running.map(toRow), ...shownEnded.map(toRow)],
    // 「还有 N 个」用总数减已显示数：分页条数可能少于总数，条数当总数会把 N 算小。
    hiddenEndedCount: Math.max(0, options.endedTotal - shownEnded.length),
  };
}
