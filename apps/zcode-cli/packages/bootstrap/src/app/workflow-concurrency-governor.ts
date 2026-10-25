// ============================================================
// Workflow 并发治理器（进程级；AIMD 按 provider/model 分桶，硬上限按 provider 一道闸）
// ============================================================
// 一个 CLI 进程里所有 run 加主代理
// 共用一个 provider 配额，所以治理器是**进程级**的。两层约束、两个粒度，别混：
//
// - **AIMD 桶**按 `${providerId}/${modelId}` 分：429 / Retry-After 这类「学习」信号是按模型来的
//   （不少服务商按模型分层配额），cap 的爬升、冷却、空闲重置都长在桶上。
// - **provider 闸门**按 providerId 一道：`requestPolicy.maxConcurrent` 是用户**声明**的上游硬上限
//   （该 provider 总共 N 个在飞）。有的服务商只限并发不限次数、超发还静默排队——AIMD 学不到墙，
//   只能靠声明卡住所有模型桶的在飞**总和**。未配置时这道闸不存在，行为与没有它时逐字相同。
//
// 同机跨端（Windows 桌面 + WSL 远端）时这道闸还能与另一个进程**分同一份额度**：`resolveSharedConcurrency`
// 给出对方广告的在飞数，本进程只用到 `N − 别人`（见 provider-concurrency-shared.ts 的取舍说明）。
// 那是**收敛而非严格**的读数，所以边界上可能短暂到 `N + 1`；未共享（非 Windows/WSL 或用户关掉）时
// 行为与从前逐字相同。
//
// 主代理（observer）在配置了硬上限的 provider 上也要守闸门，但守的是**provider 总量**这一道：
// 模型的 AIMD cap 与冷却都不拦它（决策 37 的本意是用户交互永不排队，AIMD 是对 workflow 流量的
// 治理，不该反过来阻塞用户）；它排在优先通道，放行次序先于任何 run 的等待者。未配置时维持
// 「无条件放行、只喂信号」（v3 决策 44/47）。
//
// 闸门粒度是**模型请求的每一次尝试**：runner 每次尝试前 `acquire`、尝试结束 `release`，
// 退避 sleep 期间不持槽。ticket 就是该次尝试的状态事件汇：runner 把该尝试的
// `ModelNetworkStatus` 事件同时投递给 ticket，治理器从 ticket 上读结果。本方案
// **不**再用 adapter 级 `addStatusSink`——同一事件不能既经 ticket 又经 adapter sink 各喂一次。
//
// 这里是治理器里**唯一**会碰时钟与定时器的地方：控制器只收 `now`；冷却到期要唤醒等待者，
// 所以需要一个 setTimeout（可注入，unref）。

import { resolveWorkflowModelFailurePolicy } from "@zcode/adapters/model";
import {
  ModelErrorCode,
  type ModelNetworkStatusEvent,
  type ModelRequestAdmission,
  type ModelRequestAdmissionTicket,
  type ModelRequestFailedStatusEvent,
  type ModelRequestTarget,
} from "@zcode/contracts";
import {
  ConcurrencyController,
  type ConcurrencyChange,
  type ConcurrencyControllerSnapshot,
  type ConcurrencyThrottleReason,
} from "@zcode/dynamic-workflow";
import {
  resolveWorkflowDefaultConcurrency,
  WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR,
} from "./workflow-default-concurrency.js";
import type { ProviderConcurrencySharedView } from "./provider-concurrency-shared.js";

/** provider key：AIMD 桶的最具体键（学习信号按模型来）。 */
export function workflowConcurrencyKey(model: ModelRequestTarget): string {
  return `${String(model.providerId)}/${String(model.modelId)}`;
}

/**
 * driver 看到的窄端口（不是整个治理器）。
 *
 * - `tryAdmit`：同步快路径——闸门开着**且没有任何人在排队**才给 ticket；否则 undefined，调用方再走
 *   `admit` 并报「等待槽位」。有等待者时不走快路径是公平性：否则一个请求密集的 run 会靠
 *   快路径越过别的 run 的队列。
 * - `admit`：排队（run 间轮转）直到模型桶的 AIMD 闸门与 provider 硬上限**同时**放行；`signal` 被
 *   abort 即出队并 reject（reject 原因是 `signal.reason`）。
 * - `subscribe`：本 run 触到的任何 key 上的 cap 变化。扇出只到**此刻在该 key 上有在飞或排队请求**的
 *   run（决策 8）。
 * - `setRunBound` / `clearRunBound`：本 run 自己的并发上界（launch 时登记、每次 retune 覆盖、launch
 *   结算时清掉）。它抬的是这个 run **用过的** key 的增长上限：`max(2D, 这些 run 的最大上界)`
 *   （docs/dynamic-workflow/concurrency.md「The governor」）——用户把一个 run 调到 40，桶的 cap 才
 *   爬得到 40，否则 40 个子代理会有一大半停在「等待槽位」。
 *
 * 入参是**模型身份**而不是预计算的桶键：provider 硬上限要按 providerId 查配置，桶与闸门是两个
 * 粒度，键算错一个就会让不同模型的在飞数绕开上限。
 */
