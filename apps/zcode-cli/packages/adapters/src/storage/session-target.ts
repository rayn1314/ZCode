// ============================================================
// SQLite session target helpers
// ============================================================

import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { SessionId, SessionGoal, SessionGoalListEntry, GoalStatus } from "@zcode/contracts";

interface TargetRow {
  session_id: string;
  target_id: string;
  objective: string;
  summary_title: string | null;
  status: string;
  token_budget: number | null;
  tokens_used: number;
  time_used_seconds: number;
  active_input_id: string | null;
  active_run_started_at: number | null;
  active_run_last_seen_at: number | null;
  end_at_ms: number | null;
  deadline_grace_used: number;
  time_created: number;
  time_updated: number;
}

interface GoalListRow extends TargetRow {
  session_title: string;
  session_directory: string;
  session_path: string | null;
  session_workspace_id: string | null;
  session_time_archived: number | null;
}

export function readSessionTarget(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const row = db
    .prepare("select * from session_target where session_id = ?")
    .get(input.sessionID) as TargetRow | undefined;
  return row ? decodeTargetRow(row) : null;
}

export function setSessionTarget(
  db: DatabaseSync,
  input: {
    objective: string;
    sessionID: SessionId;
    status: GoalStatus;
    tokenBudget?: number | null;
    endAtMs?: number | null;
  },
): SessionGoal {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, end_at_ms, deadline_grace_used, time_created, time_updated
    ) values (?, ?, ?, null, ?, ?, 0, 0, ?, 0, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      end_at_ms = excluded.end_at_ms,
      deadline_grace_used = 0,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.status,
    input.tokenBudget ?? null,
    input.endAtMs ?? null,
    now,
    now,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function cloneSessionTargetForFork(
  db: DatabaseSync,
  input: {
    source: SessionGoal;
    sessionID: SessionId;
    status: GoalStatus;
  },
): SessionGoal {
  const now = Date.now();
  const source = input.source;
  // fork 是 session state branch，不是新建 goal。必须保留 target_id 和
  // 原始 created time，让已复制的 goal-continuation / verifier metadata 能继续对齐。
  // active run 字段属于父 session 当前运行态，child 不能继承，否则会显示幽灵运行中。
  // 截止时间随目标一起复制，但收尾轮标志重置：新会话应当重新拥有一次收尾机会。
  db.prepare(
    `
    insert into session_target (
      session_id,
      target_id,
      objective,
      summary_title,
      status,
      token_budget,
      tokens_used,
      time_used_seconds,
      active_input_id,
      active_run_started_at,
      active_run_last_seen_at,
      end_at_ms,
      deadline_grace_used,
      time_created,
      time_updated
    ) values (?, ?, ?, ?, ?, ?, ?, ?, null, null, null, ?, 0, ?, ?)
    on conflict(session_id) do update set
      target_id = excluded.target_id,
      objective = excluded.objective,
      summary_title = excluded.summary_title,
      status = excluded.status,
      token_budget = excluded.token_budget,
      tokens_used = excluded.tokens_used,
      time_used_seconds = excluded.time_used_seconds,
      active_input_id = null,
      active_run_started_at = null,
      active_run_last_seen_at = null,
      end_at_ms = excluded.end_at_ms,
      deadline_grace_used = 0,
      time_created = excluded.time_created,
      time_updated = excluded.time_updated
    `,
  ).run(
    input.sessionID,
    source.targetID,
    source.objective,
    source.summaryTitle,
    input.status,
    source.tokenBudget,
    source.tokensUsed,
    source.timeUsedSeconds,
    source.endAtMs,
    source.time.created,
    source.time.updated,
  );
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function createSessionTarget(
  db: DatabaseSync,
  input: {
    objective: string;
    sessionID: SessionId;
    tokenBudget?: number | null;
    endAtMs?: number | null;
  },
): SessionGoal | null {
  const now = Date.now();
  const targetID = createStorageTargetId();
  db.prepare(
    `
    insert or ignore into session_target (
      session_id, target_id, objective, summary_title, status, token_budget, tokens_used, time_used_seconds, end_at_ms, deadline_grace_used, time_created, time_updated
    ) values (?, ?, ?, null, 'active', ?, 0, 0, ?, 0, ?, ?)
    `,
  ).run(
    input.sessionID,
    targetID,
    input.objective,
    input.tokenBudget ?? null,
    input.endAtMs ?? null,
    now,
    now,
  );

  const target = readSessionTarget(db, { sessionID: input.sessionID });
  if (target?.targetID !== targetID) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return target;
}

export function updateSessionTargetStatus(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    status: GoalStatus;
    /** 显式重设截止时间；undefined 表示保持原值，null 表示清除截止。 */
    endAtMs?: number | null;
  },
): SessionGoal | null {
  const now = Date.now();
  const overrideEndAt = input.endAtMs !== undefined;
  // 激活（resume）视为开启新的目标生命周期：必须重置收尾轮标志，否则恢复后的目标
  // 会在第一个检查点就被判成「已收尾」而立即停止。
  const resetGrace = input.status === "active";
  const result = db
    .prepare(
      `
      update session_target
      set
        status = ?,
        end_at_ms = case when ? = 1 then ? else end_at_ms end,
        deadline_grace_used = case when ? = 1 then 0 else deadline_grace_used end,
        time_updated = max(time_updated, ?)
      where session_id = ?
      `,
    )
    .run(
      input.status,
      overrideEndAt ? 1 : 0,
      input.endAtMs ?? null,
      resetGrace ? 1 : 0,
      now,
      input.sessionID,
    );
  if (result.changes === 0) return null;
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

/**
 * 到点第一段：把「已给过收尾轮」落库后再放行这一轮。
 * 必须持久化在行上——进程重启后仍要记得收尾轮已经用过，否则会重复给。
 */
export function markSessionTargetDeadlineGraceUsed(
  db: DatabaseSync,
  input: { sessionID: SessionId; targetID: string },
): SessionGoal | null {
  const now = Date.now();
  const result = db
    .prepare(
      `
      update session_target
      set deadline_grace_used = 1, time_updated = max(time_updated, ?)
      where session_id = ? and target_id = ? and status = 'active'
      `,
    )
    .run(now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function startSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    startedAtMs: number;
  },
): SessionGoal | null {
  const startedAt = Math.max(0, input.startedAtMs);
  // goal live 计时必须跟随 agent 运行边界落库，不能再由 UI 从 assistant
  // message timestamp 反推；恢复 snapshot 时该 timestamp 可能是旧轮次，导致切回后异常增长。
  const result = db
    .prepare(
      `
      update session_target
      set
        active_input_id = ?,
        active_run_started_at = ?,
        active_run_last_seen_at = ?,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and status = 'active'
      `,
    )
    .run(input.inputID, startedAt, startedAt, startedAt, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, startedAt);
  return mustReadTarget(db, input.sessionID);
}

export function heartbeatSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    seenAtMs: number;
  },
): SessionGoal | null {
  const seenAt = Math.max(0, input.seenAtMs);
  const result = db
    .prepare(
      `
      update session_target
      set
        active_run_last_seen_at = max(coalesce(active_run_last_seen_at, 0), ?),
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at is not null
      `,
    )
    .run(seenAt, seenAt, input.sessionID, input.targetID, input.inputID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, seenAt);
  return mustReadTarget(db, input.sessionID);
}

