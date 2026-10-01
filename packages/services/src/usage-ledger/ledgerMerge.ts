import type { LedgerDailyRow, LedgerRangeInfo, LedgerSnapshot, LedgerSource } from "@zcode/shared";

// 多源合并口径（与 WSL dump 脚本、单机聚合逐行对齐）：
//   计数求和；均值（耗时/首字延迟）按调用数加权；费用只累加「有定价」的源，
//   某个源没加载到价格表时它的费用是 null，当成 0 混进总额会让总数凭空少一截。

export interface LedgerSourcePayload {
  overview: LedgerSnapshot["overview"];
  hourlyToday: { hour: number; calls: number }[];
  daily: LedgerDailyRow[];
  models: LedgerSnapshot["models"];
  agents: LedgerSnapshot["agents"];
  sessions: LedgerSnapshot["sessions"];
  recent: LedgerSnapshot["recent"];
  errors: LedgerSnapshot["errors"];
  facets: LedgerSnapshot["facets"];
  pricesLoaded: boolean;
  priceMeta: LedgerSnapshot["priceMeta"];
}

export type LabelledLedgerPayload = LedgerSourcePayload & {
  sourceLabel: string;
  sourceKey: string;
};

interface AccRow {
  calls: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  durSum: number;
  durWeight: number;
  cost: number | null;
}

function newAcc(): AccRow {
  return {
    calls: 0,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    reasoningTokens: 0,
    durSum: 0,
    durWeight: 0,
    cost: null,
  };
}

function accWeightedAvg(row: { durSum: number; durWeight: number }): number | null {
  return row.durWeight ? Math.round(row.durSum / row.durWeight) : null;
}

function emptyOverview(): LedgerSnapshot["overview"] {
  return {
    calls: 0,
    completed: 0,
    errors: 0,
    cancelled: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    avgDurationMs: null,
    avgTtftMs: null,
    activeDays: 0,
    todayCalls: 0,
    todayTokens: 0,
    todayCost: null,
    monthCalls: 0,
    monthTokens: 0,
    monthCost: null,
    // 必须显式给 0：merge 里走 `ov.unpricedCalls += …`，undefined 起步会算出 NaN，
    // 而 NaN 能穿过 `?? 0` 直接炸 Zod 校验（dev 实测踩过）。
    unpricedCalls: 0,
  };
}

export function emptyLedgerPayload(): LedgerSourcePayload {
  return {
    overview: emptyOverview(),
    hourlyToday: Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 })),
    daily: [],
    models: [],
    agents: [],
    sessions: [],
    recent: [],
    errors: [],
    facets: { providers: [], models: [] },
    pricesLoaded: false,
    priceMeta: null,
  };
}

/**
 * 把多个数据源的聚合结果合并成一份快照主体。
 * parts 里各源已带 sourceLabel/sourceKey；sources 是全部来源的状态行（含未选中的）。
 */