export interface WorkflowConcurrencyPort {
  tryAdmit(runId: string, model: ModelRequestTarget): ModelRequestAdmissionTicket | undefined;
  admit(
    runId: string,
    model: ModelRequestTarget,
    signal: AbortSignal,
  ): Promise<ModelRequestAdmissionTicket>;
  subscribe(runId: string, listener: (change: ConcurrencyChange) => void): () => void;
  setRunBound(runId: string, bound: number): void;
  clearRunBound(runId: string): void;
}

interface WorkflowConcurrencyGovernor extends WorkflowConcurrencyPort {
  /**
   * 主代理用的 admission：未配置 provider 硬上限时 acquire 立即放行——不排队、不看冷却——但
   * **计入 inFlight** 且喂信号（它的请求 provider 同样看得见）。配置了硬上限时它守 provider 总量、
   * 排在优先通道，但模型的 AIMD cap 与冷却不拦它（用户交互永不被 workflow 流量阻塞——决策 37）。
   */
  observer(): ModelRequestAdmission;
  /** 控制器只读快照；没有这个 key 的桶时为 undefined。 */
  snapshot(key: string): ConcurrencyControllerSnapshot | undefined;
}

interface WorkflowConcurrencyGovernorOptions {
  /** 默认并发 D：桶创建时的初值与空闲重置的落点；自动增长到 `2 × D`。进程启动时算一次。 */
  defaultConcurrency: number;
  /**
   * 读某个 provider 声明的并发硬上限（`requestPolicy.maxConcurrent`）。答 undefined / 非法值 =
   * 未配置，provider 闸门不存在。**每次准入都重读**——用户在设置里改完就该立刻生效，与限速器同一条
   * 约定。治理器是进程单例、构造时拿不到 per-request 的 provider 配置，所以由装配层注入。
   */
  resolveMaxConcurrent?: (providerId: string) => number | undefined;
  /**
   * 同机跨端共享的在飞读数（Windows 桌面 + WSL 远端各限各的会合到 2N）。取用方式与
   * `resolveMaxConcurrent` 同一条间接层约定：治理器是进程单例、只在首次构造时吃 options，所以由
   * 装配层注入一个「此刻的视图」读取器。答 undefined = 不共享，行为与从前逐字相同。
   *
   * 它给出的是**别人报告的在飞数**（可能偏旧、可能偏保守），所以 `maxConcurrent` 由「本进程的
   * 上限」变成「上游那道上限在两端之间的分配」：本进程只用到 `N − 别人`。
   */
  resolveSharedConcurrency?: () => ProviderConcurrencySharedView | undefined;
  /** 时钟（可注入）。 */
  now?: () => number;
  /** 定时器（可注入）：冷却到期唤醒等待者。返回取消函数。 */
  schedule?: (callback: () => void, delayMs: number) => () => void;
}

/** 限流类 retry 原因 → 控制器的 throttled 信号。 */
const THROTTLE_REASONS: ReadonlySet<string> = new Set<ConcurrencyThrottleReason>([
  "rate_limited",
  "provider_overloaded",
  "offpeak_queued",
]);
/** 不是 provider 失败的 retry 原因：既不减 cap 也不清 streak——只当尝试终结。 */
const NON_FAILURE_RETRY_REASONS: ReadonlySet<string> = new Set([
  "reasoning_signature_repair",
  "auth_refresh",
]);

/**
 * 有在飞或排队时重读同机另一端读数的间隔。它决定「对方放掉一个名额」到「我们放行」之间的最坏延迟，
 * 也决定突发时按过期读数冲进去的窗口；请求本身以秒计，250ms 相对它可忽略，而 IO 只在有活动期间发生。
 */
const SHARED_CONCURRENCY_POLL_MS = 250;

interface Waiter {
  runId: string;
  resolve: (ticket: ModelRequestAdmissionTicket) => void;
  reject: (reason: unknown) => void;
  signal: AbortSignal;
  onAbort: () => void;
}

/**
 * provider 级闸门：`requestPolicy.maxConcurrent` 声明的是**这个 provider 总共**多少个在飞，
 * 与模型无关。所以它必须跨模型桶结算——分开数的话每个模型各到 N 个，合起来照样撞上游的墙。
 */
