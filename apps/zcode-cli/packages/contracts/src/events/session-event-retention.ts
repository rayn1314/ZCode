import type { ModelStreamingKind, ModelStreamingPayload, SessionEvent } from "./session.events.js";
import { SessionEventType } from "./session.events.js";

/**
 * 与消息流同频的瞬态事件。
 * 它们仍经 event store 分配 seq 并交给 live sink，但 turn 结束并被下一 turn 取代后即可从内存淘汰：
 * 已完成 turn 的文本由持久化消息重新合成，reducer / rewind / fork / checkpoint 不消费这些类型。
 */
export const TRANSIENT_SESSION_EVENT_TYPES: ReadonlySet<SessionEventType> = new Set([
  SessionEventType.ModelStreaming,
  SessionEventType.ToolCallProgress,
  SessionEventType.StreamingToolLedgerUpdated,
  SessionEventType.ModelNetworkStatus,
]);

/**
 * sealed turn 没有后继 turn 时的时间兜底。
 * subagent 子 session 只有一个 turn，永远等不到下一个 turn_started，
 * 真机上一次子 session 留下约 1 万条 delta 直到 record 被池子回收；
 * 由 60s 采样节拍调用 `collectExpired`，超过 grace 的 sealed turn 一并淘汰。
 */
export const SEALED_TURN_TRANSIENT_GRACE_MS = 120_000;

export function isTransientSessionEvent(event: Pick<SessionEvent, "type">): boolean {
  return TRANSIENT_SESSION_EVENT_TYPES.has(event.type);
}

/**
 * sealed turn 淘汰时 `model_request` 驻留副本的元数据瘦身（spec 同上"model_request 元数据瘦身"）。
 * Bug 根因：`messages` 是每次模型请求的完整上下文，每个工具迭代一条且作为非瞬态永久驻留；
 * compact 只截断后续请求，不回收已驻留事件，长会话实测 event store 驻留随轮次线性涨约 150MB。
 * 内存 store 的读者只用 `messages.length`，live sink（debug JSONL）拿的是 append 返回的完整对象，
 * 因此只把驻留副本换成 `messageCount`，事件 id / seq / 其它 payload 字段保持不变。
 */
export function slimRetainedModelRequest(event: SessionEvent): SessionEvent {
  if (event.type !== SessionEventType.ModelRequest) {
    return event;
  }
  const payload = event.payload as { messages?: unknown } | null | undefined;
  if (!payload || !Array.isArray(payload.messages)) {
    return event;
  }
  const { messages, ...metadata } = payload;
  return { ...event, payload: { ...metadata, messageCount: messages.length } } as SessionEvent;
}

export type SessionEventRetentionMode = "unbounded" | "turn-window";

/**
 * 单 turn 驻留行数上限（spec 同上"单 turn 行数兜底"）。
 * turn 窗口只保证"最多两个 turn 的瞬态"，不限制单个 turn 有多长：重试退避会把一个 turn
 * 拖到数小时（真机实测单个 turn 9798s），期间流式 delta / 网络状态 / 工具进度只进不出，
 * 进程内 15 个 session 叠加实测 eventStore 驻留 27 万行 / 堆 380MB。
 */
export const TRANSIENT_TURN_ROW_LIMIT = 2_000;
/** 裁剪目标：低于触发线留滞后，避免每条 delta 都触发一次 O(n) 扫描。 */
export const TRANSIENT_TURN_ROW_TARGET = 1_000;

/**
 * 可合并的流式增量 kind。`start` / `text_start` / `text_end` 等边界 kind 不参与：
 * 冷恢复与子代理观察靠它们判断"这条消息有完整 live 流"。
 */
const MERGEABLE_STREAMING_KINDS: ReadonlySet<ModelStreamingKind> = new Set([
  "text_delta",
  "reasoning_delta",
  "tool_input_delta",
]);

function mergeableStreamingDelta(event: SessionEvent): ModelStreamingPayload | undefined {
  if (event.type !== SessionEventType.ModelStreaming) {
    return undefined;
  }
  const payload = event.payload as ModelStreamingPayload | null | undefined;
  if (!payload || payload.done === true || typeof payload.delta !== "string") {
    return undefined;
  }
  if (!payload.kind || !MERGEABLE_STREAMING_KINDS.has(payload.kind)) {
    return undefined;
  }
  return payload;
}

