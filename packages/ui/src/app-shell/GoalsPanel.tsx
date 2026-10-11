import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Target } from "lucide-react";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { cn } from "@/components/lib/utils.js";
import {
  PluginInstallEmptyState,
  PluginLoadingState,
  PluginSearchEmptyState,
} from "@/settings/PluginInstallEmptyState.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useServices } from "@/hooks/useServices.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useGoalManagementStore } from "@/store/goalManagementStore.js";
import { GoalRow } from "./GoalRow.js";
import { GoalResumeDialog } from "./GoalResumeDialog.js";
import { GoalEditView, type GoalEditSubmit } from "./GoalEditView.js";
import {
  GOAL_FILTERS,
  GOAL_LIST_GRID_CLASS,
  GOAL_LIST_SCROLL_THRESHOLD,
  goalResumeNeedsNewDeadline,
  goalTitle,
  matchesGoalFilter,
  resolveGoalDisplayStatus,
  type GoalFilter,
} from "./goalDisplay.js";

/**
 * 任务面板：会话目标（session_target）的管理视图。
 * 每行 = 一行 session_target，权威状态只在服务端；面板只做投影 + 下发命令。
 */

export interface GoalsPanelProps {
  workspacePath: string;
  workspaceIdentity?: string;
  /** 有值即整面板只读（本地目录不可用 / 远端未连接），列表保留缓存内容。 */
  readOnlyReason?: string;
  onOpenSession: (params: {
    sessionId: string;
    workspacePath: string;
    workspaceIdentity?: string;
  }) => void;
}

type GoalsView =
  | { mode: "list" }
  | { mode: "create" }
  | { mode: "edit"; entry: ZCodeSessionGoalListEntry };