interface ProviderGate {
  readonly providerId: string;
  /** 配置的硬上限；undefined = 未配置，这道闸不存在（行为与没有它时逐字相同）。 */
  ceiling?: number;
  /** 该 provider 全部模型桶的在飞总和（含 observer）。 */
  inFlight: number;
  /**
   * 同机另一个进程报告的在飞数（最后观察值；未共享恒 0）。`maxConcurrent` 声明的是**上游**的墙，
   * 所以本进程实际只能用 `ceiling − 别人`。读数会偏旧——别人刚放掉而我们还没重读时它偏大
   * （我们少用一点，无害）；偏小的方向由「被挡住时立刻重读 + 有等待者时轮询」兜。
   */
  othersInFlight: number;
  /** 该 provider 的全部模型桶：释放名额或上限变化时要逐桶尝试放行等待者。 */
  readonly buckets: Set<Bucket>;
  /** 有等待者时的重读定时器（别人放行不会通知我们，只能轮询）。 */
  cancelSharedPoll?: () => void;
}

interface Bucket {
  readonly key: string;
  readonly providerId: string;
  readonly provider: ProviderGate;
  readonly controller: ConcurrencyController;
  /** 每个 run 在飞（已准入未结算）的请求数（扇出的依据：有在飞或排队请求的 run 才收 cap 变化）。 */
  readonly inFlightByRun: Map<string, number>;
  /** 等待者按 run 分队列（run 间轮转，大 fan-out 不能饿死后来的小 run）。 */
  readonly queues: Map<string, Waiter[]>;
  /**
   * 优先通道：主代理与 legacy 子代理（用户可见的交互路径）。只在配置了 provider 硬上限时使用——
   * 它们等的是 provider 总量，不参与模型的 AIMD cap 与冷却；放行先于任何 run 的队列。
   */
  readonly priorityWaiters: Waiter[];
  /** 轮转游标：上一次放行的 run，下一次从它之后开始找。 */
  lastGrantedRun?: string;
  /**
   * 在这个 key 上请求过准入的 run（observer 除外）。增长上限只看它们登记的上界：一个跑在别的
   * 模型上的大 run 不该抬这个 key。run 清掉上界时一并移出。
   */
  readonly runs: Set<string>;
  cancelCooldownWake?: () => void;
}

/** observer（主代理）的 run 身份：不排队、不订阅，只在扇出过滤里作为「不是任何 run」出现。 */
const OBSERVER_RUN_ID = "\0observer";

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个等冷却的定时器把进程钉住：run 结束、进程要退出时它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

