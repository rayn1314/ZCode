import assert from "node:assert/strict";
import test from "node:test";
import {
  GOAL_DEADLINE_WARNING_LEAD_MS,
  decideGoalDeadline,
  formatGoalCompletionVerificationPrompt,
  formatGoalContinuationPrompt,
  shouldSendGoalDeadlineWarning,
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
    deadlineWarningSent: false,
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

test("预警判定：只在未发过、且剩余时间落入预警窗口时返回 true", () => {
  // 无截止时间 / 已发过预警 / 已在窗口外 → false
  assert.equal(shouldSendGoalDeadlineWarning({ endAtMs: null, warningSent: false, nowMs: DEADLINE }), false);
  assert.equal(
    shouldSendGoalDeadlineWarning({ endAtMs: DEADLINE, warningSent: true, nowMs: DEADLINE - GOAL_DEADLINE_WARNING_LEAD_MS / 2 }),
    false,
  );
  assert.equal(
    shouldSendGoalDeadlineWarning({ endAtMs: DEADLINE, warningSent: false, nowMs: BEFORE_DEADLINE }),
    false,
  );
  // 窗口内（剩余 <= 10 分钟）→ true
  assert.equal(
    shouldSendGoalDeadlineWarning({
      endAtMs: DEADLINE,
      warningSent: false,
      nowMs: DEADLINE - GOAL_DEADLINE_WARNING_LEAD_MS,
    }),
    true,
  );
  assert.equal(
    shouldSendGoalDeadlineWarning({
      endAtMs: DEADLINE,
      warningSent: false,
      nowMs: DEADLINE - GOAL_DEADLINE_WARNING_LEAD_MS / 2,
    }),
    true,
  );
  // 已到点不属于预警（那是收尾轮/结算路径）
  assert.equal(
    shouldSendGoalDeadlineWarning({ endAtMs: DEADLINE, warningSent: false, nowMs: DEADLINE }),
    false,
  );
});

test("续跑提示：进入预警窗口后输出 approaching 收敛要求，不再只报剩余时间", () => {
  const approaching = formatGoalContinuationPrompt(
    goal({ endAtMs: DEADLINE }),
    null,
    DEADLINE - GOAL_DEADLINE_WARNING_LEAD_MS / 2,
  );
  assert.match(approaching, /Deadline approaching:/);
  assert.match(approaching, /start converging|Converge on the objective now/i);
  // 与「未到点」的普通段落相区分：approaching 段落不带「after one final wrap-up turn」原文，
  // 但带剩余时间。
  assert.match(approaching, /\(in /);

  // 窗口外仍是普通硬截止段落
  const calm = formatGoalContinuationPrompt(goal({ endAtMs: DEADLINE }), null, BEFORE_DEADLINE);
  assert.equal(calm.includes("Deadline approaching:"), false);
});

test("完成校验提示：进入预警窗口后状态后缀标 approaching", () => {
  const prompt = formatGoalCompletionVerificationPrompt(
    goal({ endAtMs: DEADLINE }),
    DEADLINE - GOAL_DEADLINE_WARNING_LEAD_MS / 2,
  );
  assert.match(prompt, /— approaching, start converging/);
});
