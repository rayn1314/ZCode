import { create } from "zustand";
import type { ZCodeSessionGoalListEntry } from "@zcode/shared";
import type { IZCodeAgentService } from "@zcode/services";
import { logger } from "@/logger.js";

// 任务(会话目标 goal)管理 store：走 zcode-agent RPC（列表 / 新建 / 编辑 / 暂停 / 恢复 / 清除）。
// 与 automationManagementStore 同一范式：按 workspace 缓存，切换时后台刷新避免闪烁。
//
// 面板每行就是一行 session_target，权威所有权在 session_target 表；store 只做投影与写命令下发，
// 不做任何乐观状态机（状态机由服务端返回快照 / 下一次列表刷新负责）。

export interface CreateGoalInput {
  objective: string;
  /** 墙钟截止时间（epoch ms）；null = 不设截止。 */
  endAtMs: number | null;
  /** token 预算；null = 不设预算。 */
  tokenBudget: number | null;
  /** 承载会话；缺省时先新建会话再设定目标。 */
  sessionId?: string;
}

export interface UpdateGoalInput {
  sessionId: string;
  objective: string;
  endAtMs: number | null;
  tokenBudget: number | null;
}

interface GoalManagementState {
  workspacePath: string | null;
  workspaceIdentity: string | null;
  goals: ZCodeSessionGoalListEntry[];
  loading: boolean;
  error: string | null;
  // 正在进行的写操作标记，用于禁用对应按钮（如 `goal:pause:<sessionId>`）。
  operationId: string | null;
  initialize: (params: {
    workspacePath: string;
    workspaceIdentity?: string;
    agentService: IZCodeAgentService;
  }) => Promise<void>;
  refresh: (agentService: IZCodeAgentService) => Promise<void>;
  /** 创建目标；返回承载会话 id（未传 sessionId 时会先新建会话），失败返回 null。 */
  createGoal: (input: CreateGoalInput, agentService: IZCodeAgentService) => Promise<string | null>;
  updateGoal: (input: UpdateGoalInput, agentService: IZCodeAgentService) => Promise<boolean>;
  pauseGoal: (sessionId: string, agentService: IZCodeAgentService) => Promise<boolean>;
  /**
   * 恢复目标。`endAtMs` 必须显式给出：传 null 表示恢复后不再设截止；
   * 恢复 `deadline_reached` 目标时服务端要求带新截止，否则会拒绝。
   */
  resumeGoal: (
    sessionId: string,
    endAtMs: number | null,
    agentService: IZCodeAgentService,
  ) => Promise<boolean>;
  clearGoal: (sessionId: string, agentService: IZCodeAgentService) => Promise<boolean>;
}

function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

let goalLoadSeq = 0;

function sameWorkspace(
  current: Pick<GoalManagementState, "workspacePath" | "workspaceIdentity">,
  workspacePath: string,
  workspaceIdentity: string | null,
): boolean {
  return current.workspacePath === workspacePath && current.workspaceIdentity === workspaceIdentity;
}

/**
 * 写命令的目标 workspace：优先用行自带的身份（远程会话可能不在当前 workspace），
 * 缺失时回退到列表所在 workspace。
 */
function resolveGoalActionScope(
  state: Pick<GoalManagementState, "goals" | "workspacePath" | "workspaceIdentity">,
  sessionId: string,
): { workspacePath: string; workspaceIdentity: string | null | undefined } | null {
  const entry = state.goals.find((candidate) => candidate.sessionId === sessionId);
  const workspacePath = entry?.workspacePath ?? state.workspacePath;
  if (!workspacePath) return null;
  return {
    workspacePath,
    workspaceIdentity: entry?.workspaceIdentity ?? state.workspaceIdentity,
  };
}

async function loadInto(
  set: (partial: Partial<GoalManagementState>) => void,
  get: () => GoalManagementState,
  params: {
    workspacePath: string;
    workspaceIdentity: string | null;
    agentService: IZCodeAgentService;
    requestId: number;
  },
): Promise<void> {
  const { workspacePath, workspaceIdentity, agentService, requestId } = params;
  try {
    const result = await agentService.listSessionGoals({
      workspacePath,
      ...(workspaceIdentity ? { workspaceIdentity } : {}),
      // 面板单次取全量（含归档会话的目标），归档开关在客户端过滤，切换时不重新发查询。
      includeArchived: true,
    });
    if (requestId !== goalLoadSeq || !sameWorkspace(get(), workspacePath, workspaceIdentity)) {
      return;
    }
    set({ goals: result.goals, loading: false });
  } catch (error) {
    if (requestId !== goalLoadSeq || !sameWorkspace(get(), workspacePath, workspaceIdentity)) {
      return;
    }
    logger.error("[goals] load failed", {
      workspacePath,
      error: toMessage(error),
    });
    // 失败时保留旧列表：面板仍展示上次缓存，只显示错误条 + 重试。
    set({ error: toMessage(error), loading: false });
  }
}

