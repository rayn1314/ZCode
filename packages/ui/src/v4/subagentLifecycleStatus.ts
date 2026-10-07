/**
 * 子代理生命周期的七态：运行三态（父会话投影 `snapshot.subagents.running`）
 * + 结束四态（`session/subagents` 的 ended 分页）。
 *
 * 单独成模块（而不是挂在左栏区块模型或状态图标上）：它是这两处共用的词汇，
 * 图标组件与行模型都不应该成为对方的依赖。纯类型，无运行时依赖。
 */
import type { ZCodeSessionEndedSubagent } from "@zcode/shared";
import type { RunningSubagentSummary } from "@zcode/shared/zcode-protocol-v4";

export type SubagentLifecycleStatus =
  | RunningSubagentSummary["status"]
  | ZCodeSessionEndedSubagent["status"];
