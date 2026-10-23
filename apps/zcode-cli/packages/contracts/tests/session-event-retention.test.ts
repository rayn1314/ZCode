import { describe, expect, it } from "vitest";

import {
  createSessionEventRetentionPolicy,
  isTransientSessionEvent,
  SessionEventType,
  TRANSIENT_SESSION_EVENT_TYPES,
  trimOversizedTurns,
  type SessionEvent,
} from "../src/index.js";

const ev = (type: SessionEventType, turnId?: string) => ({ type, turnId });

describe("session event retention policy", () => {
  it("RET-001 turn-window：turn 结束只 seal，下一 turn 开始才淘汰上一 turn", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.ModelStreaming, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.ModelComplete, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0)).toEqual([]);
    // 仍在滞后窗口内：不淘汰。
    expect(policy.onAppend(ev(SessionEventType.SessionTitleUpdated, "t1"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0)).toEqual(["t1"]);
    expect(policy.onAppend(ev(SessionEventType.TurnError, "t2"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t3"), 0)).toEqual(["t2"]);
  });

  it("RET-001 rewind 不触发淘汰；无 turnId 的事件不参与", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t2"), 0);
    expect(policy.onAppend(ev(SessionEventType.RewindTriggered, "t2"), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted), 0)).toEqual([]);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t3"), 0)).toEqual(["t2"]);
  });

  it("unbounded 永不淘汰", () => {
    const policy = createSessionEventRetentionPolicy("unbounded");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 0);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 0)).toEqual([]);
  });

  it("瞬态集合是与消息流同频的四类事件，且 reducer 不消费它们", () => {
    expect([...TRANSIENT_SESSION_EVENT_TYPES].sort()).toEqual(
      [
        SessionEventType.ModelStreaming,
        SessionEventType.ToolCallProgress,
        SessionEventType.StreamingToolLedgerUpdated,
        SessionEventType.ModelNetworkStatus,
      ].sort(),
    );
    expect(isTransientSessionEvent({ type: SessionEventType.ModelStreaming })).toBe(true);
    expect(isTransientSessionEvent({ type: SessionEventType.ModelComplete })).toBe(false);
  });
});

describe("session event retention policy · 时间兜底", () => {
  it("RET-008 sealed turn 超过 grace 且没有后继 turn 时由 collectExpired 交出；一次性 subagent 子 session 场景", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "child"), 0);
    policy.onAppend(ev(SessionEventType.ModelStreaming, "child"), 1_000);
    policy.onAppend(ev(SessionEventType.TurnComplete, "child"), 10_000);
    expect(policy.collectExpired(60_000, 120_000)).toEqual([]);
    expect(policy.collectExpired(130_000, 120_000)).toEqual(["child"]);
    // 交出后不再重复交出。
    expect(policy.collectExpired(200_000, 120_000)).toEqual([]);
  });

  it("RET-008 后继 turn 先到时按 turn 窗口淘汰，时间兜底不再重复", () => {
    const policy = createSessionEventRetentionPolicy("turn-window");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 5_000);
    expect(policy.onAppend(ev(SessionEventType.TurnStarted, "t2"), 6_000)).toEqual(["t1"]);
    expect(policy.collectExpired(500_000, 120_000)).toEqual([]);
  });

  it("unbounded 的时间兜底恒为空", () => {
    const policy = createSessionEventRetentionPolicy("unbounded");
    policy.onAppend(ev(SessionEventType.TurnStarted, "t1"), 0);
    policy.onAppend(ev(SessionEventType.TurnComplete, "t1"), 1);
    expect(policy.collectExpired(1_000_000, 0)).toEqual([]);
  });
});