export function finishSessionTargetRun(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    inputID: string;
    endedAtMs: number;
    status?: GoalStatus;
    tokensUsedDelta?: number;
  },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (
    !current ||
    current.targetID !== input.targetID ||
    current.activeInputId !== input.inputID ||
    current.activeRunStartedAtMs == null
  ) {
    return current;
  }

  const endedAt = Math.max(0, input.endedAtMs);
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when ? is not null then ?
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          when status = 'active' and end_at_ms is not null and deadline_grace_used = 1 and ? >= end_at_ms then 'deadline_reached'
          else status
        end,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      tokenDelta,
      timeDelta,
      input.status ?? null,
      input.status ?? null,
      tokenDelta,
      endedAt,
      endedAt,
      input.sessionID,
      input.targetID,
      input.inputID,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

export function recoverInterruptedSessionTargetRun(
  db: DatabaseSync,
  input: { sessionID: SessionId },
): SessionGoal | null {
  const current = readSessionTarget(db, { sessionID: input.sessionID });
  if (!current || !current.activeInputId || current.activeRunStartedAtMs == null) {
    return current;
  }

  // 进程崩溃/退出后，active_run_started_at 只能说明上次没有正常收口。
  // 恢复时不能用 Date.now() 结算，否则 app 离线时间会被计入 goal 运行时长。
  const endedAt = current.activeRunLastSeenAtMs ?? current.activeRunStartedAtMs;
  const timeDelta = elapsedSecondsBetween(current.activeRunStartedAtMs, endedAt);
  const nextStatus: GoalStatus = current.status === "active" ? "paused" : current.status;
  const result = db
    .prepare(
      `
      update session_target
      set
        time_used_seconds = time_used_seconds + ?,
        status = ?,
        active_input_id = null,
        active_run_started_at = null,
        active_run_last_seen_at = null,
        time_updated = max(time_updated, ?)
      where session_id = ?
        and target_id = ?
        and active_input_id = ?
        and active_run_started_at = ?
      `,
    )
    .run(
      timeDelta,
      nextStatus,
      endedAt,
      input.sessionID,
      current.targetID,
      current.activeInputId,
      current.activeRunStartedAtMs,
    );
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, endedAt);
  return mustReadTarget(db, input.sessionID);
}

