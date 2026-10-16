// ============================================================
// Subagent Roster Port - 历史子代理的只读投影边界（bootstrap 实现）
// ============================================================
//
// 本端口补的是「进程内注册表重启后为空」这个缺口（spec D8）：由 bootstrap 从父会话的
// 持久化 session entry（`runtime/subagent_lifecycle`）读出历史子代理，core 只依赖端口、
// 不直接读会话存储。
//
// 只读不变式：实现不得写任何状态，也不得成为子代理生命周期的第二个真相源。
// `running` 永远只能由本进程的 runtimeTaskRegistry 断言——历史里只有 spawn、没有终态时
// 必须报 `lost`，不能报 `running`。契约层只描述语义，不承载 I/O。

import type { SessionId } from "./shared.js";
import type { SubagentTaskStatus } from "./subagent.port.js";

/**
 * 一行历史子代理。字段与 `ListAgentsAgent` 对齐（便于 core 直接合并），但**不含**
 * `source`——那是工具输出层的呈现字段，由 `ListAgents` 在合并时标注，投影方不该猜。
 */
export interface SubagentRosterEntry {
  agentId: string;
  childSessionId: string;
  agentType: string;
  description: string;
  /**
   * 终态词表与 `SubagentTaskStatus` 同集，但实现只会给出终态或 `lost`：
   * `running` 是进程内事实，历史投影无权断言。
   */
  status: SubagentTaskStatus;
  isBackgrounded: boolean;
  /** epoch ms；取该 agentId 首次 spawn 的时间，resume 不重置。 */
  startedAt: number;
  /** 有终态事件才有；仍只有 spawn 的条目缺席。 */
  endedAt?: number;
}

/**
 * entry 状态词 → `SubagentTaskStatus`：roster 投影与 core 孤儿对账**共用的单一实现**。
 *
 * entry 里存的是事件原词（core `runner.ts` 发 `completed`/`failed`/`stopped`，孤儿对账发
 * `interrupted`），`success`/`error` 是 UI 面已在用的同义词。
 *
 * 三条刻意对齐：
 * - `stopped` → `killed`：后台被 TaskStop 时活体注册表报 `killed`，而事件只带 `stopped`，
 *   同一个事实在两种来源下必须同一个词，以活体注册表为准。
 * - `running` → `lost`：本进程注册表缺席时无权断言 `running`，猜 running 会让模型去发一条
 *   永远送不到的消息。
 * - 认不出的词 → `lost`：把未知状态硬塞成 running/completed 等于替一个我们不认识的周期编造
 *   结论，`lost` 是唯一不需要额外假设的保守事实。
 *
 * 放在契约层而不是各实现里：core 的孤儿对账要靠 `=== "lost"` 判断「这行是否需要认领」，
 * bootstrap 的 roster 要靠它投影；两处各写一份就是「枚举副本静默失效」的老坑。
 */
export function mapSubagentLifecycleStatus(status: string | undefined): SubagentTaskStatus {
  switch (status) {
    case "completed":
    case "success":
      return "completed";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "stopped":
    case "killed":
      return "killed";
    case "interrupted":
      return "interrupted";
    default:
      return "lost";
  }
}

export interface SubagentRosterPort {
  /**
   * 按父会话列出历史子代理。父会话不在本进程（没有可读的会话存储）时返回空数组：
   * 那既不是故障也不是「没有历史子代理」，只是本端口看不到。
   * 真正的历史读取失败必须抛错——调用方据此标注「历史不可读」，不得静默当成空列表。
   */
  listByParentSession(
    parentSessionId: SessionId,
    options?: { signal?: AbortSignal },
  ): Promise<SubagentRosterEntry[]>;
}
