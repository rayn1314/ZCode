import type { LedgerSessionRow } from "@zcode/shared";

// 会话明细的父子层级：纯函数（无 React、无副作用），供 LedgerSessionsTable 建树、拍平与展开态使用。
//
// 关键约束（与数据层同源）：parentSessionId 可能在本批 snapshot.sessions 里找不到对应行——
// 父会话在所选时间范围内没有调用记录，或父被配额切掉。因此层级判定只看「父 id 是否在本批里」，
// 绝不无条件按 id 挂树：父不在本批而按 id 挂树，子行会挂到渲染不出来的父下面，整片从界面消失。

export type LedgerSessionSortKey = "title" | "calls" | "tokens" | "cost" | "lastActiveMs";

export interface LedgerSessionNode {
  row: LedgerSessionRow;
  key: string;
  /** 可见链深度，顶层为 0。 */
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

export interface LedgerSessionForest {
  /** 顶层行（父不在本批、自引用，或脏数据成环无法从顶层到达），已按比较器排序。 */
  roots: LedgerSessionRow[];
  /** 键为「父行的 key」（`sessionRowKey`，含 src），值为该父的直接子行，已排序。 */
  children: Map<string, LedgerSessionRow[]>;
  hasChildrenOf: (key: string) => boolean;
  keyOf: (row: LedgerSessionRow) => string;
}

/** 行身份：src 参与 key，多源合并时不同数据根的同 id 会话不会互相串味。 */
export function sessionRowKey(row: LedgerSessionRow): string {
  return rowKey(row.src, row.sessionId);
}

function rowKey(src: string | undefined, sessionId: string): string {
  return `${src ?? ""}\u0000${sessionId}`;
}

/**
 * 父行的 key：**继承本行的 src**——父链只在同一数据源内成立。
 * 同一会话可能在多个数据根各有一份（身份迁移产生的同 id 副本），若按裸 sessionId 挂树，
 * A 根的子行会挂到 B 根的父行名下：那个父行会凭空多出不属于自己的子行，而它自己的子行反而消失。
 */
function parentKeyOf(row: LedgerSessionRow): string | null {
  return row.parentSessionId == null ? null : rowKey(row.src, row.parentSessionId);
}

function compareBySessionId(a: LedgerSessionRow, b: LedgerSessionRow): number {
  if (a.sessionId === b.sessionId) {
    return 0;
  }
  return a.sessionId < b.sessionId ? -1 : 1;
}

export function buildSessionForest(
  rows: readonly LedgerSessionRow[],
  compare: (a: LedgerSessionRow, b: LedgerSessionRow) => number,
): LedgerSessionForest {
  const presentKeys = new Set<string>();
  for (const row of rows) {
    presentKeys.add(sessionRowKey(row));
  }

  const children = new Map<string, LedgerSessionRow[]>();
  const roots: LedgerSessionRow[] = [];
  for (const row of rows) {
    const parentKey = parentKeyOf(row);
    // 自引用同样按顶层处理：脏数据成环时不能顺着自己挂出无穷子树。
    if (parentKey === null || parentKey === sessionRowKey(row) || !presentKeys.has(parentKey)) {
      roots.push(row);
      continue;
    }
    const siblings = children.get(parentKey);
    if (siblings) {
      siblings.push(row);
    } else {
      children.set(parentKey, [row]);
    }
  }

  // 互指的脏数据（A→B、B→A）里每个环节的父都在本批，于是谁都成不了顶层，整环从界面上消失。
  // 这里把从顶层走不到的行提升为顶层，保证每行都能出现；拍平时的去重保证每行只渲染一次。
  const reachable = new Set<string>();
  const pending = [...roots];
  while (pending.length > 0) {
    const row = pending.pop()!;
    const key = sessionRowKey(row);
    if (reachable.has(key)) {
      continue;
    }
    reachable.add(key);
    const kids = children.get(key);
    if (kids) {
      for (const kid of kids) {
        pending.push(kid);
      }
    }
  }
  for (const row of rows) {
    if (!reachable.has(sessionRowKey(row))) {
      roots.push(row);
    }
  }

  // 排序只作用于同层兄弟：roots 之间、同一父的 children 之间各排一次。
  // 比较器返回相等时用 sessionId 升序兜底，保证同值行在新快照或重渲染后顺序稳定。
  const sortLevel = (list: LedgerSessionRow[]) => {
    list.sort((a, b) => compare(a, b) || compareBySessionId(a, b));
  };
  sortLevel(roots);
  for (const siblings of children.values()) {
    sortLevel(siblings);
  }

  return {
    roots,
    children,
    hasChildrenOf: (key) => (children.get(key)?.length ?? 0) > 0,
    keyOf: sessionRowKey,
  };
}

/**
 * 深度优先前序遍历。descend 返回 false 时不再下探其子树（折叠用）。
 * 用显式栈而不是递归：脏数据或超长会话链都不该把调用栈打爆。
 */
function walkSessionForest(
  forest: LedgerSessionForest,
  visit: (row: LedgerSessionRow, depth: number) => void,
  descend?: (row: LedgerSessionRow, key: string) => boolean,
): void {
  const stack: Array<{ row: LedgerSessionRow; depth: number }> = [];
  for (let i = forest.roots.length - 1; i >= 0; i -= 1) {
    stack.push({ row: forest.roots[i]!, depth: 0 });
  }
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { row, depth } = stack.pop()!;
    const key = forest.keyOf(row);
    // 脏数据成环或同 id 重复时去重：否则会重复渲染（React key 冲突）甚至死循环。
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    visit(row, depth);
    if (descend && !descend(row, key)) {
      continue;
    }
    const kids = forest.children.get(key);
    if (!kids) {
      continue;
    }
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ row: kids[i]!, depth: depth + 1 });
    }
  }
}

