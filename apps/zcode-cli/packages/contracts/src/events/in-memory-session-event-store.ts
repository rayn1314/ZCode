import type { SessionEventStorePort, SessionEventStoreStats } from "../interfaces/session.port.js";
import type { SessionId } from "../interfaces/shared.js";
import type { SessionEvent } from "./session.events.js";
import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SEALED_TURN_TRANSIENT_GRACE_MS,
  slimRetainedModelRequest,
  TRANSIENT_TURN_ROW_LIMIT,
  type SessionEventRetentionMode,
  type SessionEventRetentionPolicy,
} from "./session-event-retention.js";

export interface InMemorySessionEventStoreOptions {
  /** 默认 `turn-window`；`unbounded` 供回滚与对照测试。也可注入自定义策略工厂（按 session 创建）。 */
  retention?: SessionEventRetentionMode | (() => SessionEventRetentionPolicy);
  /** 供测试注入的时钟；生产用 Date.now。 */
  now?: () => number;
}

interface SessionEventState {
  events: SessionEvent[];
  latestSequenceNumber: number;
  policy: SessionEventRetentionPolicy;
  evictedEvents: number;
  mergedEvents: number;
  /** 每 turn 瞬态行数（O(1) 增量维护）：单 turn 行数兜底的触发器，避免每条 delta 全表扫描。 */
  transientRowsByTurn: Map<string, number>;
}

/**
 * 进程内 session event store。
 *
 * 它是 live / replay / snapshot 序号的唯一来源，因此所有事件都经 `append` 分配 seq；
 * 但瞬态事件只按 turn 窗口驻留，已完成并被下一 turn 取代的桶会从内存淘汰。
 * append 若每次全量拷贝数组且永不淘汰，长会话内存就会按 token 线性增长。
 */
export class InMemorySessionEventStore implements SessionEventStorePort {
  private readonly sessions = new Map<SessionId, SessionEventState>();
  private readonly createPolicy: () => SessionEventRetentionPolicy;
  private readonly now: () => number;

  constructor(options: InMemorySessionEventStoreOptions = {}) {
    const retention = options.retention ?? "turn-window";
    this.createPolicy =
      typeof retention === "function"
        ? retention
        : () => createSessionEventRetentionPolicy(retention);
    this.now = options.now ?? (() => Date.now());
  }

  private stateFor(sessionId: SessionId): SessionEventState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        events: [],
        latestSequenceNumber: 0,
        policy: this.createPolicy(),
        evictedEvents: 0,
        mergedEvents: 0,
        transientRowsByTurn: new Map(),
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  async append(event: SessionEvent): Promise<SessionEvent> {
    const state = this.stateFor(event.sessionId);
    const sequenceNumber =
      event.sequenceNumber > 0 ? event.sequenceNumber : state.latestSequenceNumber + 1;
    // 计数器只增不减：淘汰不能让后续 getLatestSequenceNumber()+1 生成重复 seq。
    state.latestSequenceNumber = Math.max(state.latestSequenceNumber, sequenceNumber);
    const storedEvent = { ...event, sequenceNumber };
    state.events.push(storedEvent);
    const evictTurnIds = state.policy.onAppend(storedEvent, this.now());
    if (evictTurnIds.length > 0) {
      this.evictTransientEvents(state, new Set(evictTurnIds));
    }
    // 只有瞬态事件可能让某个 turn 的瞬态行数越线；非瞬态 append 走快路径，不做扫描。
    if (isTransientSessionEvent(storedEvent)) {
      if (storedEvent.turnId) {
        state.transientRowsByTurn.set(
          String(storedEvent.turnId),
          (state.transientRowsByTurn.get(String(storedEvent.turnId)) ?? 0) + 1,
        );
      }
      this.trimOversizedTurnRows(state);
    }
    return storedEvent;
  }

