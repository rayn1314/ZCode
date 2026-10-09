import type {
  ModelUsage,
  SessionId,
  SubagentTaskSnapshot,
  TraceContext,
  TurnId,
} from "@zcode/contracts";
import type { AgentOutput } from "@zcode/contracts";

// local_dynamic_workflow 与 local_workflow 刻意分开：后者是 legacy `Workflow` 工具（不可取消），
// 前者是 workflow run（经 DynamicWorkflowRunPort.cancel 可取消）。合成一个类型，取消分派就无法区分。
export type RuntimeTaskType =
  | "local_agent"
  | "local_bash"
  | "local_workflow"
  | "local_dynamic_workflow"
  | "monitor_mcp";

export interface RuntimeTaskUsageSnapshot {
  durationMs?: number;
  modelUsage?: ModelUsage;
  toolUseCount?: number;
  totalTokens?: number;
}

export interface RuntimeTaskPendingMessage {
  id: string;
  isMeta?: boolean;
  message: string;
  origin?: {
    kind: "coordinator";
    toolCallId?: string;
  };
  queuedAt: Date;
  summary?: string;
  traceContext?: TraceContext;
}

export interface RuntimeTaskMessageSink {
  send(message: RuntimeTaskPendingMessage): Promise<"queued" | "steered">;
}

export interface RuntimeTaskSnapshot extends SubagentTaskSnapshot {
  /** task 注册时所属 active conversation branch；用于迟到 completion fencing。 */
  branchGeneration?: number;
  exitCode?: number;
  type: RuntimeTaskType;
  isBackgrounded?: boolean;
  messageSink?: RuntimeTaskMessageSink;
  output?: AgentOutput;
  parentSessionId?: SessionId;
  pendingMessages?: RuntimeTaskPendingMessage[];
  prompt?: string;
  /**
   * runner 以前台模型覆盖（modelOverride）借跑本任务时为 true。这种运行没有
   * background request waiter，requestBackground 只改快照、放行不了前台等待；
   * 调用方（如 subagent 回复入队）必须据此如实报告协调者不可达，不能假装已转后台。
   */
  foregroundModelOverride?: boolean;
  /**
   * workflow run 产物的序列化文本。TaskOutput 的投影只读得到 registry 条目（dwf 从不写
   * outputFile），所以产物必须在终态更新时就存到条目上。
   */
  resultText?: string;
  /**
   * 是谁请求停止这个任务（"user" = GUI / 后台面板，"model" = TaskStop）。dwf 停止分支在调
   * 端口 cancel 之前写下它；终态通知稍后由 waiter 结算时读它。重臂（resume 新生命）随结算面复位。
   */
  stopInitiator?: "user" | "model";
  taskType?: RuntimeTaskType;
  traceContext?: TraceContext;
  turnId?: TurnId;
  usage?: RuntimeTaskUsageSnapshot;
}

export interface RuntimeTaskRegistry {
  all(): Record<string, RuntimeTaskSnapshot>;
  get(id: string): RuntimeTaskSnapshot | undefined;
  drainMessages(id: string): RuntimeTaskPendingMessage[];
  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined;
  register(task: RuntimeTaskSnapshot): void;
  remove(id: string): void;
  requestBackground(id: string): boolean;
  setActiveBranchGeneration?(generation: number): void;
  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined;
  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined>;
}

interface RuntimeTaskWaiter {
  onAbort?: () => void;
  reject: (error: unknown) => void;
  resolve: (task: RuntimeTaskSnapshot | undefined) => void;
  signal?: AbortSignal;
}

const TERMINAL_STATUSES = new Set<RuntimeTaskSnapshot["status"]>([
  "completed",
  "failed",
  "cancelled",
  "killed",
  "stopped",
  "lost",
]);

/**
 * 每个 runtime 在注册表里保留的**终态**条目上限。注册表此前只增不删（终态只 update、
 * `remove` 仅用于启动前的早期失败），长会话下 Map 无限膨胀。超过 N 时按 settle 时间
 *（`completedAt`，缺省 `startedAt`）最旧先出。
 *
 * 驱逐不破坏既有契约：
 * - `list-agents` live 行缺失时由 roster 的 history 行补齐（本就读历史投影）；
 * - `task-output` / `task-stop` 对未知 id 本就返回明确 not-found，不 crash；
 * - `hasRunningBackgroundRuntimeTask` 只看非终态，驱逐不影响；
 * - 通知在终态入队时消费，先入队后驱逐的窗口由 N 的余量覆盖。
 */