export function createWorkflowConcurrencyGovernor(
  options: WorkflowConcurrencyGovernorOptions,
): WorkflowConcurrencyGovernor {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const buckets = new Map<string, Bucket>();
  const providerGates = new Map<string, ProviderGate>();
  /** run 级订阅（不按 key）：扇出时按桶的 engaged 集合过滤。 */
  const listeners = new Map<string, Set<(change: ConcurrencyChange) => void>>();
  const baseGrowthLimit = WORKFLOW_CONCURRENCY_AUTO_GROWTH_FACTOR * options.defaultConcurrency;
  /** 在飞 run 登记的自有上界（setRunBound / clearRunBound）。 */
  const runBounds = new Map<string, number>();

  const providerGateFor = (providerId: string): ProviderGate => {
    let gate = providerGates.get(providerId);
    if (gate === undefined) {
      gate = { providerId, inFlight: 0, othersInFlight: 0, buckets: new Set() };
      providerGates.set(providerId, gate);
    }
    return gate;
  };

  const bucketFor = (model: ModelRequestTarget): Bucket => {
    const key = workflowConcurrencyKey(model);
    let bucket = buckets.get(key);
    if (bucket === undefined) {
      // 惰性建桶，初值 = 默认并发；此后 run 来来去去都不重置它（只有空闲 5 分钟会，决策 19/20）。
      const provider = providerGateFor(String(model.providerId));
      bucket = {
        key,
        providerId: String(model.providerId),
        provider,
        controller: new ConcurrencyController(key, options.defaultConcurrency, baseGrowthLimit),
        inFlightByRun: new Map(),
        queues: new Map(),
        priorityWaiters: [],
        runs: new Set(),
      };
      buckets.set(key, bucket);
      provider.buckets.add(bucket);
    }
    return bucket;
  };

  /**
   * 重读并应用 provider 硬上限（每次准入路径都走这里，与限速器「改了立刻生效」同一条约定）。
   * 上限变化本身可能腾出/收紧容量：抬高或取消时立刻再 drain 一轮，压低的语义是「不再放新的」，
   * 已在飞的自然结束，不抢占。
   *
   * 顺带把同机另一端的读数同步进闸门：未共享时恒 0（= 只有本进程），共享时是本进程能用的额度
   * 里要先扣掉的那一份。这里只读**最后观察值**，重读磁盘在 `refreshSharedNow`。
   */
  const refreshProviderGate = (bucket: Bucket): void => {
    const gate = bucket.provider;
    let changed = false;
    const others = sharedView()?.othersInFlight(gate.providerId) ?? 0;
    if (others !== gate.othersInFlight) {
      gate.othersInFlight = others;
      changed = true;
    }
    if (options.resolveMaxConcurrent !== undefined) {
      const requested = options.resolveMaxConcurrent(gate.providerId);
      const next = requested === undefined ? undefined : Math.max(1, Math.floor(requested));
      if (next !== gate.ceiling) {
        gate.ceiling = next;
        // 上限从「没配」变成「配了」时，把当前在飞数先广告一次，别让另一端以为我们空着。
        // 空着就不必报（报 0 等于删掉报告，本来也没有）。
        if (gate.inFlight > 0) publishShared(gate);
        changed = true;
      }
    }
    if (changed) drainProvider(gate);
  };

  /** provider 闸门是否放行新的在飞。未配置上限 = 这道闸不存在。 */
  const providerOpen = (bucket: Bucket): boolean => {
    const ceiling = effectiveCeiling(bucket.provider);
    return ceiling === undefined || bucket.provider.inFlight < ceiling;
  };

  const waiterCount = (bucket: Bucket): number => {
    let total = bucket.priorityWaiters.length;
    for (const queue of bucket.queues.values()) total += queue.length;
    return total;
  };

  /** 该 provider 所有模型桶的等待者总数——provider 闸门共享，快路径的公平性要看全局。 */
  const providerWaiters = (gate: ProviderGate): number => {
    let total = 0;
    for (const bucket of gate.buckets) total += waiterCount(bucket);
    return total;
  };

  /** 同机跨端共享的读数（未共享时恒 undefined）。每次取用都经过 resolver：装配层可换实例。 */
  const sharedView = (): ProviderConcurrencySharedView | undefined =>
    options.resolveSharedConcurrency?.();

  /**
   * 本进程此刻能用的并发上限：上游那道上限扣掉别人报告的在飞数。
   *
   * 下限钳到 1：别人报满（或报了个比上限还大的数）时若算成 0，本进程会一个请求都发不出去、
   * 而缺口只能靠别人放行——一旦对方卡住就是**互等**。留 1 保证任何一侧都还在往前挪，代价是边界上
   * 可能短暂到 `N + 1`（共享读数本来就是收敛的，不是严格配额）。
   */
  const effectiveCeiling = (gate: ProviderGate): number | undefined =>
    gate.ceiling === undefined ? undefined : Math.max(1, gate.ceiling - gate.othersInFlight);

  /**
   * 把本进程的在飞数广告出去（仅在配置了硬上限时——没配就没有要分的额度），并顺带维护重读定时器。
   *
   * 上报与轮询绑在一起，是因为它们的触发时机完全一致：在飞数变化的那一刻。只在上报时轮询，读数的
   * 新鲜度就只取决于这一侧的活动——而别人的读数恰恰是**我们不活动**时会变的东西。
   */
  const publishShared = (gate: ProviderGate): void => {
    if (gate.ceiling === undefined) return;
    sharedView()?.report(gate.providerId, gate.inFlight);
    armSharedPoll(gate);
  };

  /**
   * 立刻重读别人的报告。准入要排队之前调：本地视图可能偏悲观（别人早放掉了、我们还没重读），
   * 不重读就会排一个假队、报一条假的「等待槽位」。
   */
  const refreshSharedNow = async (gate: ProviderGate): Promise<void> => {
    const view = sharedView();
    if (view === undefined || gate.ceiling === undefined) return;
    const others = await view.refresh(gate.providerId);
    if (others === gate.othersInFlight) return;
    gate.othersInFlight = others;
    drainProvider(gate);
  };

  /**
   * 有活动就定期重读别人的读数——别人放行不会通知我们，只能轮询。**有在飞也要轮询**，不只是有人
   * 排队时：额度是「别人占了多少」算出来的，要是只在自己被挡住时才重读，那第一次突发会按**过期**
   * 的读数（很可能是「别人空着」）冲进去，等撞上才知道——那正好是这条共享要防的场景。
   *
   * 空闲（没在飞也没人排队）就撤掉定时器：一次 IO 都不该发生。间隔 250ms 决定「对方放掉」到
   * 「我们放行」的最坏延迟，而请求本身以秒计。
   */
  const armSharedPoll = (gate: ProviderGate): void => {
    const view = sharedView();
    if (view === undefined || gate.ceiling === undefined) return;
    if (gate.inFlight === 0 && providerWaiters(gate) === 0) {
      gate.cancelSharedPoll?.();
      gate.cancelSharedPoll = undefined;
      return;
    }
    if (gate.cancelSharedPoll !== undefined) return;
    gate.cancelSharedPoll = schedule(() => {
      gate.cancelSharedPoll = undefined;
      void (async () => {
        await refreshSharedNow(gate);
        drainProvider(gate);
      })();
    }, SHARED_CONCURRENCY_POLL_MS);
  };

  /**
   * 扇出：只给此刻在该 key 上有在飞或排队请求的 run（决策 8）；`alsoTo` 另加一批收件人（上界引起的
   * 变化要到在这个 key 上登记着的 run，见 refreshGrowthLimit）。
   */
  const fanOut = (
    bucket: Bucket,
    changes: ConcurrencyChange[],
    alsoTo?: ReadonlySet<string>,
  ): void => {
    if (changes.length === 0) return;
    for (const [runId, set] of listeners) {
      const engaged =
        (bucket.inFlightByRun.get(runId) ?? 0) > 0 ||
        (bucket.queues.get(runId)?.length ?? 0) > 0 ||
        alsoTo?.has(runId) === true;
      if (!engaged) continue;
      for (const change of changes) {
        for (const listener of set) listener(change);
      }
    }
  };

  /**
   * 重算一个桶的增长上限：`max(2D, 用过它的 run 里登记过的最大上界)`，并在同一刻试着**起跳**到那个
   * 最大上界（docs/dynamic-workflow/concurrency.md「Seeding」）：用户把 run 调到 32，cap 就当场是
   * 32，而不是每四次成功爬一级。压低到 cap 之下时控制器当场拉低 cap（`limit_lowered`）；起跳在五分钟
   * 内被拒过时由控制器拒绝（`seeded` 不发），cap 照常爬。
   *
   * 这两种变化的起因是某个 run 的上界，而不是某个请求，所以扇出除了此刻 engaged 的 run，还要到
   * 每个在这个 key 上登记着的 run——retune 的那一刻，调高的那个 run 很可能一个请求都不在飞。
   */
  const refreshGrowthLimit = (bucket: Bucket): void => {
    let largestBound: number | undefined;
    for (const runId of bucket.runs) {
      const bound = runBounds.get(runId);
      if (bound !== undefined && (largestBound === undefined || bound > largestBound)) {
        largestBound = bound;
      }
    }
    const limit = Math.max(baseGrowthLimit, largestBound ?? 0);
    const changes =
      limit === bucket.controller.snapshot().growthLimit
        ? []
        : bucket.controller.setGrowthLimit(now(), limit);
    if (largestBound !== undefined) changes.push(...bucket.controller.seed(now(), largestBound));
    fanOut(bucket, changes, bucket.runs);
  };

  /** 一个 run 第一次在这个 key 上请求准入：记下它，它登记过的上界从此算进这个桶。 */
  const noteRunUsed = (bucket: Bucket, runId: string): void => {
    if (bucket.runs.has(runId)) return;
    bucket.runs.add(runId);
    if (runBounds.has(runId)) refreshGrowthLimit(bucket);
  };

  const bumpInFlight = (bucket: Bucket, runId: string, delta: number): void => {
    const next = (bucket.inFlightByRun.get(runId) ?? 0) + delta;
    if (next <= 0) bucket.inFlightByRun.delete(runId);
    else bucket.inFlightByRun.set(runId, next);
  };

  /**
   * 一次已准入尝试的 ticket：事件映射保持一致。任一终结映射后结算（幂等）；`release()`
   * 未见终结事件即按 `ended` 处理。结算后的 publish / release 一律惰性——runner 在极少数路径上
   * （尝试已结束后的兜底事件）可能仍会投递。
   */
  const mintTicket = (bucket: Bucket, runId: string, epoch: number): ModelRequestAdmissionTicket => {
    let settled = false;
    const settle = (signal: (at: number) => ConcurrencyChange[]): void => {
      if (settled) return;
      settled = true;
      const changes = signal(now());
      // 先扇出再减在飞：产生这条变化的请求正是本 run 的，它此刻仍算 engaged——否则一个 run 唯一的
      // 在飞请求撞出的减半，会因为「已经不在飞」而漏发给它自己。
      fanOut(bucket, changes);
      bumpInFlight(bucket, runId, -1);
      // provider 名额跨模型桶共享：释放的可能正是同 provider 另一个模型桶的等待者在等的那个名额。
      bucket.provider.inFlight = Math.max(0, bucket.provider.inFlight - 1);
      publishShared(bucket.provider);
      drainProvider(bucket.provider);
    };
    return {
      publish(event: ModelNetworkStatusEvent) {
        if (settled) return;
        switch (event.type) {
          case "model_request_started":
            // 准入时已计入 inFlight，这里没有新信息。
            return;
          case "model_request_completed":
            settle((at) => bucket.controller.succeeded(at, epoch));
            return;
          case "model_retry_scheduled": {
            const reason: string = event.reason;
            if (NON_FAILURE_RETRY_REASONS.has(reason)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            if (THROTTLE_REASONS.has(reason)) {
              settle((at) =>
                bucket.controller.throttled(
                  at,
                  epoch,
                  reason as ConcurrencyThrottleReason,
                  event.retryAfterMs,
                ),
              );
              return;
            }
            settle((at) => bucket.controller.failedTransient(at));
            return;
          }
          case "model_request_failed":
            // retryable:true 的 failed 紧随一条 retry_scheduled——那条才是信号。
            if (event.retryable) return;
            // Stop 集（配额、认证…）不是并发信号，只终结尝试。曾经配额 429 走下面的限流分支：
            // 1308 带的 Retry-After 指到额度窗口结束（可达数小时），冷却冻住整个桶、活得比停下的 run
            // 还久；用户用重置卡恢复额度后 resume，子代理全卡在闸门上一个请求不发，主代理（observer
            // 不看冷却）却照常工作，换模型（换桶）才继续。何时再试由用户决定，与 driver 读同一张策略表。
            if (isWorkflowStopFailure(event)) {
              settle((at) => bucket.controller.ended(at));
              return;
            }
            // 不可重试的限流：
            // 主对话 / 工具侧撞上 3008 这类被分类器判终止的 429，仍是一次字面意义上的并发信号——
            // 只当「链结束」会让 cap 从未因它降过。
            if (event.reason === "rate_limited") {
              settle((at) =>
                bucket.controller.throttled(at, epoch, "rate_limited", event.retryAfterMs),
              );
              return;
            }
            settle((at) => bucket.controller.ended(at));
            return;
          default:
            return;
        }
      },
      release() {
        settle((at) => bucket.controller.ended(at));
      },
    };
  };

  /** 放行一个请求：`observe` 在前（准入也是一次「信号」），再 `admitted` 拿 epoch。 */
  const grant = (bucket: Bucket, runId: string): ModelRequestAdmissionTicket => {
    fanOut(bucket, bucket.controller.observe(now()));
    const epoch = bucket.controller.admitted(now());
    bumpInFlight(bucket, runId, 1);
    bucket.provider.inFlight += 1;
    // 广告本进程的在飞数：同机另一端的 `N − 别人` 靠它算。
    publishShared(bucket.provider);
    bucket.lastGrantedRun = runId;
    return mintTicket(bucket, runId, epoch);
  };

  /** 按轮转挑下一个有等待者的 run。 */
  const nextRunWithWaiters = (bucket: Bucket): string | undefined => {
    const runs = [...bucket.queues.keys()].filter((runId) => (bucket.queues.get(runId)?.length ?? 0) > 0);
    if (runs.length === 0) return undefined;
    const last = bucket.lastGrantedRun;
    const lastIndex = last === undefined ? -1 : runs.indexOf(last);
    return runs[(lastIndex + 1) % runs.length];
  };

  const armCooldownWake = (bucket: Bucket): void => {
    bucket.cancelCooldownWake?.();
    bucket.cancelCooldownWake = undefined;
    if (waiterCount(bucket) === 0) return;
    const until = bucket.controller.snapshot().cooldownUntil;
    if (until === undefined) return;
    const delay = Math.max(0, until - now());
    bucket.cancelCooldownWake = schedule(() => {
      bucket.cancelCooldownWake = undefined;
      drain(bucket);
    }, delay);
  };

  /** 放行尽可能多的等待者（闸门：AIMD cap 允许、在冷却外、且 provider 总量未到硬上限），喂 waiters。 */
  const drain = (bucket: Bucket): void => {
    fanOut(bucket, bucket.controller.observe(now()));
    // 优先通道只守 provider 闸门：配置了硬上限时，模型的 AIMD cap 与 Retry-After 冷却不拦主代理
    // （决策 37 的本意——用户交互排在 workflow 治理之后就成了本末倒置）。未配置时这条队列恒空。
    while (bucket.priorityWaiters.length > 0 && providerOpen(bucket)) {
      const waiter = bucket.priorityWaiters.shift()!;
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, OBSERVER_RUN_ID));
    }
    for (;;) {
      fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
      if (!providerOpen(bucket)) break;
      if (!bucket.controller.canAdmit(now())) break;
      const runId = nextRunWithWaiters(bucket);
      if (runId === undefined) break;
      const queue = bucket.queues.get(runId)!;
      const waiter = queue.shift()!;
      if (queue.length === 0) bucket.queues.delete(runId);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(grant(bucket, runId));
    }
    fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
    armCooldownWake(bucket);
    // 排队等的是「provider 名额」，其中可能有另一半在别的进程手里——那边放行不会通知我们。
    armSharedPoll(bucket.provider);
  };

  /** provider 名额或上限变化后：这个 provider 的每个模型桶都可能被放行一个等待者。 */
  const drainProvider = (gate: ProviderGate): void => {
    for (const bucket of gate.buckets) {
      if (waiterCount(bucket) > 0) drain(bucket);
    }
  };

  const tryAdmit: WorkflowConcurrencyPort["tryAdmit"] = (runId, model) => {
    const bucket = bucketFor(model);
    noteRunUsed(bucket, runId);
    refreshProviderGate(bucket);
    fanOut(bucket, bucket.controller.observe(now()));
    if (
      waiterCount(bucket) > 0 ||
      !providerOpen(bucket) ||
      !bucket.controller.canAdmit(now())
    ) {
      return undefined;
    }
    return grant(bucket, runId);
  };

  const admit: WorkflowConcurrencyPort["admit"] = async (runId, model, signal) => {
    const bucket = bucketFor(model);
    if (signal.aborted) throw abortedError(signal);
    noteRunUsed(bucket, runId);
    refreshProviderGate(bucket);
    // 挡住我们的可能是**另一端**的在飞（本地视图偏旧、偏悲观）：先重读一次再排队，
    // 别为一次已经腾出来的名额排一个假队。
    if (bucket.provider.othersInFlight > 0 && !providerOpen(bucket)) {
      await refreshSharedNow(bucket.provider);
    }
    if (signal.aborted) throw abortedError(signal);
    return await new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
      const waiter: Waiter = { runId, resolve, reject, signal, onAbort: () => {} };
      waiter.onAbort = () => {
        const queue = bucket.queues.get(runId);
        if (queue !== undefined) {
          const index = queue.indexOf(waiter);
          if (index >= 0) queue.splice(index, 1);
          if (queue.length === 0) bucket.queues.delete(runId);
        }
        reject(abortedError(signal));
        fanOut(bucket, bucket.controller.waiters(now(), waiterCount(bucket)));
        armCooldownWake(bucket);
      };
      signal.addEventListener("abort", waiter.onAbort, { once: true });
      const queue = bucket.queues.get(runId) ?? [];
      queue.push(waiter);
      bucket.queues.set(runId, queue);
      drain(bucket);
    });
  };

  const subscribe: WorkflowConcurrencyPort["subscribe"] = (runId, listener) => {
    const set = listeners.get(runId) ?? new Set();
    set.add(listener);
    listeners.set(runId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(runId);
    };
  };

  const setRunBound: WorkflowConcurrencyPort["setRunBound"] = (runId, bound) => {
    runBounds.set(runId, bound);
    for (const bucket of buckets.values()) {
      if (bucket.runs.has(runId)) refreshGrowthLimit(bucket);
    }
  };

  const clearRunBound: WorkflowConcurrencyPort["clearRunBound"] = (runId) => {
    runBounds.delete(runId);
    for (const bucket of buckets.values()) {
      if (bucket.runs.delete(runId)) refreshGrowthLimit(bucket);
    }
  };

  // 未配置 provider 硬上限时：不排队、不看冷却、无条件放行（v3 决策 37/44/47），只计入 inFlight 并
  // 喂信号。配置后：守 provider 总量、走优先通道，但模型的 AIMD cap 与冷却仍不拦它——它等的是上游
  // 声明的并发墙，不是本地对 workflow 流量的治理。
  const observerAdmission: ModelRequestAdmission = {
    tryAcquire: ({ model }) => {
      const bucket = bucketFor(model);
      refreshProviderGate(bucket);
      if (bucket.provider.ceiling === undefined) return grant(bucket, OBSERVER_RUN_ID);
      // 有等待者就不走快路径：快路径只给「真的没人等」的时刻，否则主代理会越过同 provider 的排队者。
      if (providerWaiters(bucket.provider) > 0 || !providerOpen(bucket)) return undefined;
      return grant(bucket, OBSERVER_RUN_ID);
    },
    acquire: async ({ model, signal }) => {
      const bucket = bucketFor(model);
      refreshProviderGate(bucket);
      if (bucket.provider.ceiling === undefined) return grant(bucket, OBSERVER_RUN_ID);
      if (signal?.aborted === true) throw abortedError(signal);
      if (providerWaiters(bucket.provider) === 0 && providerOpen(bucket)) {
        return grant(bucket, OBSERVER_RUN_ID);
      }
      // 与 run 路径同一条：先重读另一端，再决定要不要真的排队。重读是异步的，回来要再确认一次取消
      // ——这里用函数调用而不是字面比较，避免 TS 把上面那次判断的类型收窄带过来。
      if (bucket.provider.othersInFlight > 0) await refreshSharedNow(bucket.provider);
      if (isAborted(signal)) throw abortedError(signal);
      if (providerWaiters(bucket.provider) === 0 && providerOpen(bucket)) {
        return grant(bucket, OBSERVER_RUN_ID);
      }
      const effectiveSignal = signal ?? new AbortController().signal;
      return await new Promise<ModelRequestAdmissionTicket>((resolve, reject) => {
        const waiter: Waiter = {
          runId: OBSERVER_RUN_ID,
          resolve,
          reject,
          signal: effectiveSignal,
          onAbort: () => {},
        };
        waiter.onAbort = () => {
          const index = bucket.priorityWaiters.indexOf(waiter);
          if (index >= 0) bucket.priorityWaiters.splice(index, 1);
          reject(abortedError(effectiveSignal));
        };
        effectiveSignal.addEventListener("abort", waiter.onAbort, { once: true });
        bucket.priorityWaiters.push(waiter);
        drain(bucket);
      });
    },
  };

  return {
    tryAdmit,
    admit,
    subscribe,
    setRunBound,
    clearRunBound,
    observer: () => observerAdmission,
    snapshot(key) {
      return buckets.get(key)?.controller.snapshot();
    },
  };
}