  /**
   * 单 turn 瞬态行数兜底：同一 part 的连续 delta 合并成一条（`delta` 拼接，文本不变），
   * 合并后仍超目标的 turn 从最旧侧淘汰冗余瞬态行。规则见 `trimOversizedTurns`。
   *
   * 用 `transientRowsByTurn` 做 O(1) 触发器：任何 turn 的瞬态行数 > 上限才全表扫描；
   * 快路径（正常会话）每条 append 只摊一个 Map get/set。
   */
  private trimOversizedTurnRows(state: SessionEventState): void {
    if (state.policy.trimOversizedTurns === undefined) {
      return;
    }
    let oversizedTurnExists = false;
    for (const rows of state.transientRowsByTurn.values()) {
      if (rows > TRANSIENT_TURN_ROW_LIMIT) {
        oversizedTurnExists = true;
        break;
      }
    }
    if (!oversizedTurnExists) {
      return;
    }
    const plans = state.policy.trimOversizedTurns(state.events);
    if (plans.length === 0) {
      return;
    }
    const mergedByEventId = new Map<string, SessionEvent>();
    const removedEventIds = new Set<string>();
    for (const plan of plans) {
      for (const [id, merged] of plan.mergedByEventId) {
        mergedByEventId.set(id, merged);
      }
      for (const id of plan.removedEventIds) {
        removedEventIds.add(id);
      }
      state.evictedEvents += plan.evictedEvents;
      state.mergedEvents += plan.mergedEvents;
    }
    const retained: SessionEvent[] = [];
    for (const event of state.events) {
      const id = String(event.id);
      if (removedEventIds.has(id)) {
        continue;
      }
      retained.push(mergedByEventId.get(id) ?? event);
    }
    state.events = retained;
    this.recomputeTransientRowsByTurn(state);
  }

  /** 全表重建后（淘汰 / 合并）同步每 turn 瞬态行数。 */
  private recomputeTransientRowsByTurn(state: SessionEventState): void {
    state.transientRowsByTurn.clear();
    for (const event of state.events) {
      if (isTransientSessionEvent(event) && event.turnId) {
        state.transientRowsByTurn.set(
          String(event.turnId),
          (state.transientRowsByTurn.get(String(event.turnId)) ?? 0) + 1,
        );
      }
    }
  }

  /**
   * 时间兜底（由 60s 低频 tick 调用）：淘汰结束超过 grace 且没有后继 turn 的 sealed turn 的瞬态事件。
   * 覆盖 subagent 子 session 这类一次性 session。返回本次淘汰条数。
   */
  pruneTransientEvents(
    nowMs: number = this.now(),
    graceMs: number = SEALED_TURN_TRANSIENT_GRACE_MS,
  ): number {
    let evicted = 0;
    for (const state of this.sessions.values()) {
      const expired = state.policy.collectExpired(nowMs, graceMs);
      if (expired.length === 0) {
        continue;
      }
      const before = state.evictedEvents;
      this.evictTransientEvents(state, new Set(expired));
      evicted += state.evictedEvents - before;
    }
    return evicted;
  }

  private evictTransientEvents(state: SessionEventState, turnIds: ReadonlySet<string>): void {
    const retained: SessionEvent[] = [];
    for (const event of state.events) {
      if (isTransientSessionEvent(event) && event.turnId && turnIds.has(event.turnId)) {
        state.evictedEvents += 1;
        continue;
      }
      // 同一淘汰节拍：已 sealed 且已持久化的 turn，其 model_request 只需保留元数据。
      retained.push(
        event.turnId && turnIds.has(event.turnId) ? slimRetainedModelRequest(event) : event,
      );
    }
    state.events = retained;
    this.recomputeTransientRowsByTurn(state);
  }

  async getEvents(sessionId: SessionId): Promise<SessionEvent[]> {
    return [...(this.sessions.get(sessionId)?.events ?? [])];
  }

  async getEventsAfter(sessionId: SessionId, sequenceNumber: number): Promise<SessionEvent[]> {
    return (this.sessions.get(sessionId)?.events ?? []).filter(
      (event) => event.sequenceNumber > sequenceNumber,
    );
  }

  async getLatestSequenceNumber(sessionId: SessionId): Promise<number> {
    return this.sessions.get(sessionId)?.latestSequenceNumber ?? 0;
  }

  async deleteSession(sessionId: SessionId): Promise<void> {
    this.sessions.delete(sessionId);
  }

  /** 供内存诊断日志读取驻留规模；只数长度，不拷贝。 */
  getStats(): SessionEventStoreStats {
    let events = 0;
    let evictedEvents = 0;
    let mergedEvents = 0;
    let retainedTransient = 0;
    for (const state of this.sessions.values()) {
      events += state.events.length;
      evictedEvents += state.evictedEvents;
      mergedEvents += state.mergedEvents;
      for (const event of state.events) {
        if (isTransientSessionEvent(event)) {
          retainedTransient += 1;
        }
      }
    }
    return { sessions: this.sessions.size, events, evictedEvents, mergedEvents, retainedTransient };
  }
}

export function createInMemorySessionEventStore(
  options?: InMemorySessionEventStoreOptions,
): InMemorySessionEventStore {
  return new InMemorySessionEventStore(options);
}