export function flattenSessionForest(
  forest: LedgerSessionForest,
  expandedKeys: ReadonlySet<string>,
): LedgerSessionNode[] {
  const nodes: LedgerSessionNode[] = [];
  walkSessionForest(
    forest,
    (row, depth) => {
      const key = forest.keyOf(row);
      const hasChildren = forest.hasChildrenOf(key);
      nodes.push({
        row,
        key,
        depth,
        hasChildren,
        expanded: hasChildren && expandedKeys.has(key),
      });
    },
    (row, key) => forest.hasChildrenOf(key) && expandedKeys.has(key),
  );
  return nodes;
}

/** 所有「有子会话」的行的 key（含折叠在子树里的行），供「全部展开」。 */
export function collectExpandableKeys(forest: LedgerSessionForest): Set<string> {
  const keys = new Set<string>();
  walkSessionForest(forest, (row) => {
    if (forest.hasChildrenOf(forest.keyOf(row))) {
      keys.add(forest.keyOf(row));
    }
  });
  return keys;
}

/** 切换展开集合里的单个 key；返回新 Set（展开集合是不可原地改的 React 状态）。 */
export function toggleExpandedKey(keys: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(keys);
  if (next.has(key)) {
    next.delete(key);
  } else {
    next.add(key);
  }
  return next;
}

function sessionSortValue(key: LedgerSessionSortKey, row: LedgerSessionRow): string | number {
  switch (key) {
    case "title":
      return (row.title ?? "").toLowerCase();
    case "calls":
      return row.calls;
    case "tokens":
      return row.inputTokens + row.outputTokens;
    case "cost":
      return row.cost ?? -1;
    case "lastActiveMs":
      return row.lastActiveMs ?? 0;
  }
}

/** 会话表比较器：口径与改造前一致（title 小写串比较、tokens 用 input+output、cost 空值取 -1）。 */
export function createSessionComparator(
  key: LedgerSessionSortKey,
  desc: boolean,
): (a: LedgerSessionRow, b: LedgerSessionRow) => number {
  return (a, b) => {
    const va = sessionSortValue(key, a);
    const vb = sessionSortValue(key, b);
    const result =
      typeof va === "string" || typeof vb === "string"
        ? String(va).localeCompare(String(vb))
        : va - vb;
    return desc ? -result : result;
  };
}