/**
 * 不可重试的失败是否落在 workflow 策略表的 Stop 集里（docs/dynamic-workflow/concurrency.md
 * 「Retry budget and the model-error policy」）。runner 与 driver 读的是同一个函数，三层对 Stop 集的
 * 判断不会分叉；缺 `errorCode` 时按通用请求失败读，配额判定只看业务码。
 */
function isWorkflowStopFailure(event: ModelRequestFailedStatusEvent): boolean {
  return (
    resolveWorkflowModelFailurePolicy(
      {
        code: event.errorCode ?? ModelErrorCode.ModelRequestFailed,
        reason: event.reason,
        retryable: event.retryable,
      },
      event.providerErrorCode,
    ).decision === "stop"
  );
}

function abortedError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new Error("workflow request admission aborted");
}

/** 取消判定走函数：调用点常有「await 之后再确认一次」的写法，字面比较会被类型收窄传染。 */
function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

let processGovernor: WorkflowConcurrencyGovernor | undefined;
/**
 * 当前 app 背后的 per-provider 硬上限 resolver。治理器是单例、只在首次构造时吃 options，所以与
 * 限速器同一条间接层约定：进程里的多个 app 先后取用单例时，后一个要能把 resolver 换成自己的
 * Provider Registry。配置每次准入重读——改了立刻生效。
 */