function sameStream(a: ModelStreamingPayload, b: ModelStreamingPayload): boolean {
  return (
    a.kind === b.kind &&
    a.assistantMessageId === b.assistantMessageId &&
    a.partId === b.partId &&
    a.toolCallId === b.toolCallId
  );
}

export interface OversizedTurnRowTrim {
  evictedEvents: number;
  /** 锚点事件 id → 合并后的事件；锚点本身的 seq / timestamp 不变。 */
  mergedByEventId: Map<string, SessionEvent>;
  mergedEvents: number;
  /** 被合并走或直接淘汰的事件 id。 */
  removedEventIds: Set<string>;
  turnId: string;
}

interface TurnTrimPlan {
  mergedByEventId: Map<string, SessionEvent>;
  removedEventIds: Set<string>;
  mergedEvents: number;
  evictedEvents: number;
}

/**
 * 单个 turn 的驻留行数兜底（纯函数，无 IO）。
 *
 * 两级处理，先保文本、后丢冗余：
 * 1. 把同一 part 的连续 delta 合并成一条（`delta` 拼接，文本不变）——重试拉长的 turn 里
 *    行数的大头是逐个 token 的 delta，合并后一个 part 只剩一行。
 * 2. 合并后仍超目标行数时，从最旧侧淘汰瞬态事件：先淘汰状态类（网络状态 / 工具进度 /
 *    runtime 账本，都是"最新态覆盖旧态"的冗余行），最后才动合并后的 delta 行。
 *
 * 非瞬态事件与 seq 计数器一律不动；被移除的行留下的 seq 空洞与既有淘汰一致（消费者按
 * `getLatestSequenceNumber` / `record.lastSeq` 取游标，不回退）。
 */
export function trimOversizedTurns(
  events: readonly SessionEvent[],
  limit: number = TRANSIENT_TURN_ROW_LIMIT,
  target: number = TRANSIENT_TURN_ROW_TARGET,
): OversizedTurnRowTrim[] {
  const plan = new Map<string, TurnTrimPlan>();
  const rowsByTurn = new Map<string, number>();
  for (const event of events) {
    if (!event.turnId || !isTransientSessionEvent(event)) {
      continue;
    }
    rowsByTurn.set(event.turnId, (rowsByTurn.get(event.turnId) ?? 0) + 1);
  }
  for (const [turnId, rows] of rowsByTurn) {
    if (rows <= limit) {
      continue;
    }
    const turnEvents: SessionEvent[] = [];
    for (const event of events) {
      if (event.turnId === turnId) {
        turnEvents.push(event);
      }
    }
    plan.set(turnId, planTurnTrim(turnEvents, target));
  }
  if (plan.size === 0) {
    return [];
  }
  return [...plan].map(([turnId, entry]) => ({ turnId, ...entry }));
}

function planTurnTrim(turnEvents: readonly SessionEvent[], target: number): TurnTrimPlan {
  const mergedByEventId = new Map<string, SessionEvent>();
  const removedEventIds = new Set<string>();
  let mergedEvents = 0;
  // 合并后仍存活的行（锚点或未参与合并的事件），按原顺序。
  const survivors: SessionEvent[] = [];

  let index = 0;
  while (index < turnEvents.length) {
    const event = turnEvents[index]!;
    const payload = mergeableStreamingDelta(event);
    if (!payload) {
      survivors.push(event);
      index += 1;
      continue;
    }
    let end = index + 1;
    let delta = payload.delta;
    while (end < turnEvents.length) {
      const next = turnEvents[end]!;
      const nextPayload = mergeableStreamingDelta(next);
      if (!nextPayload || !sameStream(nextPayload, payload)) {
        break;
      }
      delta += nextPayload.delta;
      removedEventIds.add(String(next.id));
      mergedEvents += 1;
      end += 1;
    }
    survivors.push(end - index > 1 ? { ...event, payload: { ...payload, delta } } : event);
    if (end - index > 1) {
      mergedByEventId.set(String(event.id), survivors[survivors.length - 1]!);
    }
    index = end;
  }

  // 仍超目标：先淘汰状态类瞬态，再淘汰 delta 行；都从最旧侧开始。
  let evictedEvents = 0;
  let remainingTransient = survivors.filter(isTransientSessionEvent).length;
  const overTarget = (): boolean => remainingTransient > target;
  for (const allowStreaming of [false, true]) {
    for (let i = 0; i < survivors.length && overTarget(); i += 1) {
      const candidate = survivors[i]!;
      if (removedEventIds.has(String(candidate.id))) {
        continue;
      }
      if (!isTransientSessionEvent(candidate)) {
        continue;
      }
      if (!allowStreaming && candidate.type === SessionEventType.ModelStreaming) {
        continue;
      }
      removedEventIds.add(String(candidate.id));
      mergedByEventId.delete(String(candidate.id));
      evictedEvents += 1;
      remainingTransient -= 1;
    }
  }

  return { mergedByEventId, removedEventIds, mergedEvents, evictedEvents };
}