export function accountSessionTargetUsage(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    tokensUsedDelta?: number;
    timeUsedSecondsDelta?: number;
  },
): SessionGoal | null {
  const now = Date.now();
  const tokenDelta = Math.max(0, input.tokensUsedDelta ?? 0);
  const timeDelta = Math.max(0, input.timeUsedSecondsDelta ?? 0);
  if (tokenDelta === 0 && timeDelta === 0) {
    return readSessionTarget(db, { sessionID: input.sessionID });
  }

  const result = db
    .prepare(
      `
      update session_target
      set
        tokens_used = tokens_used + ?,
        time_used_seconds = time_used_seconds + ?,
        status = case
          when status = 'active' and token_budget is not null and tokens_used + ? >= token_budget then 'budget_limited'
          when status = 'active' and end_at_ms is not null and deadline_grace_used = 1 and ? >= end_at_ms then 'deadline_reached'
          else status
        end,
        time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(tokenDelta, timeDelta, tokenDelta, now, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function updateSessionTargetSummaryTitle(
  db: DatabaseSync,
  input: {
    sessionID: SessionId;
    targetID: string;
    summaryTitle: string;
  },
): SessionGoal | null {
  const now = Date.now();
  // goal 概要由异步 title sidecar 生成；用户可能在模型返回前 replace/clear goal。
  // 必须带 target_id 条件写回，避免旧 objective 的概要覆盖新目标。
  const result = db
    .prepare(
      `
      update session_target
      set summary_title = ?, time_updated = ?
      where session_id = ? and target_id = ?
      `,
    )
    .run(input.summaryTitle, now, input.sessionID, input.targetID);
  if (result.changes === 0) return readSessionTarget(db, { sessionID: input.sessionID });
  touchSessionForTarget(db, input.sessionID, now);
  return mustReadTarget(db, input.sessionID);
}

export function clearSessionTarget(db: DatabaseSync, input: { sessionID: SessionId }): boolean {
  const now = Date.now();
  const result = db.prepare("delete from session_target where session_id = ?").run(input.sessionID);
  if (result.changes === 0) return false;
  touchSessionForTarget(db, input.sessionID, now);
  return true;
}

/**
 * 面板数据源：按工作区列出全部目标及其承载会话。
 * 只读查询，不参与任何写入路径；archived 过滤放在 SQL 里，避免把已归档会话的目标带进列表。
 */
export function listSessionTargets(
  db: DatabaseSync,
  input: {
    directory?: string;
    includeArchived?: boolean;
    limit?: number;
  } = {},
): SessionGoalListEntry[] {
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (input.directory) {
    clauses.push("s.directory = ?");
    values.push(input.directory);
  }
  if (!input.includeArchived) {
    clauses.push("s.time_archived is null");
  }
  const where = clauses.length > 0 ? `where ${clauses.join(" and ")}` : "";
  const limitValue = input.limit && input.limit > 0 ? input.limit : undefined;
  if (limitValue !== undefined) values.push(limitValue);
  const limit = limitValue === undefined ? "" : " limit ?";

  const rows = db
    .prepare(
      `
      select
        st.session_id,
        st.target_id,
        st.objective,
        st.summary_title,
        st.status,
        st.token_budget,
        st.tokens_used,
        st.time_used_seconds,
        st.active_input_id,
        st.active_run_started_at,
        st.active_run_last_seen_at,
        st.end_at_ms,
        st.deadline_grace_used,
        st.time_created,
        st.time_updated,
        s.title as session_title,
        s.directory as session_directory,
        s.path as session_path,
        s.workspace_id as session_workspace_id,
        s.time_archived as session_time_archived
      from session_target st
      join session s on s.id = st.session_id
      ${where}
      order by st.time_updated desc, st.session_id desc
      ${limit}
      `,
    )
    .all(...values) as unknown as GoalListRow[];

  return rows.map((row) => {
    const workspacePath = row.session_path ?? row.session_directory;
    return {
      goal: decodeTargetRow(row),
      sessionID: row.session_id as SessionId,
      sessionTitle: row.session_title,
      workspacePath,
      ...(row.session_workspace_id ? { workspaceIdentity: row.session_workspace_id } : {}),
      archived: row.session_time_archived != null,
    };
  });
}

function mustReadTarget(db: DatabaseSync, sessionID: SessionId): SessionGoal {
  const target = readSessionTarget(db, { sessionID });
  if (!target) {
    throw new Error(`Session target not found after write: ${sessionID}`);
  }
  return target;
}

function touchSessionForTarget(db: DatabaseSync, sessionID: SessionId, timeUpdated: number): void {
  db.prepare("update session set time_updated = max(time_updated, ?) where id = ?").run(
    timeUpdated,
    sessionID,
  );
}

function decodeTargetRow(row: TargetRow): SessionGoal {
  return {
    sessionID: row.session_id as SessionId,
    targetID: row.target_id,
    objective: row.objective,
    summaryTitle: row.summary_title,
    status: row.status as GoalStatus,
    tokenBudget: row.token_budget,
    tokensUsed: row.tokens_used,
    timeUsedSeconds: row.time_used_seconds,
    endAtMs: row.end_at_ms,
    deadlineGraceUsed: row.deadline_grace_used === 1,
    activeInputId: row.active_input_id,
    activeRunStartedAtMs: row.active_run_started_at,
    activeRunLastSeenAtMs: row.active_run_last_seen_at,
    time: {
      created: row.time_created,
      updated: row.time_updated,
    },
  };
}

function createStorageTargetId(): string {
  return `target_${Date.now().toString(36)}_${randomUUID()}`;
}

function elapsedSecondsBetween(startedAtMs: number, endedAtMs: number): number {
  return Math.max(0, Math.ceil((endedAtMs - startedAtMs) / 1000));
}
