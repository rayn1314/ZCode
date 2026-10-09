// ============================================================
// 进程级子代理驻留座位闸门（FIFO，容量迟绑定）
// ============================================================
// `Agent` 工具派发的子代理此前没有任何并发上界：一个父模型一口气 fan-out 几十个
// 子代理时，每个都占一份 child runtime、模型流与工具槽，资源面直接被打穿。业界
// Codex / Claude Code 均有会话内子代理上限，本闸门就是那条上界在本仓的落点。
//
// 与工作流侧 `workflow-seat-gate.ts` 的关系：那道闸门绑 workflow ask 生命周期、
// 把上界压到「下一次模型请求」上，属于 run 级；本闸门只管**驻留数**（多少个子代理
// 执行体同时活着），生命周期绑定 registry 的非终态条目。模型请求层的共享治理器
// （workflow-concurrency-governor 的 observer）两者互不依赖，各管各的维度。
//
// 三条纪律对齐工作流闸门：
//   1. **纯的**：不读时钟、不做 I/O、不起定时器。唯一的外部输入是 acquire 的
//      `signal`（abort 即出队）与 `capacity`（每次 acquire 迟绑定读取）。
//   2. **上界 ≥ 1 ⇒ 永不死锁**：容量 clamp 到 ≥ 1；占座者（在跑的子代理）的完成
//      不依赖任何新座位——子代理结构性地不能再派子代理（child runtime 的
//      `subagents.enabled:false`），不存在「等座的人被等座的人堵死」的环。
//   3. **结算必释放**：runner 在每个终态转换点归还 lease；lease 自身是终局闩锁，
//      重复 release 不会多放座位。
//
// 容量迟绑定：每次 `acquire({ capacity })` 读当前配置值，改配置后**新派发**即生效；
// 调小不召回已在跑的（对齐工作流 `setLimit` 纪律），只是此后放行更慢。

import { DEFAULT_SUBAGENT_MAX_CONCURRENT } from "@zcode/contracts";

/** 一个已占座位的归还凭证；`release()` 幂等（终局闩锁）。 */
export interface SubagentSeatLease {
  release(): void;
}

export interface SubagentSeatAcquireOptions {
  /** 等座期间被 abort：立即出队并以 `signal.reason` 拒绝，本次不占座。 */
  signal?: AbortSignal;
  /**
   * 当前配置容量（迟绑定）。缺席时沿用闸门当前值；传入值 clamp 到整数 ≥ 1。
   * 调小不召回在座者，只影响后续放行。
   */
  capacity?: number;
}

/** 观察面（测试与诊断用）：闸门此刻的三个计数。 */
export interface SubagentSeatGateStats {
  capacity: number;
  held: number;
  waiting: number;
}

export interface SubagentSeatGate {
  /** 等一个驻留座位：上界内立即返回 lease，否则按 FIFO 排队到有人归还。 */
  acquire(options?: SubagentSeatAcquireOptions): Promise<SubagentSeatLease>;
  stats(): SubagentSeatGateStats;
}

/** FIFO 里的一位：解开它的两个口，以及撤掉 abort 监听的那一手。 */
interface ParkedSeat {
  grant(): void;
  refuse(reason: unknown): void;
}

function clampCapacity(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.trunc(value));
}

export function createSubagentSeatGate(initialCapacity?: number): SubagentSeatGate {
  // 容量属于「当前配置的读数」，不是闸门的自有状态：它只在 acquire 时被调用方刷新。
  let capacity = clampCapacity(initialCapacity, DEFAULT_SUBAGENT_MAX_CONCURRENT);
  /** 已占座、执行体仍在跑的数量；lease.release 幂等地把它减回去。 */
  let held = 0;
  /** 等座位的派发，先来先走。 */
  const parked: ParkedSeat[] = [];

  /** 归还一个座位：按 FIFO 放行到新容量为止。 */
  const unpark = (): void => {
    while (held < capacity && parked.length > 0) {
      const seat = parked.shift()!;
      held++;
      seat.grant();
    }
  };

  const makeLease = (): SubagentSeatLease => {
    // 终局闩锁：同一次 settle 只释放一次。runner 侧多个收口点（前台 finally、
    // 转后台 continuation、后台 finally）可能先后调到同一 lease，重复 release
    // 不得再放出一个座位。
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        held--;
        unpark();
      },
    };
  };

  const acquire = (options?: SubagentSeatAcquireOptions): Promise<SubagentSeatLease> => {
    // 迟绑定：每次派发刷新容量读数。容量不随在座者变化——调小只是不再放行新的。
    capacity = clampCapacity(options?.capacity, capacity);
    const signal = options?.signal;
    if (signal?.aborted === true) {
      return Promise.reject(
        signal.reason ?? new Error("Subagent seat acquisition aborted before queueing"),
      );
    }
    // 快路径：上界之内原地通过，不动任何状态。
    if (held < capacity) {
      held++;
      return Promise.resolve(makeLease());
    }
    return new Promise<SubagentSeatLease>((resolve, reject) => {
      const onAbort = (): void => {
        const index = parked.indexOf(seat);
        // 出队即视为「从未占座」：等待被取消的派发不持有座位，也不参与 unpark 计数。
        if (index >= 0) parked.splice(index, 1);
        reject(signal?.reason ?? new Error("Subagent seat acquisition aborted"));
      };
      const seat: ParkedSeat = {
        grant: () => {
          signal?.removeEventListener("abort", onAbort);
          resolve(makeLease());
        },
        refuse: (reason) => {
          signal?.removeEventListener("abort", onAbort);
          reject(reason);
        },
      };
      parked.push(seat);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  };

  return {
    acquire,
    stats: () => ({ capacity, held, waiting: parked.length }),
  };
}

let processSubagentSeatGate: SubagentSeatGate | undefined;

/**
 * 进程级单例：派发发生在 core 的 subagent runner，而 core 不能 import bootstrap，
 * 所以闸门以模块级懒加载单例驻留在 core 内（形态对齐 bootstrap 的
 * `getWorkflowConcurrencyGovernor()`）。一个 CLI 进程里所有会话的子代理共享同一份
 * 驻留预算——这正是「进程级」的语义：资源是进程级的，账也记在进程级。
 */
export function getSubagentSeatGate(): SubagentSeatGate {
  processSubagentSeatGate ??= createSubagentSeatGate();
  return processSubagentSeatGate;
}
