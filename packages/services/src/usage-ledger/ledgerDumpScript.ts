// 内嵌 WSL dump 脚本：桌面 host 不能跨文件系统直读 WSL 的 SQLite（UNC 上 WAL 会撞
// database is locked），把这份 Python 脚本和最终价格表写进临时目录，由 wsl.exe 送进
// 发行版用其自带 python3 执行，stdout 只回传单数据源的聚合 JSON。
// 口径与 ledgerReader.ts 的本机聚合逐行对齐，改动任一侧必须同步另一侧并跑对拍。
// 注意：脚本内不能新增变量赋值式的 sh 调用之外的东西——本文件只是 Python 源码模板。

export const LEDGER_DUMP_SCRIPT_VERSION = 1;

/** String.raw 保证 Python 源码里的 \n、\' 等转义按字面输出。 */
export const LEDGER_DUMP_SCRIPT_PY = String.raw`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ZCode 用量账本 --dump 模式（内部产物，勿单独修改）。

由 Windows 侧 ZCode 桌面端送进 WSL 执行：用自己的 python3 读自己的账本库，
只把聚合结果写回 stdout（bytes + utf-8，避免终端编码不一致）。
"""
import argparse, base64, datetime as dt, json, re, sqlite3, sys, time, urllib.parse

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def open_readonly(db_path):
    # mode=ro + query_only 双保险；timeout 即 busy_timeout，主程序写入瞬间最多等 3 秒
    uri = "file:" + urllib.parse.quote(str(db_path).replace("\\", "/")) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=3.0)
    con.execute("PRAGMA query_only=1")
    return con


def load_provider_names(path):
    """ZCode 把自定义供应商的用户命名存在 provider_config.json 里，只取 providerId/providerName
    两个展示字段，绝不读取或回传任何凭据字段。文件缺失/损坏时返回空表，显示名退回 id 短名。"""
    try:
        with open(path, "r", encoding="utf-8") as f:
            rules = json.load(f)["config"]["providerConfigRules"]["providerRules"]
    except (OSError, ValueError, KeyError, TypeError):
        return {}
    names = {}
    for r in rules:
        pid, name = r.get("providerId"), r.get("providerName")
        if pid and name:
            names[pid] = str(name)
    # 用户可能给两个供应商起同名，撞名时补 id 短名，否则筛选下拉里无法区分
    dup = {n for n in names.values() if list(names.values()).count(n) > 1}
    return {pid: (f"{n} ({pid[:8]})" if n in dup else n) for pid, n in names.items()}


def provider_label(pid, names):
    name = (names or {}).get(pid)
    if name:
        return name
    # 没有命名的：UUID 截短 8 位，account:/builtin: 这类渠道名保留全名（截尾会与同类渠道撞名）
    if UUID_RE.match(pid or ""):
        return pid[:8]
    return pid


def calc_cost(prices, model_id, input_tokens, output_tokens, cache_read):
    """按单价表算一次调用的费用；模型没定价返回 None（不计入、也不静默按 0 算）。"""
    if not prices:
        return None
    p = prices.get(str(model_id).lower())
    if not p:
        return None
    # 缓存读是输入的子集，按缓存价单独计，不能再按输入价计一遍
    return (
        input_tokens / 1e6 * float(p.get("input", 0))
        + output_tokens / 1e6 * float(p.get("output", 0))
        + cache_read / 1e6 * float(p.get("cacheRead", 0))
    )


def day_start_ms(offset_minutes, day):
    """某个时区里某一天 0 点对应的 epoch ms。"""
    base = dt.datetime(day.year, day.month, day.day) - dt.timedelta(minutes=offset_minutes)
    return int((base - dt.datetime(1970, 1, 1)).total_seconds() * 1000)


def day_idx_to_date(day_idx):
    """分桶日序号（(started_at + 偏移) // 86400000）转 YYYY-MM-DD。

    按天/按小时分桶全部用整数算术完成，不把任何修饰符字符串拼进 SQL；
    与 Windows 侧 ledgerReader.ts 的分桶算术逐行对齐。"""
    shifted = dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc) + dt.timedelta(days=day_idx)
    return shifted.strftime("%Y-%m-%d")


def decode_b64(value):
    """base64url（无 padding）解码来自 Windows 侧的可变筛选值。"""
    if not value:
        return None
    try:
        return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4)).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return None


def build_filters(scoped, from_ms, to_ms, provider_ids, model_id, alias=""):
    # 时间范围与供应商/模型是正交筛选，统一在这里拼条件；alias 供 join 查询加表前缀
    col = f"{alias}." if alias else ""
    conds, args = [], []
    if scoped:
        conds.append(f"{col}started_at >= ? AND {col}started_at <= ?")
        args += [from_ms, to_ms]
    if provider_ids:
        placeholders = ",".join("?" * len(provider_ids))
        conds.append(f"{col}provider_id IN ({placeholders})")
        args += list(provider_ids)
    if model_id:
        conds.append(f"{col}model_id = ?")
        args.append(model_id)
    return conds, args


def where_sql(conds, extra=()):
    all_conds = list(conds) + list(extra)
    return ("WHERE " + " AND ".join(all_conds)) if all_conds else ""


def build_source_payload(db_path, provider_config_path, prices_path, from_ms, to_ms,
                         tz_offset_minutes, provider_label_filter, model_id):
    """聚合一个数据源（一份 ZCode 安装）。结构与 host 侧单源 payload 一致，可多份合并。"""
    now_ms = int(time.time() * 1000)
    scoped = from_ms is not None
    try:
        with open(prices_path, "r", encoding="utf-8") as f:
            raw_prices = json.load(f)
        price_meta = raw_prices.get("_meta") if isinstance(raw_prices.get("_meta"), dict) else {}
        prices = {str(k).lower(): v for k, v in raw_prices.items()
                  if not str(k).startswith("_") and isinstance(v, dict)}
    except (OSError, ValueError):
        prices, price_meta = {}, {}
    provider_names = load_provider_names(provider_config_path)
    offset_ms = tz_offset_minutes * 60_000
    shifted = dt.datetime.fromtimestamp(now_ms / 1000, dt.timezone.utc) + dt.timedelta(minutes=tz_offset_minutes)
    today = shifted.date()
    today0 = day_start_ms(tz_offset_minutes, today)
    month0 = day_start_ms(tz_offset_minutes, today.replace(day=1))

    conds_date, args_date = build_filters(scoped, from_ms, to_ms, None, None)

    con = open_readonly(db_path)
    try:
        cur = con.cursor()

        # 先拿时间范围内的供应商清单：既做下拉选项，也用来把筛选用的显示名解析成本地 id
        facet_providers = cur.execute(
            f"SELECT provider_id, COUNT(*) FROM model_usage {where_sql(conds_date)} "
            "GROUP BY provider_id ORDER BY COUNT(*) DESC",
            args_date,
        ).fetchall()
        provider_ids = []
        if provider_label_filter:
            provider_ids = [pid for pid, _ in facet_providers
                            if provider_label(pid, provider_names) == provider_label_filter]

        conds, args = build_filters(scoped, from_ms, to_ms, provider_ids, model_id)
        conds_m, args_m = build_filters(scoped, from_ms, to_ms, provider_ids, model_id, alias="m")

        row = cur.execute(
            f"""
            SELECT COUNT(*),
                   SUM(status = 'completed'), SUM(status = 'error'), SUM(status = 'cancelled'),
                   SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens),
                   SUM(cache_read_input_tokens),
                   CAST(ROUND(AVG(duration_ms)) AS INTEGER),
                   CAST(ROUND(AVG(time_to_first_token_ms)) AS INTEGER)
            FROM model_usage {where_sql(conds)}
            """,
            args,
        ).fetchone()
        overview = {
            "calls": row[0] or 0,
            "completed": row[1] or 0,
            "errors": row[2] or 0,
            "cancelled": row[3] or 0,
            "inputTokens": row[4] or 0,
            "outputTokens": row[5] or 0,
            "reasoningTokens": row[6] or 0,
            "cacheReadTokens": row[7] or 0,
            "avgDurationMs": row[8],
            "avgTtftMs": row[9],
        }

        # 今天/本月是固定口径的 KPI，不随所选范围变化
        def window_totals(start_ms):
            wc, wa = build_filters(True, start_ms, now_ms, provider_ids, model_id)
            # 缓存读是输入的子集，只计输入+输出，否则缓存量会被算两遍
            r = cur.execute(
                "SELECT COUNT(*), SUM(input_tokens + output_tokens) "
                f"FROM model_usage {where_sql(wc)}",
                wa,
            ).fetchone()
            # 费用要按模型分组算（每个模型单价不同），不能对总量直接乘一个价
            cost = None
            if prices:
                cost = 0.0
                for mid, i, o, cr in cur.execute(
                    "SELECT model_id, SUM(input_tokens), SUM(output_tokens), "
                    f"SUM(cache_read_input_tokens) FROM model_usage {where_sql(wc)} GROUP BY model_id",
                    wa,
                ).fetchall():
                    cost += calc_cost(prices, mid, i or 0, o or 0, cr or 0) or 0.0
            return r[0] or 0, r[1] or 0, cost

        overview["todayCalls"], overview["todayTokens"], overview["todayCost"] = window_totals(today0)
        overview["monthCalls"], overview["monthTokens"], overview["monthCost"] = window_totals(month0)

        # 今日各小时密度条：横轴固定 0–23 时，未来小时留空，与「今日」KPI 同一口径。
        # 分桶用整数算术（(started_at + 偏移) 落在当日内，模一天的小时数），不经字符串修饰符
        hc, ha = build_filters(True, today0, now_ms, provider_ids, model_id)
        ha = [offset_ms] + list(ha)
        counts = dict(
            cur.execute(
                "SELECT CAST((COALESCE(started_at, 0) + ?) % 86400000 / 3600000 AS INTEGER) AS bucket, "
                f"COUNT(*) FROM model_usage {where_sql(hc)} GROUP BY bucket",
                ha,
            ).fetchall()
        )
        hourly_today = [
            {"hour": hour, "calls": counts.get(hour, 0)}
            for hour in range(24)
        ]

        # 每日趋势按 (日期, 模型) 分组取出，再折叠成每天一行：费用依赖模型单价，
        # 必须先按模型算清再按天汇总（按模型拆费用的视图由模型表和饼图承担）
        daily_map = {}
        d_args = [offset_ms] + list(args)
        for d, mid, calls, errors, it, ot, cr, rt, dur in cur.execute(
            f"""
            SELECT CAST((COALESCE(started_at, 0) + ?) / 86400000 AS INTEGER) AS d,
                   model_id, COUNT(*),
                   SUM(status = 'error'), SUM(input_tokens), SUM(output_tokens),
                   SUM(cache_read_input_tokens), SUM(reasoning_tokens),
                   CAST(ROUND(AVG(duration_ms)) AS INTEGER)
            FROM model_usage {where_sql(conds)} GROUP BY d, model_id ORDER BY d ASC
            """,
            d_args,
        ).fetchall():
            date = day_idx_to_date(d)
            row = daily_map.setdefault(date, {
                "date": date, "calls": 0, "errors": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheReadTokens": 0, "reasoningTokens": 0, "cost": None,
                "durSum": 0, "durWeight": 0,
            })
            row["calls"] += calls
            row["errors"] += errors or 0
            row["inputTokens"] += it or 0
            row["outputTokens"] += ot or 0
            row["cacheReadTokens"] += cr or 0
            row["reasoningTokens"] += rt or 0
            if calls and dur is not None:
                row["durSum"] += dur * calls
                row["durWeight"] += calls
            c = calc_cost(prices, mid, it or 0, ot or 0, cr or 0)
            if c is not None:
                row["cost"] = (row["cost"] or 0.0) + c
        daily = []
        for d in sorted(daily_map.values(), key=lambda x: x["date"]):
            daily.append({
                "date": d["date"], "calls": d["calls"], "errors": d["errors"],
                "inputTokens": d["inputTokens"], "outputTokens": d["outputTokens"],
                "cacheReadTokens": d["cacheReadTokens"], "reasoningTokens": d["reasoningTokens"],
                "avgDurationMs": round(d["durSum"] / d["durWeight"]) if d["durWeight"] else None,
                "cost": d["cost"],
            })

        models = []
        total_cost = 0.0
        unpriced_calls = 0
        unpriced_models = set()
        for r in cur.execute(
            f"""
            SELECT model_id, provider_id, COUNT(*), SUM(input_tokens), SUM(output_tokens),
                   SUM(cache_read_input_tokens), CAST(ROUND(AVG(duration_ms)) AS INTEGER)
            FROM model_usage {where_sql(conds)} GROUP BY model_id, provider_id ORDER BY COUNT(*) DESC
            """,
            args,
        ).fetchall():
            cost = calc_cost(prices, r[0], r[3] or 0, r[4] or 0, r[5] or 0)
            if cost is not None:
                total_cost += cost
            else:
                # 没定价的模型不计费，但要记账：否则总数会被静默少算而无人知道
                unpriced_calls += r[2]
                unpriced_models.add(r[0])
            models.append(
                {
                    "model": r[0],
                    "provider": provider_label(r[1], provider_names),
                    "calls": r[2],
                    "inputTokens": r[3] or 0,
                    "outputTokens": r[4] or 0,
                    "cacheReadTokens": r[5] or 0,
                    "avgDurationMs": r[6],
                    "cost": cost,
                }
            )
        if prices:
            overview["cost"] = total_cost
            overview["unpricedCalls"] = unpriced_calls
            overview["unpricedModelIds"] = sorted(unpriced_models)

        # Agent 分布同样按 (agent, 模型) 分组再折叠，费用才能按 agent 汇总
        agents_map = {}
        for agent, mid, calls, it, ot, cr in cur.execute(
            f"""
            SELECT COALESCE(agent, 'unknown'), model_id, COUNT(*), SUM(input_tokens),
                   SUM(output_tokens), SUM(cache_read_input_tokens)
            FROM model_usage {where_sql(conds)} GROUP BY agent, model_id ORDER BY COUNT(*) DESC
            """,
            args,
        ).fetchall():
            row = agents_map.setdefault(agent, {
                "agent": agent, "calls": 0, "inputTokens": 0,
                "outputTokens": 0, "cacheReadTokens": 0, "cost": None,
            })
            row["calls"] += calls
            row["inputTokens"] += it or 0
            row["outputTokens"] += ot or 0
            row["cacheReadTokens"] += cr or 0
            c = calc_cost(prices, mid, it or 0, ot or 0, cr or 0)
            if c is not None:
                row["cost"] = (row["cost"] or 0.0) + c
        agents = sorted(agents_map.values(), key=lambda x: -x["calls"])

        # 会话表按 (会话, 模型) 分组再折叠：一个会话里通常混用多个模型，费用要按模型分开算
        sessions_map = {}
        for sid, title, directory, mid, calls, it, ot, cr, last in cur.execute(
            f"""
            SELECT m.session_id, s.title, s.directory, m.model_id, COUNT(*),
                   SUM(m.input_tokens), SUM(m.output_tokens),
                   SUM(m.cache_read_input_tokens), MAX(m.started_at)
            FROM model_usage m JOIN session s ON s.id = m.session_id {where_sql(conds_m)}
            GROUP BY m.session_id, m.model_id
            """,
            args_m,
        ).fetchall():
            row = sessions_map.setdefault(sid, {
                "sessionId": sid, "title": title, "directory": directory,
                "calls": 0, "inputTokens": 0, "outputTokens": 0,
                "lastActiveMs": last, "cost": None,
            })
            row["calls"] += calls
            row["inputTokens"] += it or 0
            row["outputTokens"] += ot or 0
            if last is not None and (row["lastActiveMs"] or 0) < last:
                row["lastActiveMs"] = last
            c = calc_cost(prices, mid, it or 0, ot or 0, cr or 0)
            if c is not None:
                row["cost"] = (row["cost"] or 0.0) + c
        sessions = sorted(sessions_map.values(),
                          key=lambda s: -(s["inputTokens"] + s["outputTokens"]))[:200]

        recent = []
        for r in cur.execute(
            f"""
            SELECT started_at, model_id, provider_id, agent, status, error_type,
                   input_tokens, output_tokens, cache_read_input_tokens,
                   duration_ms, time_to_first_token_ms
            FROM model_usage {where_sql(conds)} ORDER BY started_at DESC LIMIT 100
            """,
            args,
        ).fetchall():
            recent.append(
                {
                    "timeMs": r[0],
                    "model": r[1],
                    "provider": provider_label(r[2], provider_names),
                    "agent": r[3],
                    "status": r[4],
                    "errorType": r[5],
                    "inputTokens": r[6] or 0,
                    "outputTokens": r[7] or 0,
                    "cacheReadTokens": r[8] or 0,
                    "durationMs": r[9],
                    "ttftMs": r[10],
                    "cost": calc_cost(prices, r[1], r[6] or 0, r[7] or 0, r[8] or 0),
                }
            )

        errors = [
            {"type": r[0], "count": r[1]}
            for r in cur.execute(
                f"""
                SELECT COALESCE(error_type, 'unknown') AS t, COUNT(*)
                FROM model_usage {where_sql(conds, ("status = 'error'",))} GROUP BY t ORDER BY COUNT(*) DESC
                """,
                args,
            ).fetchall()
        ]

        facets = {
            "providers": [
                {"id": pid, "label": provider_label(pid, provider_names), "calls": cnt}
                for pid, cnt in facet_providers
            ],
            "models": [
                {"id": r[0], "calls": r[1]}
                for r in cur.execute(
                    f"SELECT model_id, COUNT(*) FROM model_usage {where_sql(conds_date)} "
                    "GROUP BY model_id ORDER BY COUNT(*) DESC",
                    args_date,
                ).fetchall()
            ],
        }
    finally:
        con.close()

    return {
        "overview": overview,
        "hourlyToday": hourly_today,
        "daily": daily,
        "models": models,
        "agents": agents,
        "sessions": sessions,
        "recent": recent,
        "errors": errors,
        "facets": facets,
        "pricesLoaded": bool(prices),
        "priceMeta": price_meta if prices else None,
    }


def main():
    parser = argparse.ArgumentParser(description="ZCode 用量账本 WSL dump（内部）")
    parser.add_argument("--db", required=True)
    parser.add_argument("--provider-config", required=True)
    parser.add_argument("--prices", required=True)
    parser.add_argument("--from-ms", default="")
    parser.add_argument("--to-ms", default="")
    parser.add_argument("--tz-offset", type=int, required=True)
    # 可变筛选值走 base64url：wsl.exe 参数列表里不会出现原始用户字符串
    parser.add_argument("--provider-b64", default="")
    parser.add_argument("--model-b64", default="")
    args = parser.parse_args()
    payload = build_source_payload(
        args.db, args.provider_config, args.prices,
        int(args.from_ms) if args.from_ms else None,
        int(args.to_ms) if args.to_ms else None,
        args.tz_offset,
        decode_b64(args.provider_b64), decode_b64(args.model_b64),
    )
    sys.stdout.buffer.write(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
    sys.stdout.buffer.write(b"\n")


if __name__ == "__main__":
    main()
`;