export function GoalsPanel({
  workspacePath,
  workspaceIdentity,
  readOnlyReason,
  onOpenSession,
}: GoalsPanelProps) {
  const { intl } = useZCodeIntl();
  const { zcodeAgentService } = useServices();
  const confirmDialog = useConfirmDialog();

  const goals = useGoalManagementStore((state) => state.goals);
  const loading = useGoalManagementStore((state) => state.loading);
  const error = useGoalManagementStore((state) => state.error);
  const operationId = useGoalManagementStore((state) => state.operationId);
  const initialize = useGoalManagementStore((state) => state.initialize);
  const refresh = useGoalManagementStore((state) => state.refresh);
  const createGoal = useGoalManagementStore((state) => state.createGoal);
  const updateGoal = useGoalManagementStore((state) => state.updateGoal);
  const pauseGoal = useGoalManagementStore((state) => state.pauseGoal);
  const resumeGoal = useGoalManagementStore((state) => state.resumeGoal);
  const clearGoal = useGoalManagementStore((state) => state.clearGoal);

  const [view, setView] = useState<GoalsView>({ mode: "list" });
  const [filter, setFilter] = useState<GoalFilter>("all");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [resumeTarget, setResumeTarget] = useState<ZCodeSessionGoalListEntry | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const readOnly = Boolean(readOnlyReason);
  const busy = operationId !== null;
  // 首屏加载就失败：只留错误条 + 重试，不再叠加「还没有任务」的空状态，避免说反话。
  const initialLoadFailed = Boolean(error) && goals.length === 0;

  useEffect(() => {
    void initialize({ workspacePath, workspaceIdentity, agentService: zcodeAgentService });
  }, [workspacePath, workspaceIdentity, initialize, zcodeAgentService]);

  // 倒计时基准每 30 秒推进一次；不做每帧重渲染。
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const visibleGoals = useMemo(() => {
    const scoped = includeArchived ? goals : goals.filter((entry) => !entry.archived);
    return scoped
      .filter((entry) => matchesGoalFilter(resolveGoalDisplayStatus(entry.goal, now), filter))
      .sort((left, right) => right.goal.createdAt - left.goal.createdAt);
  }, [filter, goals, includeArchived, now]);

  const handleOpenSession = useCallback(
    (entry: ZCodeSessionGoalListEntry) => {
      onOpenSession({
        sessionId: entry.sessionId,
        workspacePath: entry.workspacePath,
        ...(entry.workspaceIdentity ? { workspaceIdentity: entry.workspaceIdentity } : {}),
      });
    },
    [onOpenSession],
  );

  const handleCreateSubmit = useCallback(
    async (params: GoalEditSubmit) => {
      const sessionId = await createGoal(
        {
          objective: params.objective,
          endAtMs: params.endAtMs,
          tokenBudget: params.tokenBudget,
          ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        },
        zcodeAgentService,
      );
      if (!sessionId) return false;
      setView({ mode: "list" });
      onOpenSession({
        sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      return true;
    },
    [createGoal, onOpenSession, workspaceIdentity, workspacePath, zcodeAgentService],
  );

  const handleEditSubmit = useCallback(
    async (params: GoalEditSubmit) => {
      const sessionId = params.sessionId;
      if (!sessionId) return false;
      const ok = await updateGoal(
        {
          sessionId,
          objective: params.objective,
          endAtMs: params.endAtMs,
          tokenBudget: params.tokenBudget,
        },
        zcodeAgentService,
      );
      if (!ok) return false;
      setView({ mode: "list" });
      onOpenSession({
        sessionId,
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
      });
      return true;
    },
    [onOpenSession, updateGoal, workspaceIdentity, workspacePath, zcodeAgentService],
  );

  const handleClear = useCallback(
    async (entry: ZCodeSessionGoalListEntry) => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "goals.clearConfirm.title" }),
        description: intl.formatMessage(
          { id: "goals.clearConfirm.description" },
          { title: goalTitle(entry.goal) },
        ),
        confirmLabel: intl.formatMessage({ id: "goals.clearConfirm.confirm" }),
        confirmVariant: "destructive",
      });
      if (!confirmed) return;
      await clearGoal(entry.sessionId, zcodeAgentService);
    },
    [clearGoal, confirmDialog, intl, zcodeAgentService],
  );

  const handleResumeConfirm = useCallback(
    async (endAtMs: number | null) => {
      const entry = resumeTarget;
      if (!entry) return;
      setResumeTarget(null);
      await resumeGoal(entry.sessionId, endAtMs, zcodeAgentService);
    },
    [resumeGoal, resumeTarget, zcodeAgentService],
  );

  const handleResumeClick = useCallback(
    (entry: ZCodeSessionGoalListEntry) => {
      if (goalResumeNeedsNewDeadline(entry.goal, now)) {
        setResumeTarget(entry);
        return;
      }
      void resumeGoal(entry.sessionId, entry.goal.endAtMs, zcodeAgentService);
    },
    [now, resumeGoal, zcodeAgentService],
  );

  if (view.mode === "create" || view.mode === "edit") {
    return (
      <GoalEditView
        editing={view.mode === "edit" ? view.entry : null}
        workspacePath={workspacePath}
        workspaceIdentity={workspaceIdentity}
        saving={Boolean(
          operationId?.startsWith("goal:create") || operationId?.startsWith("goal:update"),
        )}
        readOnly={readOnly}
        onSubmit={view.mode === "edit" ? handleEditSubmit : handleCreateSubmit}
        onBack={() => setView({ mode: "list" })}
      />
    );
  }

  const listClass = cn(
    GOAL_LIST_GRID_CLASS,
    visibleGoals.length > GOAL_LIST_SCROLL_THRESHOLD &&
      "max-h-[42rem] overflow-y-auto overscroll-contain",
  );

  const openCreateView = () => setView({ mode: "create" });

  return (
    <div className="flex flex-col gap-6" data-testid="goals-panel">
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight text-foreground">
            <Target className="size-5 shrink-0 text-foreground-subtle" aria-hidden="true" />
            {intl.formatMessage({ id: "goals.title" })}
          </h1>
          <p className="text-ui-base leading-5 text-foreground-subtlest">
            {intl.formatMessage({ id: "goals.description" })}
          </p>
        </div>
        <Button type="button" data-icon="inline-start" disabled={readOnly} onClick={openCreateView}>
          <Plus className="size-4" aria-hidden="true" />
          {intl.formatMessage({ id: "goals.new" })}
        </Button>
      </div>

      {readOnlyReason ? (
        <div className="rounded-lg border border-card-border bg-card px-3 py-2 text-ui-base text-foreground-subtle">
          {readOnlyReason}
        </div>
      ) : null}

      {error ? (
        // 失败不清空列表：保留上次缓存，只补一条错误条 + 重试入口。
        <div
          data-testid="goals-error-bar"
          className="flex items-center justify-between gap-3 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-ui-base text-destructive"
        >
          <span className="min-w-0 truncate" title={error}>
            {intl.formatMessage({ id: goals.length > 0 ? "goals.error.save" : "goals.error.load" })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void refresh(zcodeAgentService)}
          >
            {intl.formatMessage({ id: "goals.retry" })}
          </Button>
        </div>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5" data-testid="goals-status-filter">
          {GOAL_FILTERS.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={filter === key}
              className={cn(
                "rounded-full px-2.5 py-0.5 text-ui-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-input-border-focused",
                filter === key
                  ? "bg-selected text-foreground"
                  : "text-foreground-subtle hover:bg-hover hover:text-foreground",
              )}
              onClick={() => setFilter(key)}
            >
              {intl.formatMessage({ id: `goals.filter.${key}` })}
            </button>
          ))}
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-ui-sm text-foreground-subtle">
          <Switch
            size="sm"
            checked={includeArchived}
            onCheckedChange={(checked) => setIncludeArchived(checked)}
          />
          {intl.formatMessage({ id: "goals.filter.showArchived" })}
        </label>
      </div>

      {loading && goals.length === 0 ? (
        <div className={GOAL_LIST_GRID_CLASS}>
          {[0, 1, 2].map((index) => (
            <PluginLoadingState
              key={index}
              label={index === 0 ? intl.formatMessage({ id: "common.loading" }) : ""}
            />
          ))}
        </div>
      ) : initialLoadFailed ? null : visibleGoals.length === 0 ? (
        goals.length === 0 ? (
          <PluginInstallEmptyState
            title={intl.formatMessage({ id: "goals.empty.title" })}
            description={intl.formatMessage({ id: "goals.empty.description" })}
            actions={
              <Button
                type="button"
                data-icon="inline-start"
                disabled={readOnly}
                onClick={openCreateView}
              >
                <Plus className="size-4" aria-hidden="true" />
                {intl.formatMessage({ id: "goals.new" })}
              </Button>
            }
          />
        ) : (
          <PluginSearchEmptyState label={intl.formatMessage({ id: "goals.filter.empty" })} />
        )
      ) : (
        <div className={listClass} data-testid="goals-list">
          {visibleGoals.map((entry) => (
            <GoalRow
              key={`${entry.workspacePath}:${entry.sessionId}`}
              entry={entry}
              now={now}
              readOnly={readOnly}
              busy={busy}
              onOpenSession={() => handleOpenSession(entry)}
              onEdit={() => setView({ mode: "edit", entry })}
              onPause={() => void pauseGoal(entry.sessionId, zcodeAgentService)}
              onResume={() => handleResumeClick(entry)}
              onClear={() => void handleClear(entry)}
            />
          ))}
        </div>
      )}

      <GoalResumeDialog
        entry={resumeTarget}
        busy={busy}
        onCancel={() => setResumeTarget(null)}
        onConfirm={(endAtMs) => void handleResumeConfirm(endAtMs)}
      />
    </div>
  );
}
