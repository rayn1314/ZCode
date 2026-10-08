// 子会话身份判据的契约（spec `subagent-session-as-first-class.md` 差异清单 2 / 21）。
//
// 守的是一条实测踩过的坑：子会话有**两条**构造路径（派发带覆盖包、冷恢复只有
// `runtimeConfig.taskType`），而收窄判定原先只认覆盖包，于是冷恢复出的子会话把收窄漏掉，
// 同一种会话两条路径行为不同。判据收成 `isSubagentChildSession` 一处，这个文件锁死它的语义。
//
// 说明（2026-10-08 拍板）：hooks 与 hook trust **不再**是子会话的收窄项——子会话照跑用户/
// 插件的工具级 hook，与主会话同形（理由见 spec 差异清单 21）。现在只剩 `subagentRosterPort`
// 一处收窄，它同样以本判据为准。
import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentChildAppScope } from "../src/app/subagent-child-scope.js";
import { isSubagentChildSession } from "../src/app/subagent-child-scope.js";

/** 判据只读 `!== undefined`，所以覆盖包用最小形状即可。 */
const SCOPE = {} as SubagentChildAppScope;

test("两条构造路径都认得出来：带覆盖包（派发）或 taskType（冷恢复）", () => {
  assert.equal(
    isSubagentChildSession({ subagentChildScope: SCOPE, taskType: "subagent_child" }),
    true,
  );
  // 冷恢复：没有覆盖包，只能靠 record 上持久化的 taskType。
  assert.equal(isSubagentChildSession({ taskType: "subagent_child" }), true);
  // 派发：即使 taskType 没跟上，覆盖包在场就算。
  assert.equal(isSubagentChildSession({ subagentChildScope: SCOPE }), true);
});

test("普通会话与其它 taskType 不算子会话", () => {
  assert.equal(isSubagentChildSession({}), false);
  assert.equal(isSubagentChildSession({ taskType: "interactive" }), false);
  assert.equal(isSubagentChildSession({ taskType: "workflow_child" }), false);
  assert.equal(isSubagentChildSession({ taskType: "selection_side_chat" }), false);
});
