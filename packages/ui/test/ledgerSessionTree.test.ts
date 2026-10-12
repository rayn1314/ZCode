// 会话层级树契约：层级判定范围限于本批快照、排序只作用于同层兄弟、拍平跟随展开集合。
// 对应需求：用量账本「会话明细表」从平铺改为父子层级渲染。
import assert from "node:assert/strict";
import { test } from "vitest";
import type { LedgerSessionRow } from "@zcode/shared";
import {
  buildSessionForest,
  collectExpandableKeys,
  createSessionComparator,
  flattenSessionForest,
  sessionRowKey,
  toggleExpandedKey,
} from "../src/settings/usage-stats/ledger/sessionTree.js";

function row(sessionId: string, overrides: Partial<LedgerSessionRow> = {}): LedgerSessionRow {
  return {
    sessionId,
    title: null,
    directory: null,
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    lastActiveMs: null,
    cost: null,
    parentSessionId: null,
    taskType: null,
    childCount: 0,
    ...overrides,
  };
}

const byTokensDesc = createSessionComparator("tokens", true);

function visibleIds(
  forest: ReturnType<typeof buildSessionForest>,
  expanded: ReadonlySet<string>,
): Array<[string, number]> {
  return flattenSessionForest(forest, expanded).map((node) => [node.row.sessionId, node.depth]);
}

test("父会话不在本批快照里时按顶层渲染，不挂到看不见的父下面", () => {
  const orphan = row("child", { parentSessionId: "gone", inputTokens: 5 });
  const forest = buildSessionForest([orphan], byTokensDesc);
  assert.deepEqual(
    forest.roots.map((r) => r.sessionId),
    ["child"],
  );
  assert.equal(forest.children.size, 0);
  assert.equal(forest.hasChildrenOf(sessionRowKey(row("gone"))), false);
  assert.deepEqual(visibleIds(forest, new Set()), [["child", 0]]);
});

test("自引用按顶层渲染：不产生自我嵌套，也不会无限展开", () => {
  const self = row("self", { parentSessionId: "self" });
  const forest = buildSessionForest([self], byTokensDesc);
  assert.deepEqual(
    forest.roots.map((r) => r.sessionId),
    ["self"],
  );
  assert.equal(forest.hasChildrenOf(sessionRowKey(row("self"))), false);
  assert.deepEqual(visibleIds(forest, collectExpandableKeys(forest)), [["self", 0]]);
});

test("脏数据成环（A→B→A）时每行仍会出现一次，不会整环消失", () => {
  const a = row("a", { parentSessionId: "b" });
  const b = row("b", { parentSessionId: "a" });
  const forest = buildSessionForest([a, b], byTokensDesc);
  const seen = visibleIds(forest, collectExpandableKeys(forest)).map(([id]) => id);
  assert.deepEqual(seen.sort(), ["a", "b"]);
});

test("排序只作用于同层兄弟：父行顺序与子行顺序互不影响", () => {
  const rows = [
    row("p1", { inputTokens: 1 }),
    row("p2", { inputTokens: 2 }),
    row("c1", { parentSessionId: "p1", inputTokens: 10 }),
    row("c2", { parentSessionId: "p1", inputTokens: 30 }),
  ];
  const forest = buildSessionForest(rows, createSessionComparator("tokens", true));
  assert.deepEqual(
    forest.roots.map((r) => r.sessionId),
    ["p2", "p1"],
  );
  assert.deepEqual(
    forest.children.get(sessionRowKey(row("p1")))?.map((r) => r.sessionId),
    ["c2", "c1"],
  );
});

test("比较器取同值时按 sessionId 升序兜底，输入顺序不影响结果", () => {
  const rows = [
    row("b", { inputTokens: 4 }),
    row("a", { inputTokens: 4 }),
    row("c", { inputTokens: 4 }),
  ];
  assert.deepEqual(
    buildSessionForest(rows, byTokensDesc).roots.map((r) => r.sessionId),
    ["a", "b", "c"],
  );
  assert.deepEqual(
    buildSessionForest([...rows].reverse(), byTokensDesc).roots.map((r) => r.sessionId),
    ["a", "b", "c"],
  );
});

test("比较器口径与改造前的平铺排序一致", () => {
  const cheap = row("cheap", { cost: null, lastActiveMs: null, title: "Zeta" });
  const priced = row("priced", { cost: 3, lastActiveMs: 1000, title: "alpha" });
  const byCostDesc = createSessionComparator("cost", true);
  const byActiveDesc = createSessionComparator("lastActiveMs", true);
  const byTitleAsc = createSessionComparator("title", false);
  // cost 为 null 按 -1 参与比较（未定价行排在最后）
  assert.ok(byCostDesc(priced, cheap) < 0);
  assert.ok(byActiveDesc(priced, cheap) < 0);
  // title 用小写串比较：alpha 在 Zeta 之前
  assert.ok(byTitleAsc(priced, cheap) < 0);
});

