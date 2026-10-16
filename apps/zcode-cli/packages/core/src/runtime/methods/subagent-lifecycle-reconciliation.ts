// ============================================================
// 子代理生命周期孤儿对账（spec core/spec/subagent-lifecycle-orphan-reconciliation.md）
// ============================================================
//
// 宿主进程异常退出（崩溃 / 被强杀 / 重启）时，正在跑的子代理不会再有结算机会：runner 的
// catch / finalize 随进程消失，`SubagentStopped` 永不落盘，`runtime/subagent_lifecycle` entry
// 就停在「只有 spawn」的形态。roster 读它只能报 `lost`（记录没有结尾），而这条 lost 会**永久
// 悬挂**——既没有真相，也没有任何机制去认领它。
//
// 对账在**本进程接管会话**（`resumeFromStore`）时执行：这符合 session owner 语义（接管即负责），
// 且按 (sessionID, type) 索引读取是低基数操作。刻意不做进程启动全库扫描——那既贵，也会把同机
// 其他实例正在跑的会话误判成孤儿。

import {
  createSessionEvent,
  mapSubagentLifecycleStatus,
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  SessionEventType,
  type SessionEntryInfo,
} from "@zcode/contracts";
import { traceContextToLogContext } from "../deps.js";
import type { TraceContext } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import {
  buildSubagentLifecycleEntry,
  readLifecycleData,
} from "./subagent-lifecycle-persistence.js";

/** 对账落定的状态词：这一轮因宿主进程死亡而中断，没有任何结果可收。 */
const INTERRUPTED_LIFECYCLE_STATUS = "interrupted";

/**
 * 本进程开始接管会话的最早时刻（本模块在进程启动链上加载，早于任何接管）。
 * 早于它写入的 entry 不可能是本进程写的——这道判据把「本进程刚派发、注册表里暂时查不到」的
 * 窗口也挡在孤儿判定之外。
 */
const PROCESS_TAKEOVER_FLOOR_MS = Date.now();

/**
 * 认领本会话里被上一个进程丢下的子代理孤儿行，返回本次认领条数。
 *
 * 判据三条同时成立：roster 会把它显示成 `lost`、本进程注册表没有它、且它早于本进程接管时刻。
 * 写回复用 `buildSubagentLifecycleEntry`——生命周期 entry 只有这一条构造路径。
 */
export async function reconcileOrphanedSubagentLifecycles(
  this: AgentRuntimeInternal,
  traceContext: TraceContext,
): Promise<number> {
  const store = this.sessionStore;
  // 宿主的 session entry 能力缺席：既读不到也写不了，静默跳过（能力缺席不是故障）。
  const sessionEntries = store?.sessionEntries;
  const saveSessionEntry = store?.saveSessionEntry;
  if (!store || !sessionEntries || !saveSessionEntry) return 0;

  let entries: readonly SessionEntryInfo[];
  try {
    entries = await sessionEntries.call(store, {
      sessionID: this.sessionId,
      type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    });
  } catch (error) {
    // 读失败只降级：对账是收尾工作，不能阻断会话恢复；下次接管再试。
    this.logger?.warn("Failed to read subagent lifecycle entries for reconciliation", {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "subagent_lifecycle.reconcile_read_failed",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "failed",
    });
    return 0;
  }

  let reconciled = 0;
  for (const entry of entries) {
    const agentId = reconcileableOrphanAgentId(entry, this);
    if (!agentId) continue;
    try {
      // 伪事件只为复用唯一构造路径（不 append 到事件流）：`endedAt` 落在「检测到中断」的时刻——
      // 真实死亡时刻没有任何进程记录过，这是它的上界。
      const reconciledEntry = buildSubagentLifecycleEntry({
        event: createSessionEvent(
          SessionEventType.SubagentStopped,
          this.sessionId,
          { agentId, status: INTERRUPTED_LIFECYCLE_STATUS },
          { traceId: traceContext.traceId },
        ),
        existing: entry,
      });
      if (!reconciledEntry) continue;
      await saveSessionEntry.call(store, reconciledEntry);
      reconciled += 1;
    } catch (error) {
      // 单行写失败只跳过该行，其余继续；该行下次接管时重试（对账幂等）。
      this.logger?.warn("Failed to persist reconciled subagent lifecycle entry", {
        ...traceContextToLogContext(traceContext),
        agentId,
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "subagent_lifecycle.reconcile_write_failed",
        module: "core.runtime",
        sessionId: this.sessionId,
        status: "failed",
      });
    }
  }

  if (reconciled > 0) {
    this.logger?.info("Reconciled orphaned subagent lifecycle entries", {
      ...traceContextToLogContext(traceContext),
      count: reconciled,
      event: "subagent_lifecycle.orphans_reconciled",
      module: "core.runtime",
      sessionId: this.sessionId,
      status: "completed",
    });
  }
  return reconciled;
}

/**
 * 该行是否是需要认领的孤儿；是则返回 agentId。
 *
 * 第一条判据复用 roster 的状态映射（`=== "lost"`）：它同时覆盖「只有 spawn」这种正常孤儿，以及
 * 「status 是终态词却没有 endedAt」「有 endedAt 但 status 还是 running」两类脏数据——判据只有
 * 一份，不会和 roster 的显示结果分叉。
 */
function reconcileableOrphanAgentId(
  entry: SessionEntryInfo,
  runtime: AgentRuntimeInternal,
): string | undefined {
  const facts = readLifecycleData(entry);
  if (!facts) return undefined;
  if (mapSubagentLifecycleStatus(facts.status) !== "lost") return undefined;
  // 活体豁免：注册表里有它就归 runner 管，对账不得越权改写。
  if (runtime.runtimeTaskRegistry.get(facts.agentId)) return undefined;
  // 本进程写入豁免：晚于接管时刻的行是本进程的手笔，只可能是正在跑的活体。
  if (entry.time.updated >= PROCESS_TAKEOVER_FLOOR_MS) return undefined;
  return facts.agentId;
}