export const useGoalManagementStore = create<GoalManagementState>((set, get) => ({
  workspacePath: null,
  workspaceIdentity: null,
  goals: [],
  loading: false,
  error: null,
  operationId: null,

  async initialize({ workspacePath, workspaceIdentity, agentService }) {
    const normalizedIdentity = workspaceIdentity?.trim() || null;
    const requestId = ++goalLoadSeq;
    const current = get();
    const hasCache =
      current.goals.length > 0 &&
      current.workspacePath === workspacePath &&
      current.workspaceIdentity === normalizedIdentity;
    set({
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      // 有缓存时后台刷新、保留列表，避免切 workspace 闪烁；无缓存才显示阻塞 loading。
      loading: !hasCache,
      error: null,
      operationId: null,
      goals: hasCache ? current.goals : [],
    });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity: normalizedIdentity,
      agentService,
      requestId,
    });
  },

  async refresh(agentService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return;
    const requestId = ++goalLoadSeq;
    set({ error: null });
    await loadInto(set, get, {
      workspacePath,
      workspaceIdentity,
      agentService,
      requestId,
    });
  },

  async createGoal(input, agentService) {
    const { workspacePath, workspaceIdentity } = get();
    if (!workspacePath) return null;
    set({ operationId: `goal:create:${input.sessionId ?? "new"}`, error: null });
    try {
      let sessionId = input.sessionId?.trim();
      if (!sessionId) {
        const snapshot = await agentService.createSession({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
        });
        sessionId = snapshot.session.sessionId;
      }
      await agentService.goalSession({
        workspacePath,
        ...(workspaceIdentity ? { workspaceIdentity } : {}),
        sessionId,
        action: "set",
        objective: input.objective,
        endAtMs: input.endAtMs,
        tokenBudget: input.tokenBudget,
      });
      const requestId = ++goalLoadSeq;
      await loadInto(set, get, {
        workspacePath,
        workspaceIdentity,
        agentService,
        requestId,
      });
      return sessionId;
    } catch (error) {
      logger.error("[goals] create failed", { error: toMessage(error) });
      set({ error: toMessage(error) });
      return null;
    } finally {
      set({ operationId: null });
    }
  },

  async updateGoal(input, agentService) {
    const state = get();
    const viewWorkspacePath = state.workspacePath;
    if (!viewWorkspacePath) return false;
    const actionScope = resolveGoalActionScope(state, input.sessionId);
    if (!actionScope) return false;
    set({ operationId: `goal:update:${input.sessionId}`, error: null });
    try {
      await agentService.goalSession({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        sessionId: input.sessionId,
        action: "replace",
        objective: input.objective,
        endAtMs: input.endAtMs,
        tokenBudget: input.tokenBudget,
      });
      const requestId = ++goalLoadSeq;
      await loadInto(set, get, {
        workspacePath: viewWorkspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[goals] update failed", {
        sessionId: input.sessionId,
        error: toMessage(error),
      });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async pauseGoal(sessionId, agentService) {
    const state = get();
    if (!state.workspacePath) return false;
    const actionScope = resolveGoalActionScope(state, sessionId);
    if (!actionScope) return false;
    set({ operationId: `goal:pause:${sessionId}`, error: null });
    try {
      await agentService.goalSession({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        sessionId,
        action: "pause",
      });
      const requestId = ++goalLoadSeq;
      await loadInto(set, get, {
        workspacePath: state.workspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[goals] pause failed", { sessionId, error: toMessage(error) });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async resumeGoal(sessionId, endAtMs, agentService) {
    const state = get();
    if (!state.workspacePath) return false;
    const actionScope = resolveGoalActionScope(state, sessionId);
    if (!actionScope) return false;
    set({ operationId: `goal:resume:${sessionId}`, error: null });
    try {
      await agentService.goalSession({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        sessionId,
        action: "resume",
        // 已截止目标必须带新截止（或显式 null 表示不再设截止），服务端据此重置 graceUsed。
        endAtMs,
      });
      const requestId = ++goalLoadSeq;
      await loadInto(set, get, {
        workspacePath: state.workspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[goals] resume failed", { sessionId, error: toMessage(error) });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },

  async clearGoal(sessionId, agentService) {
    const state = get();
    if (!state.workspacePath) return false;
    const actionScope = resolveGoalActionScope(state, sessionId);
    if (!actionScope) return false;
    set({ operationId: `goal:clear:${sessionId}`, error: null });
    try {
      await agentService.goalSession({
        workspacePath: actionScope.workspacePath,
        ...(actionScope.workspaceIdentity
          ? { workspaceIdentity: actionScope.workspaceIdentity }
          : {}),
        sessionId,
        action: "clear",
      });
      const requestId = ++goalLoadSeq;
      await loadInto(set, get, {
        workspacePath: state.workspacePath,
        workspaceIdentity: state.workspaceIdentity,
        agentService,
        requestId,
      });
      return true;
    } catch (error) {
      logger.error("[goals] clear failed", { sessionId, error: toMessage(error) });
      set({ error: toMessage(error) });
      return false;
    } finally {
      set({ operationId: null });
    }
  },
}));
