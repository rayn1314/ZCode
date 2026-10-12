import assert from "node:assert/strict";
import test from "node:test";
import {
  breakForkEdges,
  rollupSubtrees,
  selectLedgerSessionRows,
  type LedgerSessionFact,
} from "../src/usage-ledger/ledgerSessionTree.js";

// 契约见 spec/usage-ledger.md「会话层级」：每行的数值字段 = 该会话自身 + 全部后代；
// fork 不参与层级（断边）；顶层行的合计相加 = 全集合计（不双计）；截断按顶层会话数计且保父链完整。

function fact(over: Partial<LedgerSessionFact> & { sessionId: string }): LedgerSessionFact {
  return {
    title: null,
    directory: null,
    taskType: "interactive",
    parentSessionId: null,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cost: null,
    lastActiveMs: null,
    ...over,
  };
}

test("fork 断边：只改 fork 行的父，入参不被修改", () => {
  const fork = fact({ sessionId: "f", taskType: "fork", parentSessionId: "r" });
  const child = fact({ sessionId: "c", taskType: "subagent_child", parentSessionId: "f" });
  const out = breakForkEdges([fork, child]);
  assert.equal(out[0].parentSessionId, null);
  assert.equal(out[1].parentSessionId, "f");
  assert.notEqual(out[0], fork);
  assert.equal(fork.parentSessionId, "r", "入参必须原样保留");
});

test("rollup：三层父行 = 自身 + 子 + 孙（tokens/calls/cost/lastActiveMs）", () => {
  const facts = [
    fact({
      sessionId: "r",
      calls: 3,
      inputTokens: 100,
      outputTokens: 10,
      cost: 0.5,
      lastActiveMs: 1_000,
    }),
    fact({
      sessionId: "c",
      taskType: "subagent_child",
      parentSessionId: "r",
      calls: 2,
      inputTokens: 50,
      outputTokens: 5,
      cost: 0.25,
      lastActiveMs: 3_000,
    }),
    fact({
      sessionId: "g",
      taskType: "workflow_child",
      parentSessionId: "c",
      calls: 1,
      inputTokens: 20,
      outputTokens: 2,
      lastActiveMs: 5_000,
    }),
  ];
  const rows = rollupSubtrees(facts);
  assert.deepEqual(
    rows.map((r) => r.sessionId),
    ["r", "c", "g"],
    "返回顺序与入参一致",
  );
  const [r, c, g] = rows;
  assert.deepEqual([r.calls, r.inputTokens, r.outputTokens], [6, 170, 17], "父 = 自身 + 子 + 孙");
  assert.equal(r.cost, 0.75, "cost 只累加非 null");
  assert.equal(r.lastActiveMs, 5_000, "子树内最大值");
  assert.equal(r.childCount, 1, "childCount 只看直接子");
  assert.deepEqual([c.calls, c.inputTokens, c.outputTokens], [3, 70, 7]);
  assert.equal(c.childCount, 1);
  assert.deepEqual([g.calls, g.inputTokens, g.outputTokens], [1, 20, 2]);
  assert.equal(g.childCount, 0);
  // 顶层行合计 = 全集合计，不双计
  const topLevel = rows.filter((x) => x.parentSessionId === null);
  assert.equal(
    topLevel.reduce((sum, x) => sum + x.calls, 0),
    facts.reduce((sum, x) => sum + x.calls, 0),
  );
});

test("cost：全 null 保持 null，部分 null 只累加有价的那部分", () => {
  const allNull = rollupSubtrees([
    fact({ sessionId: "p" }),
    fact({ sessionId: "k", parentSessionId: "p", cost: null }),
  ]);
  assert.equal(allNull[0].cost, null);

  const partial = rollupSubtrees([
    fact({ sessionId: "p", cost: null }),
    fact({ sessionId: "k", parentSessionId: "p", cost: 0.4 }),
    fact({ sessionId: "k2", parentSessionId: "p", cost: null }),
  ]);
  assert.equal(partial[0].cost, 0.4);
});

test("fork 不参与层级：fork 自身用量不算回来源会话，fork 的子代理仍挂在 fork 下", () => {
  const facts = [
    fact({ sessionId: "r", calls: 1, inputTokens: 100, outputTokens: 0 }),
    fact({ sessionId: "f", taskType: "fork", parentSessionId: "r", calls: 4, inputTokens: 40 }),
    fact({ sessionId: "fc", taskType: "subagent_child", parentSessionId: "f", calls: 8 }),
  ];
  const rows = rollupSubtrees(facts);
  const [r, f, fc] = rows;
  assert.equal(r.parentSessionId, null);
  assert.equal(f.parentSessionId, null, "fork 报送的父恒为 null");
  assert.deepEqual([r.calls, r.inputTokens], [1, 100], "fork 用量不算回来源会话");
  assert.equal(r.childCount, 0, "断边后 fork 不计入来源会话的直接子");
  assert.deepEqual([f.calls, f.inputTokens], [12, 40], "fork 自身 + 它的子代理");
  assert.equal(f.childCount, 1);
  assert.equal(fc.childCount, 0);
});

test("孤儿：父不在入参集合里时按顶层行处理并保留", () => {
  const rows = rollupSubtrees([
    fact({ sessionId: "a", calls: 1, inputTokens: 9 }),
    fact({ sessionId: "b", taskType: "subagent_child", parentSessionId: "missing", calls: 2 }),
  ]);
  const kept = selectLedgerSessionRows(rows, 1);
  assert.deepEqual(
    kept.map((x) => x.sessionId),
    ["a"],
    "配额 1 时按顶层会话排行；孤儿 b 自身没进配额",
  );
  const keptAll = selectLedgerSessionRows(rows, 2);
  assert.deepEqual(
    keptAll.map((x) => x.sessionId),
    ["a", "b"],
  );
  assert.equal(keptAll[1].childCount, 0);
});