describe("session event retention policy · 单 turn 行数兜底", () => {
  const stream = (seq: number, text: string, kind = "text_delta", partId = "p1"): SessionEvent =>
    ({
      id: `e${seq}`,
      sessionId: "s",
      type: SessionEventType.ModelStreaming,
      turnId: "t1",
      timestamp: new Date(seq),
      sequenceNumber: seq,
      payload: { kind, delta: text, done: false, assistantMessageId: "m1", partId },
    }) as unknown as SessionEvent;

  const status = (seq: number): SessionEvent =>
    ({
      id: `e${seq}`,
      sessionId: "s",
      type: SessionEventType.ModelNetworkStatus,
      turnId: "t1",
      timestamp: new Date(seq),
      sequenceNumber: seq,
      payload: {},
    }) as unknown as SessionEvent;

  const boundary = (seq: number, type: SessionEventType): SessionEvent =>
    ({
      id: `e${seq}`,
      sessionId: "s",
      type,
      turnId: "t1",
      timestamp: new Date(seq),
      sequenceNumber: seq,
      payload: {},
    }) as unknown as SessionEvent;

  it("RET-013 超限时把同一 part 的连续 delta 合并成锚点行：文本拼接不变、锚点保留 seq/timestamp", () => {
    const events = [
      boundary(1, SessionEventType.TurnStarted),
      stream(2, "a"),
      stream(3, "b"),
      stream(4, "c"),
      boundary(5, SessionEventType.ModelComplete),
    ];
    const plans = trimOversizedTurns(events, 2, 2);
    expect(plans).toHaveLength(1);
    const [plan] = plans;
    expect(plan?.turnId).toBe("t1");
    expect(plan?.mergedEvents).toBe(2);
    expect(plan?.evictedEvents).toBe(0);
    expect([...(plan?.removedEventIds ?? [])].sort()).toEqual(["e3", "e4"]);
    const merged = plan?.mergedByEventId.get("e2");
    expect((merged?.payload as { delta: string }).delta).toBe("abc");
    expect(merged?.sequenceNumber).toBe(2);
    expect(merged?.timestamp).toEqual(new Date(2));
    // 边界事件（start / complete）与锚点自身都不在移除集合里。
    expect(plan?.removedEventIds.has("e1")).toBe(false);
    expect(plan?.removedEventIds.has("e5")).toBe(false);
    // 未超限时不动（快路径）。
    expect(trimOversizedTurns(events, 3, 2)).toEqual([]);
  });

  it("RET-014 不同 part / 不同 kind 的 delta 不跨边界合并", () => {
    const events = [stream(1, "a", "text_delta", "p1"), stream(2, "b", "text_delta", "p2")];
    const plans = trimOversizedTurns(events, 1, 1);
    const [plan] = plans;
    expect(plan?.mergedEvents).toBe(0);
    expect(plan?.mergedByEventId.size).toBe(0);
  });

  it("RET-015 合并后仍超目标：先淘汰最旧的状态类瞬态，delta 文本行保留到最后一轮", () => {
    const events = [
      boundary(1, SessionEventType.TurnStarted),
      stream(2, "a"),
      stream(3, "b"),
      status(4),
      status(5),
      status(6),
      status(7),
      status(8),
      status(9),
    ];
    const plans = trimOversizedTurns(events, 6, 4);
    const [plan] = plans;
    expect(plan?.mergedEvents).toBe(1);
    // 瞬态行 7 条 → 合并 delta 后 6 行瞬态，仍 > 目标 4：淘汰最旧的 3 条状态事件。
    expect([...(plan?.removedEventIds ?? [])].sort()).toEqual(["e3", "e4", "e5", "e6"]);
    expect(plan?.evictedEvents).toBe(3);
    // 最新的状态事件与合并后的 delta 锚点都留着。
    expect(plan?.removedEventIds.has("e9")).toBe(false);
    expect(plan?.mergedByEventId.get("e2")).toBeDefined();
  });

  it("RET-016 只有 delta 超限时不动状态类瞬态", () => {
    const events = [status(1), stream(2, "a"), stream(3, "b"), status(4), status(5)];
    const [plan] = trimOversizedTurns(events, 4, 4);
    expect(plan?.evictedEvents).toBe(0);
    expect([...(plan?.removedEventIds ?? [])]).toEqual(["e3"]);
  });

  it("RET-017 unbounded 策略不提供行数兜底（对照测试要求逐行保真）", () => {
    expect(
      createSessionEventRetentionPolicy("unbounded").trimOversizedTurns,
    ).toBeUndefined();
    expect(
      createSessionEventRetentionPolicy("turn-window").trimOversizedTurns,
    ).toBeTypeOf("function");
  });
});