export interface SessionEventRetentionPolicy {
  /**
   * 每次 append 后调用一次。返回值是应从内存淘汰其瞬态事件的 turnId 列表；空数组表示不淘汰。
   * 策略只看事件序列本身，不依赖持久化结果。
   */
  onAppend(event: Pick<SessionEvent, "type" | "turnId">, nowMs: number): readonly string[];
  /**
   * 时间兜底：返回在 `nowMs - graceMs` 之前就已结束、且至今没有后继 turn 的 sealed turnId 列表，
   * 并把它们从待淘汰集合移除。由低频 tick 调用。
   */
  collectExpired(nowMs: number, graceMs: number): readonly string[];
  /**
   * 单 turn 瞬态行数兜底：返回需要按行裁剪的 turn（超 `TRANSIENT_TURN_ROW_LIMIT`）。
   * turn 窗口只封顶"几个 turn"，不封顶"一个 turn 有多长"；退避重试能把一个 turn 拖数小时。
   * `unbounded` 不实现（对照测试要求它逐行保真）。
   */
  trimOversizedTurns?(events: readonly SessionEvent[]): OversizedTurnRowTrim[];
}

const NO_EVICTION: readonly string[] = [];

function createUnboundedRetention(): SessionEventRetentionPolicy {
  return { onAppend: () => NO_EVICTION, collectExpired: () => NO_EVICTION };
}

/**
 * turn 窗口策略：`turn_complete` / `turn_error` 只把 turn 标为已结束（sealed），
 * 等下一个 `turn_started` 到达时再一次性淘汰所有 sealed turn 的瞬态事件（一 turn 滞后）。
 * 滞后的原因：turn 刚结束时消息可能尚未落盘，冷恢复仍要靠内存瞬态事件拼文本；
 * 下一 turn 开始意味着用户又发了消息，上一 turn 必定已持久化。
 */
function createTurnWindowRetention(): SessionEventRetentionPolicy {
  const openTurns = new Set<string>();
  const sealedAt = new Map<string, number>();
  return {
    onAppend(event, nowMs) {
      const turnId = event.turnId;
      if (!turnId) {
        return NO_EVICTION;
      }
      switch (event.type) {
        case SessionEventType.TurnStarted: {
          const evict = [...sealedAt.keys()].filter((sealed) => sealed !== turnId);
          sealedAt.clear();
          openTurns.add(turnId);
          return evict;
        }
        case SessionEventType.TurnComplete:
        case SessionEventType.TurnError: {
          openTurns.delete(turnId);
          if (!sealedAt.has(turnId)) {
            sealedAt.set(turnId, nowMs);
          }
          return NO_EVICTION;
        }
        default:
          return NO_EVICTION;
      }
    },
    collectExpired(nowMs, graceMs) {
      const expired: string[] = [];
      for (const [turnId, at] of sealedAt) {
        if (nowMs - at >= graceMs) {
          expired.push(turnId);
        }
      }
      for (const turnId of expired) {
        sealedAt.delete(turnId);
      }
      return expired;
    },
    // 与 turn 生命周期无关，只看行数：进行中的长 turn 同样受此上限约束。
    trimOversizedTurns(events) {
      return trimOversizedTurns(events, TRANSIENT_TURN_ROW_LIMIT, TRANSIENT_TURN_ROW_TARGET);
    },
  };
}

export function createSessionEventRetentionPolicy(
  mode: SessionEventRetentionMode,
): SessionEventRetentionPolicy {
  return mode === "unbounded" ? createUnboundedRetention() : createTurnWindowRetention();
}
