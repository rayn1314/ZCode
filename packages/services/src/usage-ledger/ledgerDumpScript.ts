// 内嵌 WSL dump 脚本：桌面 host 不能跨文件系统直读 WSL 的 SQLite（UNC 上 WAL 会撞
// database is locked），把这份 Python 脚本和最终价格表写进临时目录，由 wsl.exe 送进
// 发行版用其自带 python3 执行，stdout 只回传单数据源的聚合 JSON。
// 口径与 ledgerAggregate.ts 的本机聚合逐行对齐，改动任一侧必须同步另一侧并跑对拍。
// 行数约束：本文件受根 oxlint max-lines: 400 约束，且模板串内的 Python 行全部算代码行；
// 脚本内的多行 dict / 多行 SQL 已按此压缩，动这里之前先量一遍行数（勿随手展开）。
// 注意：脚本内不能新增变量赋值式的 sh 调用之外的东西——本文件只是 Python 源码模板。

export const LEDGER_DUMP_SCRIPT_VERSION = 3;

/** String.raw 保证 Python 源码里的 \n、\' 等转义按字面输出。 */
export const LEDGER_DUMP_SCRIPT_PY = String.raw`#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ZCode 用量账本 --dump 模式（内部产物，勿单独修改）：由 Windows 侧送进 WSL，用其自带 python3 读自己的账本库，只把聚合 JSON 写回 stdout（bytes + utf-8，避免终端编码不一致）。"""
import argparse, base64, datetime as dt, json, re, sqlite3, sys, time, urllib.parse

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def open_readonly(db_path):
    # mode=ro + query_only 双保险；timeout 即 busy_timeout，主程序写入瞬间最多等 3 秒
    uri = "file:" + urllib.parse.quote(str(db_path).replace("\\", "/")) + "?mode=ro"
    con = sqlite3.connect(uri, uri=True, timeout=3.0)
    con.execute("PRAGMA query_only=1")
    return con


def load_provider_names(path):
    """只取 provider_config.json 的 providerId/providerName 两个展示字段，绝不读取或回传任何凭据字段；文件缺失/损坏返回空表，显示名退回 id 短名。"""
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
    # input_tokens 本就含 cacheRead，命中部分先扣掉再乘输入价（与 ledgerPrices.ts calcLedgerCost 同口径，防双重计费）
    return (max(0, input_tokens - cache_read) / 1e6 * float(p.get("input", 0))
            + output_tokens / 1e6 * float(p.get("output", 0))
            + cache_read / 1e6 * float(p.get("cacheRead", 0)))


def day_start_ms(offset_minutes, day):
    """某个时区里某一天 0 点对应的 epoch ms。"""
    base = dt.datetime(day.year, day.month, day.day) - dt.timedelta(minutes=offset_minutes)
    return int((base - dt.datetime(1970, 1, 1)).total_seconds() * 1000)


def day_idx_to_date(day_idx):
    """分桶日序号（(started_at + 偏移) // 86400000）转 YYYY-MM-DD；按天/按小时分桶全部用整数算术，不把修饰符字符串拼进 SQL。"""
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
        conds.append(f"{col}provider_id IN ({','.join('?' * len(provider_ids))})")
        args += list(provider_ids)
    if model_id:
        conds.append(f"{col}model_id = ?")
        args.append(model_id)
    return conds, args


def where_sql(conds, extra=()):
    all_conds = list(conds) + list(extra)
    return ("WHERE " + " AND ".join(all_conds)) if all_conds else ""


def session_tree(facts, quota):
    """会话层级：与 ledgerSessionTree.ts 同一套口径（fork 断边、自身快照沿父链向上累加、按顶层会话配额保父链截断）。"""
    # fork 断边：fork 是从某会话复制出的独立分支，其用量不算回来源会话
    facts = [dict(f, parentSessionId=None) if f["taskType"] == "fork" else f for f in facts]
    ids = {f["sessionId"] for f in facts}
    self_use = {f["sessionId"]: f for f in facts}
    acc = {f["sessionId"]: dict(f, childCount=0) for f in facts}
    for f in facts:  # childCount 按断边后的直接父计；自引用不计入
        p = f["parentSessionId"]
        if p in ids and p != f["sessionId"]:
            acc[p]["childCount"] += 1
    for f in facts:  # 自身快照沿父链累加到每一级祖先；父不在集合内或自引用即停，64 步上限防脏数据死循环
        sid, p, hops = f["sessionId"], f["parentSessionId"], 0
        while p and p != sid and p in self_use and hops < 64:
            s, a = self_use[sid], acc[p]
            a["calls"] += s["calls"]
            a["inputTokens"] += s["inputTokens"]
            a["outputTokens"] += s["outputTokens"]
            if s["cost"] is not None:
                a["cost"] = (a["cost"] or 0.0) + s["cost"]
            if s["lastActiveMs"] is not None:
                a["lastActiveMs"] = s["lastActiveMs"] if a["lastActiveMs"] is None else max(a["lastActiveMs"], s["lastActiveMs"])
            p, hops = self_use[p]["parentSessionId"], hops + 1

    def depth(f):  # 沿父链算深度（带环保护），只用于排序稳定性
        d, p, seen = 0, f["parentSessionId"], {f["sessionId"]}
        while p and p in ids and p not in seen and d < 64:
            seen.add(p)
            d, p = d + 1, self_use[p]["parentSessionId"]
        return d

    # 父的子树 tokens ≥ 任何后代 + depth 升序 tie-break ⇒ 父必先于子被处理，单遍扫描即可保住整棵子树
    kept, roots, out = set(), 0, []
    rolled = [acc[f["sessionId"]] for f in facts]
    for f in sorted(rolled, key=lambda x: (-(x["inputTokens"] + x["outputTokens"]), depth(x), x["sessionId"])):
        p = f["parentSessionId"]
        if p in ids:
            if p not in kept:  # 父在集合里却没被保留：子行不能孤立出现
                continue
        elif roots < quota:
            roots += 1
        else:
            continue
        kept.add(f["sessionId"])
        out.append(f)
    return out


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
    today0 = day_start_ms(tz_offset_minutes, shifted.date())
    month0 = day_start_ms(tz_offset_minutes, shifted.date().replace(day=1))

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
            "SELECT COUNT(*), SUM(status = 'completed'), SUM(status = 'error'), SUM(status = 'cancelled'), "
            "SUM(input_tokens), SUM(output_tokens), SUM(reasoning_tokens), SUM(cache_read_input_tokens), "
            "CAST(ROUND(AVG(duration_ms)) AS INTEGER), CAST(ROUND(AVG(time_to_first_token_ms)) AS INTEGER) "
            f"FROM model_usage {where_sql(conds)}",
            args,
        ).fetchone()
        overview = {
            "calls": row[0] or 0, "completed": row[1] or 0, "errors": row[2] or 0,
            "cancelled": row[3] or 0, "inputTokens": row[4] or 0, "outputTokens": row[5] or 0,
            "reasoningTokens": row[6] or 0, "cacheReadTokens": row[7] or 0,
            "avgDurationMs": row[8], "avgTtftMs": row[9],
        }

        # 今天/本月是固定口径的 KPI，不随所选范围变化
        def window_totals(start_ms):
            wc, wa = build_filters(True, start_ms, now_ms, provider_ids, model_id)
            # 缓存读是输入的子集，只计输入+输出；费用必须按模型分组算（每个模型单价不同），不能对总量直接乘一个价
            r = cur.execute("SELECT COUNT(*), SUM(input_tokens + output_tokens) "
                            f"FROM model_usage {where_sql(wc)}", wa).fetchone()
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

        # 今日各小时密度条：横轴固定 0–23 时，未来小时留空；分桶用整数算术（当日内模一天的小时数），不经字符串修饰符
        hc, ha = build_filters(True, today0, now_ms, provider_ids, model_id)
        counts = dict(cur.execute(
            "SELECT CAST((COALESCE(started_at, 0) + ?) % 86400000 / 3600000 AS INTEGER) AS bucket, "
            f"COUNT(*) FROM model_usage {where_sql(hc)} GROUP BY bucket",
            [offset_ms] + list(ha),
        ).fetchall())
        hourly_today = [{"hour": hour, "calls": counts.get(hour, 0)} for hour in range(24)]

        # 每日趋势按 (日期, 模型) 分组取出，再折叠成每天一行：费用依赖模型单价，
        # 必须先按模型算清再按天汇总（按模型拆费用的视图由模型表和饼图承担）
        daily_map = {}
        for d, mid, calls, errors, it, ot, cr, rt, dur in cur.execute(
            f"SELECT CAST((COALESCE(started_at, 0) + ?) / 86400000 AS INTEGER) AS d, model_id, COUNT(*), "
            "SUM(status = 'error'), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens), "
            "SUM(reasoning_tokens), CAST(ROUND(AVG(duration_ms)) AS INTEGER) "
            f"FROM model_usage {where_sql(conds)} GROUP BY d, model_id ORDER BY d ASC",
            [offset_ms] + list(args),
        ).fetchall():
            date = day_idx_to_date(d)
            row = daily_map.setdefault(date, {
                "date": date, "calls": 0, "errors": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheReadTokens": 0, "reasoningTokens": 0, "cost": None, "durSum": 0, "durWeight": 0,
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
        daily = [{
            "date": d["date"], "calls": d["calls"], "errors": d["errors"], "inputTokens": d["inputTokens"],
            "outputTokens": d["outputTokens"], "cacheReadTokens": d["cacheReadTokens"],
            "reasoningTokens": d["reasoningTokens"], "cost": d["cost"],
            "avgDurationMs": round(d["durSum"] / d["durWeight"]) if d["durWeight"] else None,
        } for d in sorted(daily_map.values(), key=lambda x: x["date"])]

        models, total_cost, unpriced_calls, unpriced_models = [], 0.0, 0, set()
        for mid, pid, calls, it, ot, cr, dur in cur.execute(
            f"SELECT model_id, provider_id, COUNT(*), SUM(input_tokens), SUM(output_tokens), "
            "SUM(cache_read_input_tokens), CAST(ROUND(AVG(duration_ms)) AS INTEGER) "
            f"FROM model_usage {where_sql(conds)} GROUP BY model_id, provider_id ORDER BY COUNT(*) DESC",
            args,
        ).fetchall():
            cost = calc_cost(prices, mid, it or 0, ot or 0, cr or 0)
            if cost is not None:
                total_cost += cost
            else:
                # 没定价的模型不计费，但要记账：否则总数会被静默少算而无人知道
                unpriced_calls += calls
                unpriced_models.add(mid)
            models.append({
                "model": mid, "provider": provider_label(pid, provider_names), "calls": calls,
                "inputTokens": it or 0, "outputTokens": ot or 0, "cacheReadTokens": cr or 0,
                "avgDurationMs": dur, "cost": cost,
            })
        if prices:
            overview["cost"] = total_cost
            overview["unpricedCalls"] = unpriced_calls
            overview["unpricedModelIds"] = sorted(unpriced_models)

        # Agent 分布同样按 (agent, 模型) 分组再折叠，费用才能按 agent 汇总
        agents_map = {}
        for agent, mid, calls, it, ot, cr in cur.execute(
            f"SELECT COALESCE(agent, 'unknown'), model_id, COUNT(*), SUM(input_tokens), "
            "SUM(output_tokens), SUM(cache_read_input_tokens) "
            f"FROM model_usage {where_sql(conds)} GROUP BY agent, model_id ORDER BY COUNT(*) DESC",
            args,
        ).fetchall():
            row = agents_map.setdefault(agent, {
                "agent": agent, "calls": 0, "inputTokens": 0, "outputTokens": 0,
                "cacheReadTokens": 0, "cost": None,
            })
            row["calls"] += calls
            row["inputTokens"] += it or 0
            row["outputTokens"] += ot or 0
            row["cacheReadTokens"] += cr or 0
            c = calc_cost(prices, mid, it or 0, ot or 0, cr or 0)
            if c is not None:
                row["cost"] = (row["cost"] or 0.0) + c
        agents = sorted(agents_map.values(), key=lambda x: -x["calls"])

        # 会话表按 (会话, 模型) 分组再折叠：一个会话里通常混用多个模型，费用要按模型分开算；
        # 折叠出的只是每个会话的「自身」用量，子树合计与截断交给 session_tree
        sessions_map = {}
        for sid, title, directory, parent, task_type, mid, calls, it, ot, cr, last in cur.execute(
            f"SELECT m.session_id, s.title, s.directory, s.parent_id, s.task_type, m.model_id, COUNT(*), "
            "SUM(m.input_tokens), SUM(m.output_tokens), SUM(m.cache_read_input_tokens), MAX(m.started_at) "
            f"FROM model_usage m JOIN session s ON s.id = m.session_id {where_sql(conds_m)} "
            "GROUP BY m.session_id, m.model_id",
            args_m,
        ).fetchall():
            row = sessions_map.setdefault(sid, {
                "sessionId": sid, "title": title, "directory": directory, "taskType": task_type,
                "parentSessionId": parent, "calls": 0, "inputTokens": 0, "outputTokens": 0,
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
        sessions = session_tree(list(sessions_map.values()), 200)

        recent = [{
            "timeMs": r[0], "model": r[1], "provider": provider_label(r[2], provider_names),
            "agent": r[3], "status": r[4], "errorType": r[5], "inputTokens": r[6] or 0,
            "outputTokens": r[7] or 0, "cacheReadTokens": r[8] or 0, "durationMs": r[9], "ttftMs": r[10],
            "cost": calc_cost(prices, r[1], r[6] or 0, r[7] or 0, r[8] or 0),
        } for r in cur.execute(
            f"SELECT started_at, model_id, provider_id, agent, status, error_type, input_tokens, "
            "output_tokens, cache_read_input_tokens, duration_ms, time_to_first_token_ms "
            f"FROM model_usage {where_sql(conds)} ORDER BY started_at DESC LIMIT 500",
            args,
        ).fetchall()]

        errors = [{"type": t, "count": c} for t, c in cur.execute(
            f"""SELECT COALESCE(error_type, 'unknown') AS t, COUNT(*)
            FROM model_usage {where_sql(conds, ("status = 'error'",))} GROUP BY t ORDER BY COUNT(*) DESC""",
            args,
        ).fetchall()]

        facets = {
            "providers": [{"id": pid, "label": provider_label(pid, provider_names), "calls": cnt}
                          for pid, cnt in facet_providers],
            "models": [{"id": r[0], "calls": r[1]} for r in cur.execute(
                f"SELECT model_id, COUNT(*) FROM model_usage {where_sql(conds_date)} "
                "GROUP BY model_id ORDER BY COUNT(*) DESC",
                args_date,
            ).fetchall()],
        }
    finally:
        con.close()

    return {
        "overview": overview, "hourlyToday": hourly_today, "daily": daily, "models": models,
        "agents": agents, "sessions": sessions, "recent": recent, "errors": errors,
        "facets": facets, "pricesLoaded": bool(prices), "priceMeta": price_meta if prices else None,
    }


def main():
    parser = argparse.ArgumentParser(description="ZCode 用量账本 WSL dump（内部）")
    for name in ("--db", "--provider-config", "--prices"):
        parser.add_argument(name, required=True)
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
