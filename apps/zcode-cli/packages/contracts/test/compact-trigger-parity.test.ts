// 压缩触发器的**消费端枚举奇偶校验**（spec: core/spec/context-compaction-controls.md 不变式 I5）。
//
// 根因：`CompactTrigger` 是"生产端"单源（contracts），但它的取值会被复制进多个"消费端"
// 字符串枚举（legacy 时间线 zod、v4 遥测 zod、services 的手写 guard）。这些复制品不会被
// TypeScript 的类型穷尽守卫覆盖——它们只在**运行时**遇到新取值时抛错，表现为"某个新触发器
// 的事件整条丢失/遥测消失"，而且只有真跑到那条路径才暴露。
//
// 因此这里对每个 CompactTrigger / CompactPhase 取值逐个跑一遍真实 schema，
// 让"新增触发器但漏改消费端枚举"在测试期就红，而不是上线后静默丢数据。
import assert from "node:assert/strict";
import test from "node:test";
import { CompactPhase, CompactTrigger } from "../src/compact/index.js";
import { zcodeTimelinePartSchema } from "@zcode/shared";
import { conversationTelemetryFactSchema } from "@zcode/shared/zcode-protocol-v4";

function minimalTimelinePart(trigger: string, phase: string) {
  return {
    partId: "part-1",
    sessionId: "sess-1",
    messageId: "msg-1",
    type: "timeline" as const,
    timelineType: "context_compaction" as const,
    display: "separator" as const,
    trigger,
    phase,
  };
}

function minimalCompactionTerminalFact(trigger: string) {
  return {
    version: 1 as const,
    eventId: "evt-1",
    eventSeq: 0,
    occurredAt: 1_700_000_000_000,
    sessionId: "sess-1",
    kind: "compaction.terminal" as const,
    operationId: "op-1",
    status: "completed" as const,
    trigger,
  };
}

test("每个 CompactTrigger 取值都被 legacy 时间线 schema 接受", () => {
  for (const trigger of Object.values(CompactTrigger)) {
    const parsed = zcodeTimelinePartSchema.safeParse(
      minimalTimelinePart(trigger, CompactPhase.PreRequest),
    );
    assert.equal(
      parsed.success,
      true,
      `legacy 时间线 schema 不认识 trigger=${trigger}，该触发器的时间线会被丢弃`,
    );
  }
});

test("每个 CompactPhase 取值都被 legacy 时间线 schema 接受", () => {
  for (const phase of Object.values(CompactPhase)) {
    const parsed = zcodeTimelinePartSchema.safeParse(
      minimalTimelinePart(CompactTrigger.Auto, phase),
    );
    assert.equal(
      parsed.success,
      true,
      `legacy 时间线 schema 不认识 phase=${phase}，该阶段的时间线会被丢弃`,
    );
  }
});

test("每个 CompactTrigger 取值都被 v4 遥测 compaction.terminal fact 接受", () => {
  for (const trigger of Object.values(CompactTrigger)) {
    const parsed = conversationTelemetryFactSchema.safeParse(
      minimalCompactionTerminalFact(trigger),
    );
    assert.equal(
      parsed.success,
      true,
      `v4 遥测 schema 不认识 trigger=${trigger}，该触发器的 compaction.terminal 遥测会在 parse 时抛错`,
    );
  }
});