const MAX_TERMINAL_RETAINED = 50;

/**
 * 单个任务的待投递消息队列上限。`queueMessage` 超限**拒绝**并抛
 * {@link RuntimeTaskMessageQueueFullError}，由调用方把失败如实回给 SendMessage 调用方
 *（错误码 `agent_queue_full`），而不是无限堆积内存。
 */
export const MAX_PENDING_MESSAGES = 100;

/**
 * 目标任务的消息队列已满：本条消息**未入队**。调用方（runner 的 queued 分支）据此
 * 映射 SendMessage 的 `agent_queue_full` 失败，不得降级成假成功。
 */
export class RuntimeTaskMessageQueueFullError extends Error {
  readonly agentId: string;
  readonly capacity: number;

  constructor(agentId: string, capacity: number) {
    super(`Message queue for ${agentId} is full (capacity ${capacity})`);
    this.name = "RuntimeTaskMessageQueueFullError";
    this.agentId = agentId;
    this.capacity = capacity;
  }
}

export class InMemoryRuntimeTaskRegistry implements RuntimeTaskRegistry {
  private activeBranchGeneration = 0;
  private readonly backgroundWaiters = new Map<string, Set<RuntimeTaskWaiter>>();
  private readonly tasks = new Map<string, RuntimeTaskSnapshot>();
  private readonly terminalWaiters = new Map<string, Set<RuntimeTaskWaiter>>();

  register(task: RuntimeTaskSnapshot): void {
    const stamped = {
      ...task,
      branchGeneration: task.branchGeneration ?? this.activeBranchGeneration,
    };
    this.tasks.set(stamped.taskId, stamped);
    this.resolveIfTerminal(stamped.taskId, stamped);
    this.resolveIfBackgrounded(stamped.taskId, stamped);
    // 直接以终态注册（恢复 / 还原旧 snapshot 等）同样计入终态保留窗口。
    if (isTerminalRuntimeTask(stamped)) this.evictTerminalOverflow();
  }

  setActiveBranchGeneration(generation: number): void {
    this.activeBranchGeneration = generation;
  }