test("折叠的行其子树不出现；展开后按深度递增拍平，最深三层", () => {
  const rows = [
    row("root", { inputTokens: 100 }),
    row("mid", { parentSessionId: "root", inputTokens: 50 }),
    row("leaf", { parentSessionId: "mid", inputTokens: 10 }),
    row("other", { inputTokens: 5 }),
  ];
  const forest = buildSessionForest(rows, byTokensDesc);
  const keyOf = (id: string) => forest.keyOf(rows.find((r) => r.sessionId === id)!);

  assert.deepEqual(visibleIds(forest, new Set()), [
    ["root", 0],
    ["other", 0],
  ]);
  // 只展开 root：mid 出现，leaf 仍藏住
  assert.deepEqual(visibleIds(forest, new Set([keyOf("root")])), [
    ["root", 0],
    ["mid", 1],
    ["other", 0],
  ]);
  // 全展开：深度逐层 +1，叶子行不接受展开标记
  assert.deepEqual(visibleIds(forest, collectExpandableKeys(forest)), [
    ["root", 0],
    ["mid", 1],
    ["leaf", 2],
    ["other", 0],
  ]);
  const nodes = flattenSessionForest(forest, new Set([keyOf("root"), keyOf("leaf")]));
  assert.deepEqual(
    nodes.map((n) => [n.row.sessionId, n.hasChildren, n.expanded]),
    [
      ["root", true, true],
      ["mid", true, false],
      ["other", false, false],
    ],
  );
});

test("collectExpandableKeys 只收「有子会话」的行，含折叠在子树里的行", () => {
  const rows = [
    row("root", { inputTokens: 100 }),
    row("mid", { parentSessionId: "root", inputTokens: 50 }),
    row("leaf", { parentSessionId: "mid", inputTokens: 10 }),
    row("x1", { parentSessionId: "b", inputTokens: 1 }),
  ];
  const forest = buildSessionForest(rows, byTokensDesc);
  const expandable = collectExpandableKeys(forest);
  assert.deepEqual(
    [...expandable].sort(),
    [sessionRowKey(row("root")), sessionRowKey(row("mid"))].sort(),
  );
});

test("行 key 带上 src：多源合并时不同数据根的同 id 会话不会互相串味", () => {
  assert.notEqual(
    sessionRowKey({ sessionId: "s1" } as LedgerSessionRow),
    sessionRowKey({ sessionId: "s1", src: "wsl:Ubuntu" } as LedgerSessionRow),
  );
});

test("同一会话在多个数据根各有一份副本时，子行只挂到同源的父行下", () => {
  // 身份迁移会把同一会话复制到另一个数据根，快照里因此出现同 id、不同 src 的两行。
  // 父链是库内本地引用，跨源那两行之间没有父子关系，绝不能互相挂（否则一个父行会凭空
  // 多出不属于自己的子行，而它自己的子行反而消失）。
  const rows = [
    row("p", { src: "windows", inputTokens: 1 }),
    row("p", { src: "windows@rayn", inputTokens: 2 }),
    row("c", { src: "windows", parentSessionId: "p", inputTokens: 3 }),
    row("c", { src: "windows@rayn", parentSessionId: "p", inputTokens: 4 }),
  ];
  const forest = buildSessionForest(rows, byTokensDesc);
  assert.deepEqual(
    forest.roots.map((r) => `${r.src}/${r.sessionId}`),
    ["windows@rayn/p", "windows/p"],
  );
  assert.deepEqual(
    forest.children.get(sessionRowKey(row("p", { src: "windows" })))?.map((r) => r.src),
    ["windows"],
  );
  assert.deepEqual(
    forest.children.get(sessionRowKey(row("p", { src: "windows@rayn" })))?.map((r) => r.src),
    ["windows@rayn"],
  );
  // 每个父行后面紧跟它自己那一份子行
  assert.deepEqual(visibleIds(forest, collectExpandableKeys(forest)), [
    ["p", 0],
    ["c", 1],
    ["p", 0],
    ["c", 1],
  ]);
});

test("toggleExpandedKey 返回新集合，不改动传入的集合", () => {
  const base = new Set(["a"]);
  const added = toggleExpandedKey(base, "b");
  assert.deepEqual([...added].sort(), ["a", "b"]);
  assert.deepEqual([...base], ["a"]);
  assert.deepEqual([...toggleExpandedKey(added, "a")], ["b"]);
});

test("空输入返回空森林", () => {
  const forest = buildSessionForest([], byTokensDesc);
  assert.deepEqual(forest.roots, []);
  assert.equal(forest.children.size, 0);
  assert.deepEqual(flattenSessionForest(forest, new Set()), []);
  assert.equal(collectExpandableKeys(forest).size, 0);
});
