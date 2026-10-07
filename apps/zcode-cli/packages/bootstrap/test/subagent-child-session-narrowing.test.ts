// 子会话收窄的判据契约（spec `subagent-session-as-first-class.md` 差异清单 2 / 21）。
//
// 这组断言守的是一条实测踩过的坑：子会话有**两条**构造路径（派发带覆盖包、冷恢复只有
// `runtimeConfig.taskType`），而各处收窄原先只认覆盖包，于是冷恢复出的子会话把 hooks /
// hook trust / roster 的收窄全漏掉了——同一种会话两条路径行为不同，且没有任何测试会红。
//
// 只断言「判据」与「关掉的方式」：`create-app.ts` 没有测试夹具，这两个纯函数是这条规则
// 唯一能被直接断言的形态。
import assert from "node:assert/strict";
import test from "node:test";
import type { SubagentChildAppScope } from "../src/app/subagent-child-scope.js";
import {
  isSubagentChildSession,
  resolveSubagentChildHooksConfig,
} from "../src/app/subagent-child-scope.js";

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

test("子会话的 hooks 配置一律 enabled: false，但保留事件定义与限额", () => {
  const narrowed = resolveSubagentChildHooksConfig({
    enabled: true,
    events: { PreToolUse: [{ hooks: [{ command: "echo hi", type: "command" }] }] },
    maxOutputBytes: 4096,
    timeoutMs: 1234,
  });

  // 这一条是重点：配置化 hook runner 会因此构造不出来（构造门读 `config.hooks.enabled`），
  // 子代理的工具调用不会去执行用户/插件写的 hook。
  assert.equal(narrowed.enabled, false);
  // 保留事件表：子代理生命周期事件仍要能被这套 runtime 认识（发射点在父 runtime）。
  assert.deepEqual(Object.keys(narrowed.events), ["PreToolUse"]);
  assert.equal(narrowed.maxOutputBytes, 4096);
  assert.equal(narrowed.timeoutMs, 1234);
});

test("hooks 配置缺席时给出可用的默认限额，且仍然是关的", () => {
  const narrowed = resolveSubagentChildHooksConfig(undefined);
  assert.equal(narrowed.enabled, false);
  assert.deepEqual(narrowed.events, {});
  assert.equal(narrowed.maxOutputBytes, 32_768);
  assert.equal(narrowed.timeoutMs, 60_000);
});
