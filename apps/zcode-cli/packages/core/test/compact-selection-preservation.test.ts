import assert from "node:assert/strict";
import test from "node:test";
import { CompactTrigger } from "@zcode/contracts";
import {
  getRuntimeEntriesToSummarize,
  selectCompactEntries,
} from "../src/runtime/helpers/compact-selection.js";
import type { RuntimeMessageEntry } from "../src/agent/message-history.js";

/**
 * 压缩保留段契约（spec: core/spec/context-compaction-controls.md §4 I6）：
 *
 * 切分按「assistant 起始轮」分组（`groupByAssistantStartedRounds`：一条 assistant 回答
 * 开启一组，其后到下一个 assistant 之前的 user/tool 消息都归入该组）。因此：
 * - Auto / Reactive / PostTurn / ModelDownshift 保留最近一组，即**保留段是 history 后缀，
 *   且从最后一条 assistant 回答开始**；
 * - 这个形态保证"正在被回答的用户输入"不会被摘要掉：Auto/Reactive 在请求前压缩时，
 *   history 末尾已是本轮用户输入；降档压缩发生在追加本轮输入之前，输入尚未进 history；
 * - Manual（StandaloneTurn）与 SessionMemory 有意不保留——手动 /compact 若留下悬空用户
 *   消息，下一轮模型会把它再答一遍。
 */

function userEntry(text: string, source: "real_user" | "context_prefix" = "real_user"): RuntimeMessageEntry {
  return { message: { role: "user", content: text }, metadata: { source } };
}

function assistantEntry(text: string): RuntimeMessageEntry {
  return { message: { role: "assistant", content: text } };
}

const PREFIX: RuntimeMessageEntry = userEntry("<system-reminder>prefix</system-reminder>", "context_prefix");

/** 收尾是 assistant 回答的 history（轮末压缩、降档压缩看到的就是这个形态）。 */
function historyEndingWithAnswer(): RuntimeMessageEntry[] {
  return [
    PREFIX,
    userEntry("第一轮问题"),
    assistantEntry("第一轮回答"),
    userEntry("第二轮问题"),
    assistantEntry("第二轮回答"),
    userEntry("第三轮问题"),
    assistantEntry("第三轮回答"),
  ];
}

/** 收尾是用户输入的 history（auto/reactive 在请求前压缩时看到的形态）。 */
function historyEndingWithQuestion(): RuntimeMessageEntry[] {
  return [...historyEndingWithAnswer(), userEntry("第四轮问题")];
}

const PRESERVING_TRIGGERS = [
  CompactTrigger.Auto,
  CompactTrigger.Reactive,
  CompactTrigger.PostTurn,
  CompactTrigger.ModelDownshift,
] as const;

for (const trigger of PRESERVING_TRIGGERS) {
  test(`${trigger} 压缩保留段是 history 后缀，且从最后一条 assistant 回答开始`, () => {
    const entries = historyEndingWithAnswer();
    const selection = selectCompactEntries({ entries, trigger });

    assert.equal(selection.groupsPreserved, 1);
    assert.equal(selection.preservedEntries.length > 0, true);
    assert.deepEqual(
      selection.preservedEntries.map((entry) => JSON.stringify(entry)),
      entries.slice(-selection.preservedEntries.length).map((entry) => JSON.stringify(entry)),
      "保留段必须是 history 的后缀",
    );
    const first = selection.preservedEntries[0];
    assert.equal(first?.kind !== "attachment" && first.message.role === "assistant", true);
    assert.equal(
      selection.preservedEntries.at(-1)?.message.content,
      "第三轮回答",
      "最后一条消息必须在保留段内",
    );
  });
}

for (const trigger of PRESERVING_TRIGGERS) {
  test(`${trigger} 压缩不摘要掉"正在被回答的用户输入"`, () => {
    const selection = selectCompactEntries({ entries: historyEndingWithQuestion(), trigger });
    const preservedText = selection.preservedEntries
      .map((entry) => (entry.kind === "attachment" ? entry.content : String(entry.message.content)))
      .join("\n");
    assert.equal(preservedText.includes("第四轮问题"), true);
  });
}

for (const trigger of [CompactTrigger.Manual, CompactTrigger.SessionMemory] as const) {
  test(`${trigger} 有意摘要全部，不保留悬空用户消息`, () => {
    const selection = selectCompactEntries({ entries: historyEndingWithAnswer(), trigger });
    assert.equal(selection.groupsPreserved, 0);
    assert.equal(selection.preservedEntries.length, 0);
  });
}

test("context prefix 只作为前缀传入，不进摘要正文", () => {
  const selection = selectCompactEntries({
    entries: historyEndingWithAnswer(),
    trigger: CompactTrigger.PostTurn,
  });
  const summarized = getRuntimeEntriesToSummarize(selection.entriesForSummary);
  assert.equal(
    summarized.some((entry) => entry.metadata?.source === "context_prefix"),
    false,
  );
  assert.equal(
    selection.preservedEntries.some((entry) => entry.metadata?.source === "context_prefix"),
    false,
  );
  // 前缀仍留在 entriesForSummary 里（克隆副本），由压缩后的 canonical 前缀重建沿用。
  assert.equal(
    selection.entriesForSummary.some((entry) => entry.metadata?.source === "context_prefix"),
    true,
  );
});
