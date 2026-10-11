import assert from "node:assert/strict";
import test from "node:test";
import {
  decideGoalDeadline,
  formatGoalCompletionVerificationPrompt,
  formatGoalContinuationPrompt,
  type SessionGoal,
} from "@zcode/contracts";

/**
 * 到点两段式的纯裁决点与提示文案契约。core 的续跑候选检查只调用
 * `decideGoalDeadline` 决定「继续 / 放行收尾 / 结算」，这里钉死它的边界，
 * 防止收尾轮被重复给或提前被吃掉。
 */

const BEFORE_DEADLINE = 1_000_000;
const DEADLINE = 2_000_000;

test("未设截止时间时永远继续", () => {
  assert.equal(
    decideGoalDeadline({ endAtMs: null, deadlineGraceUsed: false, nowMs: DEADLINE + 1 }),
    "continue",
  );
  assert.equal(
    decideGoalDeadline({ endAtMs: null, deadlineGraceUsed: true, nowMs: DEADLINE + 1 }),
    "continue",
  );
});

test("未到点继续，到点边界即触发", () => {
  assert.equal(
    decideGoalDeadline({
      endAtMs: DEADLINE,
      deadlineGraceUsed: false,
      nowMs: BEFORE_DEADLINE,
    }),
    "continue",
  );
  assert.equal(
    decideGoalDeadline({ endAtMs: DEADLINE, deadlineGraceUsed: false, nowMs: DEADLINE }),
    "wrap-up",
  );
});

test("到点且收尾标志未用 → 放行收尾轮", () => {
  assert.equal(
    decideGoalDeadline({ endAtMs: DEADLINE, deadlineGraceUsed: false, nowMs: DEADLINE + 1 }),
    "wrap-up",
  );
});

test("到点且收尾标志已用 → 结算硬停（收尾只给一次）", () => {
  assert.equal(
    decideGoalDeadline({ endAtMs: DEADLINE, deadlineGraceUsed: true, nowMs: DEADLINE + 1 }),
    "settle",
  );
});

function goal(overrides: Partial<SessionGoal> = {}): SessionGoal {
  return {
    sessionID: "sess_test" as SessionGoal["sessionID"],
    targetID: "target_1",
    objective: "keep improving the product",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    endAtMs: null,
    deadlineGraceUsed: false,
    time: { created: 0, updated: 0 },
    ...overrides,
  };
}

test("续跑提示：无截止时间时不输出 Deadline 段落", () => {
  const prompt = formatGoalContinuationPrompt(goal(), null, BEFORE_DEADLINE);
  assert.equal(prompt.includes("Deadline:"), false);
});

test("续跑提示：未到点输出硬截止与剩余时间", () => {
  const prompt = formatGoalContinuationPrompt(
    goal({ endAtMs: DEADLINE }),
    null,
    BEFORE_DEADLINE,
  );
  assert.match(prompt, /Deadline:/);
  assert.match(prompt, /Hard deadline:/);
  assert.match(prompt, /\(in 17m\)/);
  assert.equal(prompt.includes("has passed"), false);
});

test("续跑提示：已到点时同一段落变成收尾指令", () => {
  const prompt = formatGoalContinuationPrompt(goal({ endAtMs: DEADLINE }), null, DEADLINE + 1);
  assert.match(prompt, /has passed\. This is the final wrap-up turn/);
  assert.equal(prompt.includes("Hard deadline:"), false);
});

test("完成校验提示带上截止时间（未到点给剩余，已到点标 already passed）", () => {
  const future = formatGoalCompletionVerificationPrompt(
    goal({ endAtMs: DEADLINE }),
    BEFORE_DEADLINE,
  );
  assert.match(future, /Hard deadline: [\d-]+ [\d:]+ \(in /);

  const past = formatGoalCompletionVerificationPrompt(goal({ endAtMs: DEADLINE }), DEADLINE + 1);
  assert.match(past, /\(already passed\)/);

  const none = formatGoalCompletionVerificationPrompt(goal(), BEFORE_DEADLINE);
  assert.equal(none.includes("Hard deadline"), false);
});