  update(
    id: string,
    patcher: (task: RuntimeTaskSnapshot) => RuntimeTaskSnapshot,
  ): RuntimeTaskSnapshot | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const next = patcher(current);
    this.tasks.set(id, next);
    this.resolveIfTerminal(id, next);
    this.resolveIfBackgrounded(id, next);
    // 只在「离开非终态」这一刻做驱逐检查：任务活动期的高频 update（messageSink、
    // 消息入队）不触发全表扫描，终态条目每条最多参与一次。
    if (!isTerminalRuntimeTask(current) && isTerminalRuntimeTask(next)) {
      this.evictTerminalOverflow();
    }
    return next;
  }

  requestBackground(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || isTerminalRuntimeTask(task)) return false;
    const next: RuntimeTaskSnapshot = { ...task, isBackgrounded: true };
    this.tasks.set(id, next);
    this.resolveBackgroundWaiters(id, next);
    return true;
  }

  remove(id: string): void {
    this.tasks.delete(id);
    this.resolveTerminalWaiters(id, undefined);
    this.resolveBackgroundWaiters(id, undefined);
  }

  get(id: string): RuntimeTaskSnapshot | undefined {
    return this.tasks.get(id);
  }

  all(): Record<string, RuntimeTaskSnapshot> {
    return Object.fromEntries(this.tasks);
  }

  queueMessage(id: string, message: RuntimeTaskPendingMessage): RuntimeTaskSnapshot | undefined {
    return this.update(id, (task) => {
      const pending = task.pendingMessages ?? [];
      // 超限拒绝：抛出交调用方如实回给 SendMessage；patcher 内抛错不会走到 tasks.set，
      // 注册表状态保持原样（不产生半入队）。
      if (pending.length >= MAX_PENDING_MESSAGES) {
        throw new RuntimeTaskMessageQueueFullError(id, MAX_PENDING_MESSAGES);
      }
      return {
        ...task,
        pendingMessages: [...pending, message],
      };
    });
  }

  drainMessages(id: string): RuntimeTaskPendingMessage[] {
    const task = this.tasks.get(id);
    if (!task || !task.pendingMessages || task.pendingMessages.length === 0) return [];
    const messages = task.pendingMessages;
    this.tasks.set(id, { ...task, pendingMessages: [] });
    return messages;
  }

  waitForBackgroundRequest(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || current.isBackgrounded || isTerminalRuntimeTask(current)) {
      return Promise.resolve(current?.isBackgrounded ? current : undefined);
    }
    return this.waitFor(this.backgroundWaiters, id, options);
  }

  waitForTerminal(
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const current = this.tasks.get(id);
    if (!current || isTerminalRuntimeTask(current)) return Promise.resolve(current);
    return this.waitFor(this.terminalWaiters, id, options);
  }

  private waitFor(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    options?: { signal?: AbortSignal },
  ): Promise<RuntimeTaskSnapshot | undefined> {
    const signal = options?.signal;
    if (signal?.aborted) return Promise.reject(abortReason(signal));

    return new Promise((resolve, reject) => {
      const waiter: RuntimeTaskWaiter = { resolve, reject, signal };
      if (signal) {
        waiter.onAbort = () => {
          this.removeWaiter(waitersByTask, id, waiter);
          reject(abortReason(signal));
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      let waiters = waitersByTask.get(id);
      if (!waiters) {
        waiters = new Set();
        waitersByTask.set(id, waiters);
      }
      waiters.add(waiter);
    });
  }

  private resolveIfBackgrounded(id: string, task: RuntimeTaskSnapshot): void {
    if (task.isBackgrounded) {
      this.resolveBackgroundWaiters(id, task);
    }
  }

  /**
   * 终态有界保留：超过 {@link MAX_TERMINAL_RETAINED} 条时按 settle 时间最旧先出。
   * 先收集后删除，避免遍历中改动 Map；只删终态条目，running 永不被驱逐。
   */
  private evictTerminalOverflow(): void {
    const terminal: RuntimeTaskSnapshot[] = [];
    for (const task of this.tasks.values()) {
      if (isTerminalRuntimeTask(task)) terminal.push(task);
    }
    if (terminal.length <= MAX_TERMINAL_RETAINED) return;
    terminal.sort(
      (left, right) =>
        settledAtMs(left) - settledAtMs(right) || left.taskId.localeCompare(right.taskId),
    );
    const overflow = terminal.length - MAX_TERMINAL_RETAINED;
    for (let index = 0; index < overflow; index++) {
      const task = terminal[index];
      if (task) this.remove(task.taskId);
    }
  }

  private resolveIfTerminal(id: string, task: RuntimeTaskSnapshot): void {
    if (isTerminalRuntimeTask(task)) {
      this.resolveTerminalWaiters(id, task);
      this.resolveBackgroundWaiters(id, undefined);
    }
  }

  private resolveBackgroundWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.backgroundWaiters, id, task);
  }

  private resolveTerminalWaiters(id: string, task: RuntimeTaskSnapshot | undefined): void {
    this.resolveWaiters(this.terminalWaiters, id, task);
  }

  private resolveWaiters(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    task: RuntimeTaskSnapshot | undefined,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waitersByTask.delete(id);
    for (const waiter of waiters) {
      if (waiter.signal && waiter.onAbort) {
        waiter.signal.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(task);
    }
  }

  private removeWaiter(
    waitersByTask: Map<string, Set<RuntimeTaskWaiter>>,
    id: string,
    waiter: RuntimeTaskWaiter,
  ): void {
    const waiters = waitersByTask.get(id);
    if (!waiters) return;
    waiters.delete(waiter);
    if (waiters.size === 0) waitersByTask.delete(id);
  }
}

export function isTerminalRuntimeTask(task: Pick<RuntimeTaskSnapshot, "status">): boolean {
  return TERMINAL_STATUSES.has(task.status);
}

/** 终态条目的 settle 时间：优先 completedAt，缺省回退 startedAt（只可能出现在畸形快照上）。 */
function settledAtMs(task: RuntimeTaskSnapshot): number {
  return task.completedAt?.getTime() ?? task.startedAt.getTime();
}

export function hasRunningBackgroundRuntimeTask(registry: RuntimeTaskRegistry): boolean {
  return Object.values(registry.all()).some(
    (task) => task.isBackgrounded === true && task.status === "running",
  );
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new Error("Runtime task wait aborted");
}