test("配额按顶层会话数计：第二棵树的父与子都不出现", () => {
  const rows = rollupSubtrees([
    fact({ sessionId: "A", calls: 1, inputTokens: 100, outputTokens: 0 }),
    fact({ sessionId: "a1", taskType: "subagent_child", parentSessionId: "A", calls: 1 }),
    fact({ sessionId: "B", calls: 1, inputTokens: 50, outputTokens: 0 }),
    fact({ sessionId: "b1", taskType: "subagent_child", parentSessionId: "B", calls: 1 }),
  ]);
  assert.deepEqual(
    selectLedgerSessionRows(rows, 1).map((x) => x.sessionId),
    ["A", "a1"],
  );
  // 排序是「子树 tokens 降序 → depth 升序 → sessionId 升序」：顶层 B(50) 排在子行（0）之前
  assert.deepEqual(
    selectLedgerSessionRows(rows, 2).map((x) => x.sessionId),
    ["A", "B", "a1", "b1"],
  );
});

test("保父链：父在集合里但配额不够时，子行一并丢弃（不出现悬浮行）", () => {
  const rows = rollupSubtrees([
    fact({ sessionId: "P", calls: 1, inputTokens: 1, outputTokens: 0 }),
    fact({
      sessionId: "C",
      taskType: "subagent_child",
      parentSessionId: "P",
      calls: 1,
      inputTokens: 1_000,
      outputTokens: 0,
    }),
    fact({ sessionId: "Q", calls: 1, inputTokens: 100_000, outputTokens: 0 }),
  ]);
  // 按子树 tokens 降序本应是 Q > C > P；C 的父 P 没进配额，所以 C 必须一起丢
  assert.deepEqual(
    selectLedgerSessionRows(rows, 1).map((x) => x.sessionId),
    ["Q"],
  );
});

test("脏数据：自引用与父链环不挂起、不抛错", () => {
  const selfParent = rollupSubtrees([fact({ sessionId: "s", parentSessionId: "s", calls: 1 })]);
  assert.equal(selfParent[0].calls, 1);
  assert.equal(selfParent[0].childCount, 0, "自引用不计入 childCount");
  assert.deepEqual(
    selectLedgerSessionRows(selfParent, 5).map((x) => x.sessionId),
    [],
  );

  const cycle = rollupSubtrees([
    fact({ sessionId: "a", parentSessionId: "b", calls: 1, inputTokens: 2 }),
    fact({ sessionId: "b", parentSessionId: "a", calls: 1, inputTokens: 3 }),
  ]);
  assert.deepEqual(
    cycle.map((x) => x.childCount),
    [1, 1],
  );
  // 互锁的环里没有任何一方能被当作顶层行，保父链规则下整体丢弃（真实数据不会出现）
  assert.deepEqual(selectLedgerSessionRows(cycle, 5), []);
});

test("空输入返回空数组", () => {
  assert.deepEqual(rollupSubtrees([]), []);
  assert.deepEqual(selectLedgerSessionRows([], 10), []);
  assert.deepEqual(breakForkEdges([]), []);
});

test("select 不改写入参与排序结果", () => {
  const rows = rollupSubtrees([
    fact({ sessionId: "x", calls: 1, inputTokens: 10 }),
    fact({ sessionId: "y", taskType: "subagent_child", parentSessionId: "x", calls: 1 }),
  ]);
  const snapshot = rows.map((r) => ({ ...r }));
  selectLedgerSessionRows(rows, 5);
  assert.deepEqual(rows, snapshot);
});

test("多源同 id 副本：父链按「来源 + 会话 id」认，不跨源互相认亲", () => {
  // 身份迁移让同一会话在两个数据根各有一份，快照里就有同 id 的两行。
  // 裸 id 认父时，A 根的子行会认到 B 根的同 id 行，父被切掉时被连带误留/误丢。
  const rows = rollupSubtrees([
    fact({ sessionId: "P", src: "windows", calls: 1, inputTokens: 1 }),
    fact({
      sessionId: "C",
      src: "windows",
      taskType: "subagent_child",
      parentSessionId: "P",
      calls: 1,
      inputTokens: 10,
    }),
    fact({ sessionId: "P", src: "wsl:Ubuntu", calls: 1, inputTokens: 1_000 }),
  ]);
  const byLabel = (r: (typeof rows)[number]) => `${r.src}/${r.sessionId}`;
  assert.deepEqual(rows.map(byLabel), ["windows/P", "windows/C", "wsl:Ubuntu/P"]);
  assert.equal(rows[0].childCount, 1, "同源的 C 只算进 windows 的 P");
  assert.equal(rows[2].childCount, 0, "同 id 的另一源 P 不该认到这个子行");
  assert.equal(rows[0].inputTokens, 11);

  // 配额 1：只收子树最大的 P@wsl；C@windows 的父（同源 P@windows）没被保留 → C 一并丢弃。
  assert.deepEqual(selectLedgerSessionRows(rows, 1).map(byLabel), ["wsl:Ubuntu/P"]);
  // 配额 2：两个源的树各自完整
  assert.deepEqual(selectLedgerSessionRows(rows, 2).map(byLabel), [
    "wsl:Ubuntu/P",
    "windows/P",
    "windows/C",
  ]);
});
