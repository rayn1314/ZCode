import type { LedgerSourcePayload } from "./ledgerMerge.js";
import { calcLedgerCost } from "./ledgerPrices.js";
import {
  buildFilters,
  newAcc,
  num,
  numOrNull,
  whereSql,
  type AccRow,
  type AggregateContext,
} from "./ledgerAggregateSql.js";
import { dayIdxToDateString, MS_PER_DAY } from "./ledgerRange.js";

export interface DbAdapter {
  queryAll(sql: string, args: (string | number)[]): Record<string, unknown>[];
  queryOne(sql: string, args: (string | number)[]): Record<string, unknown> | undefined;
}

// ── 单库聚合核心（本机 node:sqlite 与 WSL dump 共用同一套 SQL 口径）──────

export function aggregateFromDb(
  db: DbAdapter,
  ctx: AggregateContext,
  label: (pid: string | null) => string,
): LedgerSourcePayload {
  const { conds: dateConds, args: dateArgs } = buildFilters(
    ctx.scoped,
    ctx.fromMs,
    ctx.toMs,
    null,
    null,
  );

  // 先拿时间范围内的供应商清单：既做下拉选项，也用来把筛选用的显示名解析成本地 id
  const facetProviderRows = db.queryAll(
    `SELECT provider_id AS pid, COUNT(*) AS calls FROM model_usage ${whereSql(dateConds)}
     GROUP BY provider_id ORDER BY COUNT(*) DESC`,
    dateArgs,
  );
  const providerIds = ctx.providerLabelFilter
    ? facetProviderRows
        .map((r) => r.pid)
        .filter(
          (pid): pid is string => typeof pid === "string" && label(pid) === ctx.providerLabelFilter,
        )
    : [];

  const { conds, args } = buildFilters(ctx.scoped, ctx.fromMs, ctx.toMs, providerIds, ctx.modelId);
  const { conds: condsM, args: argsM } = buildFilters(
    ctx.scoped,
    ctx.fromMs,
    ctx.toMs,
    providerIds,
    ctx.modelId,
    "m",
  );
  const where = whereSql(conds);

  const overviewRow = db.queryOne(
    `SELECT COUNT(*) AS calls,
            SUM(status = 'completed') AS completed, SUM(status = 'error') AS errors,
            SUM(status = 'cancelled') AS cancelled,
            SUM(input_tokens) AS inputTokens, SUM(output_tokens) AS outputTokens,
            SUM(reasoning_tokens) AS reasoningTokens, SUM(cache_read_input_tokens) AS cacheReadTokens,
            CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS avgDurationMs,
            CAST(ROUND(AVG(time_to_first_token_ms)) AS INTEGER) AS avgTtftMs
     FROM model_usage ${where}`,
    args,
  );
  const overview: LedgerSourcePayload["overview"] = {
    calls: num(overviewRow?.calls),
    completed: num(overviewRow?.completed),
    errors: num(overviewRow?.errors),
    cancelled: num(overviewRow?.cancelled),
    inputTokens: num(overviewRow?.inputTokens),
    outputTokens: num(overviewRow?.outputTokens),
    reasoningTokens: num(overviewRow?.reasoningTokens),
    cacheReadTokens: num(overviewRow?.cacheReadTokens),
    avgDurationMs: numOrNull(overviewRow?.avgDurationMs),
    avgTtftMs: numOrNull(overviewRow?.avgTtftMs),
    activeDays: 0,
    todayCalls: 0,
    todayTokens: 0,
    todayCost: null,
    monthCalls: 0,
    monthTokens: 0,
    monthCost: null,
  };

  // 今天/本月是固定口径的 KPI，不随所选范围变化
  const windowTotals = (
    startMs: number,
  ): { calls: number; tokens: number; cost: number | null } => {
    const { conds: wc, args: wa } = buildFilters(
      true,
      startMs,
      ctx.nowMs,
      providerIds,
      ctx.modelId,
    );
    const row = db.queryOne(
      `SELECT COUNT(*) AS calls, SUM(input_tokens + output_tokens) AS tokens
       FROM model_usage ${whereSql(wc)}`,
      wa,
    );
    // 缓存读是输入的子集，只计输入+输出，否则缓存量会被算两遍；
    // 费用要按模型分组算（每个模型单价不同），不能对总量直接乘一个价
    let cost: number | null = null;
    if (ctx.priceTable.prices.size > 0) {
      cost = 0;
      for (const r of db.queryAll(
        `SELECT model_id AS mid, SUM(input_tokens) AS it, SUM(output_tokens) AS ot,
                SUM(cache_read_input_tokens) AS cr
         FROM model_usage ${whereSql(wc)} GROUP BY model_id`,
        wa,
      )) {
        cost +=
          calcLedgerCost(ctx.priceTable, r.mid as string | null, num(r.it), num(r.ot), num(r.cr)) ??
          0;
      }
    }
    return { calls: num(row?.calls), tokens: num(row?.tokens), cost };
  };

  const todayTotals = windowTotals(ctx.today0);
  const monthTotals = windowTotals(ctx.month0);

  // 今日各小时密度条：横轴固定 0–23 时，未来小时留空，与「今日」KPI 同一口径。
  // 分桶用整数算术（窗口已在「今日」内，对一天取模即得小时），不经字符串修饰符
  const { conds: hc, args: haBase } = buildFilters(
    true,
    ctx.today0,
    ctx.nowMs,
    providerIds,
    ctx.modelId,
  );
  const hourlyCounts = new Map<number, number>();
  for (const r of db.queryAll(
    `SELECT CAST((COALESCE(started_at, 0) + ?) % ${MS_PER_DAY} / 3600000 AS INTEGER) AS bucket,
            COUNT(*) AS calls
     FROM model_usage ${whereSql(hc)} GROUP BY bucket`,
    [ctx.tzOffsetMs, ...haBase],
  )) {
    const bucket = numOrNull(r.bucket);
    if (bucket !== null && bucket >= 0 && bucket < 24) {
      hourlyCounts.set(bucket, num(r.calls));
    }
  }
  const hourlyToday = Array.from({ length: 24 }, (_, hour) => ({
    hour,
    calls: hourlyCounts.get(hour) ?? 0,
  }));

  // 每日趋势按 (日期, 模型) 分组取出，再折叠成每天一行：费用依赖模型单价，
  // 必须先按模型算清再按天汇总（按模型拆费用的视图由模型表和饼图承担）
  const dailyMap = new Map<string, AccRow>();
  for (const r of db.queryAll(
    `SELECT CAST((COALESCE(started_at, 0) + ?) / ${MS_PER_DAY} AS INTEGER) AS dayIdx,
            model_id AS mid, COUNT(*) AS calls,
            SUM(status = 'error') AS errors, SUM(input_tokens) AS it, SUM(output_tokens) AS ot,
            SUM(cache_read_input_tokens) AS cr, SUM(reasoning_tokens) AS rt,
            CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS dur
     FROM model_usage ${where} GROUP BY dayIdx, model_id ORDER BY dayIdx ASC`,
    [ctx.tzOffsetMs, ...args],
  )) {
    const dayIdx = numOrNull(r.dayIdx);
    if (dayIdx === null) {
      continue;
    }
    const date = dayIdxToDateString(dayIdx);
    const row = dailyMap.get(date) ?? newAcc();
    const calls = num(r.calls);
    row.calls += calls;
    row.errors += num(r.errors);
    row.inputTokens += num(r.it);
    row.outputTokens += num(r.ot);
    row.cacheReadTokens += num(r.cr);
    row.reasoningTokens += num(r.rt);
    const dur = numOrNull(r.dur);
    if (calls && dur !== null) {
      row.durSum += dur * calls;
      row.durWeight += calls;
    }
    const cost = calcLedgerCost(
      ctx.priceTable,
      r.mid as string | null,
      num(r.it),
      num(r.ot),
      num(r.cr),
    );
    if (cost !== null) {
      row.cost = (row.cost ?? 0) + cost;
    }
    dailyMap.set(date, row);
  }
  const daily = [...dailyMap.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, row]) => ({
      date,
      calls: row.calls,
      errors: row.errors,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      cacheReadTokens: row.cacheReadTokens,
      reasoningTokens: row.reasoningTokens,
      avgDurationMs: row.durWeight ? Math.round(row.durSum / row.durWeight) : null,
      cost: row.cost,
    }));

  const models: LedgerSourcePayload["models"] = [];
  let totalCost = 0;
  let unpricedCalls = 0;
  const unpricedModels = new Set<string>();
  for (const r of db.queryAll(
    `SELECT model_id AS mid, provider_id AS pid, COUNT(*) AS calls, SUM(input_tokens) AS it,
            SUM(output_tokens) AS ot, SUM(cache_read_input_tokens) AS cr,
            CAST(ROUND(AVG(duration_ms)) AS INTEGER) AS dur
     FROM model_usage ${where} GROUP BY model_id, provider_id ORDER BY COUNT(*) DESC`,
    args,
  )) {
    const modelId = (r.mid as string | null) ?? null;
    const calls = num(r.calls);
    const cost = calcLedgerCost(ctx.priceTable, modelId, num(r.it), num(r.ot), num(r.cr));
    if (cost !== null) {
      totalCost += cost;
    } else {
      // 没定价的模型不计费，但要记账：否则总数会被静默少算而无人知道
      unpricedCalls += calls;
      if (modelId) {
        unpricedModels.add(modelId);
      }
    }
    models.push({
      model: modelId,
      provider: label(r.pid as string | null),
      calls,
      inputTokens: num(r.it),
      outputTokens: num(r.ot),
      cacheReadTokens: num(r.cr),
      avgDurationMs: numOrNull(r.dur),
      cost,
    });
  }
  if (ctx.priceTable.prices.size > 0) {
    overview.cost = totalCost;
    overview.unpricedCalls = unpricedCalls;
    overview.unpricedModelIds = [...unpricedModels].sort();
  }

  // Agent 分布同样按 (agent, 模型) 分组再折叠，费用才能按 agent 汇总
  const agentsMap = new Map<string, LedgerSourcePayload["agents"][number]>();
  for (const r of db.queryAll(
    `SELECT COALESCE(agent, 'unknown') AS agent, model_id AS mid, COUNT(*) AS calls,
            SUM(input_tokens) AS it, SUM(output_tokens) AS ot, SUM(cache_read_input_tokens) AS cr
     FROM model_usage ${where} GROUP BY agent, model_id ORDER BY COUNT(*) DESC`,
    args,
  )) {
    const agent = (r.agent as string) ?? "unknown";
    const row = agentsMap.get(agent) ?? {
      agent,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cost: null,
    };
    row.calls += num(r.calls);
    row.inputTokens += num(r.it);
    row.outputTokens += num(r.ot);
    row.cacheReadTokens += num(r.cr);
    const cost = calcLedgerCost(
      ctx.priceTable,
      r.mid as string | null,
      num(r.it),
      num(r.ot),
      num(r.cr),
    );
    if (cost !== null) {
      row.cost = (row.cost ?? 0) + cost;
    }
    agentsMap.set(agent, row);
  }

  // 会话表按 (会话, 模型) 分组再折叠：一个会话里通常混用多个模型，费用要按模型分开算
  const sessionsMap = new Map<string, LedgerSourcePayload["sessions"][number]>();
  for (const r of db.queryAll(
    `SELECT m.session_id AS sid, s.title AS title, s.directory AS directory, m.model_id AS mid,
            COUNT(*) AS calls, SUM(m.input_tokens) AS it, SUM(m.output_tokens) AS ot,
            SUM(m.cache_read_input_tokens) AS cr, MAX(m.started_at) AS last
     FROM model_usage m JOIN session s ON s.id = m.session_id ${whereSql(condsM)}
     GROUP BY m.session_id, m.model_id`,
    argsM,
  )) {
    const sid = (r.sid as string) ?? "";
    if (!sid) {
      continue;
    }
    const row = sessionsMap.get(sid) ?? {
      sessionId: sid,
      title: (r.title as string | null) ?? null,
      directory: (r.directory as string | null) ?? null,
      calls: 0,
      inputTokens: 0,
      outputTokens: 0,
      lastActiveMs: numOrNull(r.last),
      cost: null,
    };
    row.calls += num(r.calls);
    row.inputTokens += num(r.it);
    row.outputTokens += num(r.ot);
    const last = numOrNull(r.last);
    if (last !== null && (row.lastActiveMs ?? 0) < last) {
      row.lastActiveMs = last;
    }
    const cost = calcLedgerCost(
      ctx.priceTable,
      r.mid as string | null,
      num(r.it),
      num(r.ot),
      num(r.cr),
    );
    if (cost !== null) {
      row.cost = (row.cost ?? 0) + cost;
    }
    sessionsMap.set(sid, row);
  }
  const sessions = [...sessionsMap.values()]
    .sort((a, b) => b.inputTokens + b.outputTokens - (a.inputTokens + a.outputTokens))
    .slice(0, 200);

  const recent: LedgerSourcePayload["recent"] = [];
  for (const r of db.queryAll(
    `SELECT started_at AS timeMs, model_id AS mid, provider_id AS pid, agent, status,
            error_type AS errorType, input_tokens AS it, output_tokens AS ot,
            cache_read_input_tokens AS cr, duration_ms AS dur, time_to_first_token_ms AS ttft
     FROM model_usage ${where} ORDER BY started_at DESC LIMIT 500`,
    args,
  )) {
    const modelId = (r.mid as string | null) ?? null;
    const it = num(r.it);
    const ot = num(r.ot);
    const cr = num(r.cr);
    recent.push({
      timeMs: numOrNull(r.timeMs),
      model: modelId,
      provider: label(r.pid as string | null),
      agent: (r.agent as string | null) ?? null,
      status: (r.status as string | null) ?? null,
      errorType: (r.errorType as string | null) ?? null,
      inputTokens: it,
      outputTokens: ot,
      cacheReadTokens: cr,
      durationMs: numOrNull(r.dur),
      ttftMs: numOrNull(r.ttft),
      cost: calcLedgerCost(ctx.priceTable, modelId, it, ot, cr),
    });
  }

  const errors = db
    .queryAll(
      `SELECT COALESCE(error_type, 'unknown') AS type, COUNT(*) AS count
       FROM model_usage ${whereSql(conds, ["status = 'error'"])} GROUP BY type ORDER BY COUNT(*) DESC`,
      args,
    )
    .map((r) => ({ type: (r.type as string) ?? "unknown", count: num(r.count) }));

  const facets: LedgerSourcePayload["facets"] = {
    providers: facetProviderRows.map((r) => ({
      id: (r.pid as string | null) ?? null,
      label: label(r.pid as string | null),
      calls: num(r.calls),
    })),
    models: db
      .queryAll(
        `SELECT model_id AS id, COUNT(*) AS calls FROM model_usage ${whereSql(dateConds)}
         GROUP BY model_id ORDER BY COUNT(*) DESC`,
        dateArgs,
      )
      .map((r) => ({ id: (r.id as string | null) ?? null, calls: num(r.calls) })),
  };

  overview.activeDays = daily.length;
  return {
    overview: {
      ...overview,
      todayCalls: todayTotals.calls,
      todayTokens: todayTotals.tokens,
      todayCost: todayTotals.cost,
      monthCalls: monthTotals.calls,
      monthTokens: monthTotals.tokens,
      monthCost: monthTotals.cost,
    },
    hourlyToday,
    daily,
    models,
    agents: [...agentsMap.values()].sort((a, b) => b.calls - a.calls),
    sessions,
    recent,
    errors,
    facets,
    pricesLoaded: ctx.priceTable.prices.size > 0,
    priceMeta: ctx.priceTable.prices.size > 0 ? ctx.priceTable.meta : null,
  };
}