let processMaxConcurrentResolver: ((providerId: string) => number | undefined) | undefined;
/**
 * 同机跨端共享的在飞读数（见 `resolveSharedConcurrency`）。与 resolver 同一约定：单例只构造一次，
 * 所以「此刻用哪份视图」放模块级，每次取用都重新读。
 */
let processSharedConcurrency: ProviderConcurrencySharedView | undefined;

/**
 * 进程级单例（决策 5）：默认并发在首次取用时算一次；此后每个 app（会话）的主 runtime 挂它的
 * observer，run service 拿同一个端口给 driver。
 */
export function getWorkflowConcurrencyGovernor(options?: {
  readonly resolveMaxConcurrent?: (providerId: string) => number | undefined;
  readonly sharedConcurrency?: ProviderConcurrencySharedView;
}): WorkflowConcurrencyGovernor {
  processMaxConcurrentResolver = options?.resolveMaxConcurrent;
  processSharedConcurrency = options?.sharedConcurrency;
  processGovernor ??= createWorkflowConcurrencyGovernor({
    defaultConcurrency: resolveWorkflowDefaultConcurrency(),
    resolveMaxConcurrent: (providerId) => processMaxConcurrentResolver?.(providerId),
    resolveSharedConcurrency: () => processSharedConcurrency,
  });
  return processGovernor;
}
