// 会话层级（父子关系）纯函数层：无 IO、无 await，是账本会话表的唯一算法来源。
// WSL 侧的 Python dump（ledgerDumpScript.ts）用同一套口径另行实现，改动这里必须同步那边。
// 口径见 spec/usage-ledger.md「会话层级」：每行 = 自身 + 全部后代，fork 断边，按顶层会话配额保父链截断。

export interface LedgerSessionFact {
  sessionId: string;
  title: string | null;
  directory: string | null;
  taskType: string | null;
  parentSessionId: string | null;
  /** 数据源标（多源合并后才有）；关系键要用到它，见 `factKey`。 */
  src?: string;
  /** 以下均为「自身」用量（未 rollup 前）。 */
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cost: number | null;
  lastActiveMs: number | null;
}

export interface LedgerSessionTreeRow extends LedgerSessionFact {
  childCount: number;
}

/** 沿父链向上/向下的步数上限：父链脏数据（自引用、环）时静默截断，绝不死循环。 */
const MAX_PARENT_HOPS = 64;

/**
 * 关系键 = 「来源 + 会话 id」。父子关系只能在同一数据源内成立，而同一会话可能在多个数据根
 * 各有一份（身份迁移产生的同 id 副本）：只看 id 会让两个源的同 id 行互相认亲——A 根的子行
 * 挂到 B 根的父行名下，那个父行还会因此被连带保留或丢弃。
 */
function factKey(fact: { src?: string | null; sessionId: string }): string {
  return `${fact.src ?? ""}\u0000${fact.sessionId}`;
}

function factParentKey(fact: {
  src?: string | null;
  parentSessionId: string | null;
}): string | null {
  return fact.parentSessionId === null ? null : `${fact.src ?? ""}\u0000${fact.parentSessionId}`;
}

/**
 * fork 不属于层级：fork 会话的父边一律断开（fork 是从某会话复制出的独立分支，
 * 把它的用量算回来源会话会让来源行凭空翻倍）。返回新数组，不改入参。
 */
export function breakForkEdges(facts: LedgerSessionFact[]): LedgerSessionFact[] {
  return facts.map((f) => (f.taskType === "fork" ? { ...f, parentSessionId: null } : f));
}

/** 把每行的数值替换为「自身 + 全部后代」的合计；返回顺序与入参一致。 */
export function rollupSubtrees(facts: LedgerSessionFact[]): LedgerSessionTreeRow[] {
  const rows = breakForkEdges(facts);
  // 自身快照与累加器必须分开：累加器边加边改，只读自身快照才不会把已累加的结果再加一遍
  const self = new Map<string, LedgerSessionFact>();
  const acc = new Map<string, LedgerSessionTreeRow>();
  const parentOf = new Map<string, string | null>();
  for (const f of rows) {
    const key = factKey(f);
    self.set(key, f);
    acc.set(key, { ...f, childCount: 0 });
    parentOf.set(key, factParentKey(f));
  }
  for (const f of rows) {
    const key = factKey(f);
    const parentKey = parentOf.get(key) ?? null;
    // childCount 按断边后的直接父计；自引用不计入
    if (parentKey !== null && parentKey !== key) {
      const parent = acc.get(parentKey);
      if (parent) {
        parent.childCount += 1;
      }
    }
  }
  for (const f of rows) {
    const key = factKey(f);
    const own = self.get(key);
    if (!own) {
      continue;
    }
    let parentKey = parentOf.get(key) ?? null;
    for (let hops = 0; hops < MAX_PARENT_HOPS; hops += 1) {
      if (parentKey === null || parentKey === key) {
        break;
      }
      const target = acc.get(parentKey);
      if (!target) {
        // 父不在集合里（孤儿/未命中）：没有任何祖先可挂，停止向上
        break;
      }
      target.calls += own.calls;
      target.inputTokens += own.inputTokens;
      target.outputTokens += own.outputTokens;
      if (own.cost !== null) {
        target.cost = (target.cost ?? 0) + own.cost;
      }
      if (own.lastActiveMs !== null) {
        target.lastActiveMs =
          target.lastActiveMs === null
            ? own.lastActiveMs
            : Math.max(target.lastActiveMs, own.lastActiveMs);
      }
      parentKey = parentOf.get(parentKey) ?? null;
    }
  }
  return rows.map((f) => acc.get(factKey(f)) ?? { ...f, childCount: 0 });
}

/**
 * 按顶层会话配额截断，并保证父链完整（不允许「看得到子行看不到父行」的悬浮行）。
 * 单遍扫描即成立：父的子树 tokens ≥ 任何后代的子树 tokens，加上 depth 升序 tie-break，
 * 父必然先于子被处理，所以「父在集合里却没被保留就丢弃该行」这条规则能保住整棵子树。
 */
export function selectLedgerSessionRows(
  rows: LedgerSessionTreeRow[],
  topLevelQuota: number,
): LedgerSessionTreeRow[] {
  const presentKeys = new Set(rows.map(factKey));
  const byKey = new Map(rows.map((r) => [factKey(r), r]));
  const depthCache = new Map<string, number>();
  const depth = (row: LedgerSessionTreeRow): number => {
    const key = factKey(row);
    const cached = depthCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const seen = new Set<string>([key]);
    let hops = 0;
    let parentKey = factParentKey(row);
    while (
      parentKey !== null &&
      presentKeys.has(parentKey) &&
      !seen.has(parentKey) &&
      hops < MAX_PARENT_HOPS
    ) {
      seen.add(parentKey);
      hops += 1;
      const parent = byKey.get(parentKey);
      parentKey = parent ? factParentKey(parent) : null;
    }
    depthCache.set(key, hops);
    return hops;
  };
  const sorted = [...rows].sort((a, b) => {
    const byTokens = b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens);
    if (byTokens !== 0) {
      return byTokens;
    }
    const byDepth = depth(a) - depth(b);
    if (byDepth !== 0) {
      return byDepth;
    }
    return a.sessionId < b.sessionId ? -1 : a.sessionId > b.sessionId ? 1 : 0;
  });

  const kept = new Set<string>();
  let roots = 0;
  const out: LedgerSessionTreeRow[] = [];
  for (const row of sorted) {
    const parentKey = factParentKey(row);
    if (parentKey !== null && presentKeys.has(parentKey)) {
      if (!kept.has(parentKey)) {
        // 父在入参集合里却没被保留：子行不能孤立出现
        continue;
      }
    } else if (roots < topLevelQuota) {
      roots += 1;
    } else {
      continue;
    }
    kept.add(factKey(row));
    out.push(row);
  }
  return out;
}