export function mergeLedgerPayloads(
  parts: LabelledLedgerPayload[],
  sources: LedgerSource[],
  range: LedgerRangeInfo,
): Omit<LedgerSnapshot, "generatedAt"> {
  const usable = parts.filter((p) => p);
  if (usable.length === 0) {
    return {
      range,
      overview: emptyOverview(),
      hourlyToday: Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 })),
      daily: [],
      models: [],
      agents: [],
      sessions: [],
      recent: [],
      errors: [],
      facets: { providers: [], models: [] },
      sources,
      pricesLoaded: false,
      priceMeta: null,
    };
  }

  const ov = emptyOverview();
  let durSum = 0;
  let ttftSum = 0;
  let weight = 0;
  const unpricedModels = new Set<string>();
  for (const p of usable) {
    const o = p.overview;
    for (const key of [
      "calls",
      "completed",
      "errors",
      "cancelled",
      "inputTokens",
      "outputTokens",
      "reasoningTokens",
      "cacheReadTokens",
      "todayCalls",
      "todayTokens",
      "monthCalls",
      "monthTokens",
      "unpricedCalls",
    ] as const) {
      ov[key] += o[key] ?? 0;
    }
    // 费用只累加「有定价」的源：某个源没加载到价格表时它的费用是 null，
    // 当成 0 混进总额会让总数凭空少一截而看不出原因
    for (const key of ["cost", "todayCost", "monthCost"] as const) {
      const value = o[key];
      if (value !== null && value !== undefined) {
        ov[key] = (ov[key] ?? 0) + value;
      }
    }
    for (const id of o.unpricedModelIds ?? []) {
      unpricedModels.add(id);
    }
    const calls = o.calls || 0;
    if (calls) {
      durSum += (o.avgDurationMs ?? 0) * calls;
      ttftSum += (o.avgTtftMs ?? 0) * calls;
      weight += calls;
    }
  }
  ov.avgDurationMs = weight ? Math.round(durSum / weight) : null;
  ov.avgTtftMs = weight ? Math.round(ttftSum / weight) : null;
  if (usable.some((p) => p.overview.cost !== null && p.overview.cost !== undefined)) {
    ov.cost = ov.cost ?? 0;
    ov.unpricedCalls = ov.unpricedCalls ?? 0;
    ov.unpricedModelIds = [...unpricedModels].sort();
  }

  const dailyMap = new Map<string, AccRow>();
  for (const p of usable) {
    for (const r of p.daily) {
      const d = dailyMap.get(r.date) ?? newAcc();
      d.calls += r.calls;
      d.errors += r.errors;
      d.inputTokens += r.inputTokens;
      d.outputTokens += r.outputTokens;
      d.cacheReadTokens += r.cacheReadTokens;
      d.reasoningTokens += r.reasoningTokens;
      if (r.calls && r.avgDurationMs !== null) {
        d.durSum += r.avgDurationMs * r.calls;
        d.durWeight += r.calls;
      }
      if (r.cost !== null) {
        d.cost = (d.cost ?? 0) + r.cost;
      }
      dailyMap.set(r.date, d);
    }
  }
  const daily: LedgerDailyRow[] = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, d]) => ({
      date,
      calls: d.calls,
      errors: d.errors,
      inputTokens: d.inputTokens,
      outputTokens: d.outputTokens,
      cacheReadTokens: d.cacheReadTokens,
      reasoningTokens: d.reasoningTokens,
      avgDurationMs: accWeightedAvg(d),
      cost: d.cost,
    }));
  ov.activeDays = daily.length;

  const hourly = Array.from({ length: 24 }, (_, hour) => ({ hour, calls: 0 }));
  for (const p of usable) {
    p.hourlyToday.forEach((bucket, i) => {
      if (hourly[i]) {
        hourly[i].calls += bucket.calls;
      }
    });
  }

  const modelsMap = new Map<
    string,
    LedgerSnapshot["models"][number] & { durSum: number; durWeight: number }
  >();
  for (const p of usable) {
    for (const m of p.models) {
      const k = `${m.model ?? ""}\u0000${m.provider}`;
      const t = modelsMap.get(k) ?? {
        model: m.model,
        provider: m.provider,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        avgDurationMs: null,
        cost: null,
        durSum: 0,
        durWeight: 0,
      };
      t.calls += m.calls;
      t.inputTokens += m.inputTokens;
      t.outputTokens += m.outputTokens;
      t.cacheReadTokens += m.cacheReadTokens;
      if (m.cost !== null) {
        t.cost = (t.cost ?? 0) + m.cost;
      }
      if (m.calls && m.avgDurationMs !== null) {
        t.durSum += m.avgDurationMs * m.calls;
        t.durWeight += m.calls;
      }
      modelsMap.set(k, t);
    }
  }
  const models = [...modelsMap.values()]
    .sort((a, b) => b.calls - a.calls)
    .map((t) => ({
      model: t.model,
      provider: t.provider,
      calls: t.calls,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      cacheReadTokens: t.cacheReadTokens,
      avgDurationMs: accWeightedAvg(t),
      cost: t.cost,
    }));

  const agentsMap = new Map<string, LedgerSnapshot["agents"][number]>();
  for (const p of usable) {
    for (const a of p.agents) {
      const t = agentsMap.get(a.agent) ?? {
        agent: a.agent,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cost: null,
      };
      t.calls += a.calls;
      t.inputTokens += a.inputTokens;
      t.outputTokens += a.outputTokens;
      t.cacheReadTokens += a.cacheReadTokens;
      if (a.cost !== null) {
        t.cost = (t.cost ?? 0) + a.cost;
      }
      agentsMap.set(a.agent, t);
    }
  }

  // 合并后重排截断并打 src 标，让用户知道每行来自哪个数据源
  const sessions = usable
    .flatMap((p) => p.sessions.map((s) => ({ ...s, src: p.sourceLabel })))
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    .slice(0, 50);
  const recent = usable
    .flatMap((p) => p.recent.map((r) => ({ ...r, src: p.sourceLabel })))
    .sort((a, b) => (b.timeMs ?? 0) - (a.timeMs ?? 0))
    .slice(0, 100);

  const errorMap = new Map<string, number>();
  for (const p of usable) {
    for (const e of p.errors) {
      errorMap.set(e.type, (errorMap.get(e.type) ?? 0) + e.count);
    }
  }
  const errors = [...errorMap.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => b.count - a.count);

  const providerMap = new Map<string, { id: string | null; label: string; calls: number }>();
  for (const p of usable) {
    for (const f of p.facets.providers) {
      const t = providerMap.get(f.label) ?? { id: f.id, label: f.label, calls: 0 };
      t.calls += f.calls;
      providerMap.set(f.label, t);
    }
  }
  const modelFacetMap = new Map<string, number>();
  for (const p of usable) {
    for (const f of p.facets.models) {
      const k = f.id ?? "";
      modelFacetMap.set(k, (modelFacetMap.get(k) ?? 0) + f.calls);
    }
  }

  return {
    range,
    overview: ov,
    hourlyToday: hourly,
    daily,
    models,
    agents: [...agentsMap.values()].sort((a, b) => b.calls - a.calls),
    sessions,
    recent,
    errors,
    facets: {
      providers: [...providerMap.values()].sort((a, b) => b.calls - a.calls),
      models: [...modelFacetMap.entries()]
        .map(([id, calls]) => ({ id, calls }))
        .sort((a, b) => b.calls - a.calls),
    },
    sources,
    pricesLoaded: usable.some((p) => p.pricesLoaded),
    // 各源读的是同一份价格表，meta 取第一个即可
    priceMeta: usable.find((p) => p.priceMeta)?.priceMeta ?? null,
  };
}
