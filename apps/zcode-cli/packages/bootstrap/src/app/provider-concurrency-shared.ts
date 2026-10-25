// ============================================================
// 同机跨端的并发共享：各进程广告自己的在飞数，别人从总额度里扣掉
// ============================================================
// 背景：`requestPolicy.maxConcurrent` 声明的是**上游**能同时吃几个请求。Windows 桌面与 WSL 远端
// 各限各的，合计就能到 2N——用户声明 5，上游看见 10，于是静默排队、一起超时、一起重试。想共用
// 一份额度，就必须知道「别的进程此刻占了几个」。
//
// 为什么不是「租约 + 心跳的分布式信号量」：那要把**槽的归属**写进共享状态，并在持有期不断续约。
// 于是崩溃会**永久泄漏槽**（计数器只增不减，只能人工删文件），而槽的租约时长必须 ≥ 最长请求时长
// （LLM 可能几分钟），睡眠/休眠又会把续约打停——醒来发现自己的槽被判死偷走，反而**超发**。为读一个
// 「别人占了多少」，代价和风险都不成比例。
//
// 这里用**广告 + 收敛**：每个进程只写自己那一份报告（一人一文件，无竞争、无锁），文件 mtime 就是
// 「还活着」的证据；别的进程在**自己要被挡住时**才去读一眼，用 `N − 别人` 压住自己的上限。三条
// 结构性好处：
// - **没有可泄漏的状态**：共享态从不记「谁持有槽」，进程崩了它的报告过期即止；
// - **没有锁**：一人一文件，写用「临时文件 + rename」，读者永远看不到半截 JSON；
// - **优雅降级**：目录不可达时别人的份额按 0 算，退回「各限各的」= 今天的行为，绝不会更差。
//
// 要认的代价是**收敛而非严格**：读数有刷新间隔（对方保活 1s、本地重读 ≥150ms、条目存活期 3s），
// 窗口内两端可能短暂超发，最坏仍退到今天（2N），稳态收敛到 N。上游的并发墙本来就是「超了会排队」，
// 这里要的是稳态不怼墙，不是毫秒级的精确配额。
//
// 放在哪：与配额账本同一个锚点（`%ProgramData%\zcode\provider-concurrency\`，WSL 侧
// `/mnt/c/...`），由装配层算目录。providerId 只进文件**内容**（排障看得见），文件名用哈希 + 实例 id。

import { createHash } from "node:crypto";
import { unlinkSync } from "node:fs";
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "@zcode/contracts";
import { createSharedFsClock } from "./provider-shared-fs-clock.js";

/** 共享目录名，挂在配额账本所在目录之下。 */
export const CONCURRENCY_SHARED_DIR_NAME = "provider-concurrency";

/** 别人报告的存活期：保活间隔的 3 倍，容忍丢两次拍。 */
const ENTRY_TTL_MS = 3_000;
/** 保活间隔：本进程有在飞请求时，至少这么勤地刷一次自己的报告（rename 保留 mtime，重写即刷活）。 */
const KEEPALIVE_INTERVAL_MS = 1_000;
/** 重读别人的最小间隔：被挡住时也别每个请求都去扫目录。 */
const REFRESH_MIN_INTERVAL_MS = 150;
/** 降级告警节流：目录长期不可达时一次说清就够。 */
const DEGRADE_LOG_INTERVAL_MS = 60_000;

export interface ProviderConcurrencySharedView {
  /**
   * 其它进程实例此刻报告的在飞数（**最后观察值**，同步）。未共享、目录不可达、别人都过期 = 0，
   * 也就是「按没开共享算」。
   */
  othersInFlight(providerId: string): number;
  /**
   * 重读磁盘上其它实例的报告并返回最新值。准入被本地视图挡住时调（视图可能偏悲观：别人早就放掉
   * 了，只是我们没重读）。带最小间隔节流；并发调用合并成一次。
   */
  refresh(providerId: string): Promise<number>;
  /** 报告本进程此刻的在飞数。写盘是异步的、失败静默（读不到就等于没开共享）。0 会删掉报告。 */
  report(providerId: string, count: number): void;
  /** 停掉定时器并删掉自己的报告（正常退出时用；硬杀由对方的存活期兜住）。 */
  dispose(): Promise<void>;
}

export interface ProviderConcurrencySharedViewOptions {
  /** 共享目录（由装配层从锚点算出）。 */
  readonly directory: string;
  /**
   * 本进程的实例 id。默认由 pid + 随机数生成；**测试要注入**——一个进程里造两个视图来模拟两端，
   * 靠的就是它不同。
   */
  readonly instanceId?: string;
  readonly logger?: Logger;
  /** 本端时钟（只用于节流判定，不用于判别人的存活——那必须问文件系统）。 */
  readonly now?: () => number;
  readonly schedule?: (callback: () => void, delayMs: number) => () => void;
  readonly sleep?: (delayMs: number) => Promise<void>;
  /** 存活性阈值与保活间隔（测试注入小值）。 */
  readonly entryTtlMs?: number;
  readonly keepaliveIntervalMs?: number;
  readonly refreshMinIntervalMs?: number;
  /** 是否挂进程退出钩子（测试关掉，免得多实例累积监听器）。 */
  readonly registerExitHook?: boolean;
}

interface ProviderState {
  readonly providerId: string;
  readonly filePath: string;
  /** 想对外报告的在飞数。 */
  desired: number;
  /** 已落盘的值；undefined = 还没写过，或需要强制重写（保活）。 */
  written?: number;
  writing: boolean;
  /** 保活定时器的取消函数（仅有在飞时存在）。 */
  cancelKeepalive?: () => void;
  /** 最后一次重读到的别人的在飞数，及读到的时刻（本端时钟，只用于节流）。 */
  cache: number;
  cacheAtMs?: number;
  refreshing?: Promise<number>;
}

const defaultSchedule = (callback: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  // 不让一个保活定时器把进程钉住：要退出时它不该有投票权。
  if (typeof timer === "object" && timer !== null && "unref" in timer) timer.unref();
  return () => clearTimeout(timer);
};

/** providerId → 文件名前缀：文件名要跨 Windows/WSL 都安全，所以用哈希；原值进内容供排障。 */
function providerFilePrefix(providerId: string): string {
  return createHash("sha256").update(providerId).digest("hex").slice(0, 16);
}

export function createProviderConcurrencySharedView(
  options: ProviderConcurrencySharedViewOptions,
): ProviderConcurrencySharedView {
  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const entryTtlMs = options.entryTtlMs ?? ENTRY_TTL_MS;
  const keepaliveIntervalMs = options.keepaliveIntervalMs ?? KEEPALIVE_INTERVAL_MS;
  const refreshMinIntervalMs = options.refreshMinIntervalMs ?? REFRESH_MIN_INTERVAL_MS;
  const instanceId =
    options.instanceId ?? `${process.pid.toString(36)}-${Math.random().toString(16).slice(2, 10)}`;
  const states = new Map<string, ProviderState>();
  const fsNowMs = createSharedFsClock({ directory: options.directory, prefix: "concurrency-clock" });
  let directoryReady = false;
  let lastDegradeLoggedAtMs: number | undefined;

  const logDegraded = (error: unknown, action: string): void => {
    const atMs = now();
    if (
      lastDegradeLoggedAtMs !== undefined &&
      atMs - lastDegradeLoggedAtMs < DEGRADE_LOG_INTERVAL_MS
    ) {
      return;
    }
    lastDegradeLoggedAtMs = atMs;
    options.logger?.warn?.(
      "Provider concurrency shared view unavailable; falling back to this process only",
      {
        event: "model.concurrency.shared_unavailable",
        module: "bootstrap.app",
        directory: options.directory,
        action,
        reason: error instanceof Error ? error.message : String(error),
      },
    );
  };

  const ensureDirectory = async (): Promise<void> => {
    if (directoryReady) return;
    await mkdir(options.directory, { recursive: true });
    directoryReady = true;
  };

  const ownFileName = (providerId: string): string =>
    `${providerFilePrefix(providerId)}.${instanceId}.json`;

  const stateFor = (providerId: string): ProviderState => {
    let state = states.get(providerId);
    if (state === undefined) {
      state = {
        providerId,
        filePath: join(options.directory, ownFileName(providerId)),
        desired: 0,
        writing: false,
        cache: 0,
      };
      states.set(providerId, state);
    }
    return state;
  };

  /** 写一次报告：0 = 删掉（别人按「没这个人」算，等价于份额全放掉）。 */
  const writeOnce = async (state: ProviderState, count: number): Promise<void> => {
    if (count === 0) {
      await unlink(state.filePath).catch(() => undefined);
      return;
    }
    await ensureDirectory();
    const tempPath = `${state.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await writeFile(
        tempPath,
        JSON.stringify({ version: 1, providerId: state.providerId, count }),
        "utf-8",
      );
      // rename 保留临时文件的 mtime——写一次同时把「我还活着」刷新了。
      await rename(tempPath, state.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  };

  /**
   * 把 `desired` 追平到磁盘。同一 provider 至多一次写在飞：写期间的多次 report 只更新 `desired`，
   * 循环末尾自然会带上最新值——密集准入会被合并成一次写，而不是排队等写。
   */
  const flush = async (state: ProviderState): Promise<void> => {
    if (state.writing) return;
    state.writing = true;
    try {
      for (;;) {
        const target = state.desired;
        if (state.written === target) break;
        await writeOnce(state, target);
        state.written = target;
        if (state.desired === target) break;
      }
    } catch (error) {
      logDegraded(error, "report");
    } finally {
      state.writing = false;
    }
  };

  /**
   * 有在飞请求就保活：定期强制重写一次自己的报告，否则对方按存活期把它当成死进程、份额被收回。
   * 重写（而不是 `utimes`）是有意的——writeFile 的 mtime 由文件系统给，`utimes` 会把**本端时钟**
   * 塞进 mtime，正好破坏「年龄要用同一个时钟量」这条。
   */
  const ensureKeepalive = (state: ProviderState): void => {
    if (state.cancelKeepalive !== undefined) return;
    state.cancelKeepalive = schedule(() => {
      state.cancelKeepalive = undefined;
      if (state.desired === 0) return;
      state.written = undefined;
      void flush(state);
      ensureKeepalive(state);
    }, keepaliveIntervalMs);
  };

  const stopKeepalive = (state: ProviderState): void => {
    state.cancelKeepalive?.();
    state.cancelKeepalive = undefined;
  };

  /** 读别人的报告：只看本 provider 的条目，跳过自己的、过期的、读不动的。 */
  const readOthers = async (state: ProviderState): Promise<number> => {
    await ensureDirectory();
    const names = await readdir(options.directory);
    const own = ownFileName(state.providerId);
    const prefix = `${providerFilePrefix(state.providerId)}.`;
    const candidates = names.filter(
      (name) => name.endsWith(".json") && name.startsWith(prefix) && name !== own,
    );
    if (candidates.length === 0) return 0;
    // 只有在真有候选时才取文件系统时钟：探针本身是一次写，别让常态空转。
    // 取不到时钟时不做年龄判定、把候选**全额算成在用**：判不了死活就假设别人都活着（保守），
    // 拿本端时钟硬判会把活进程的报告判成过期，那是反方向的错。
    let nowFs: number | undefined;
    try {
      nowFs = await fsNowMs();
    } catch (error) {
      logDegraded(error, "clock");
    }
    let sum = 0;
    for (const name of candidates) {
      const path = join(options.directory, name);
      if (nowFs !== undefined) {
        let mtimeMs: number;
        try {
          mtimeMs = (await stat(path)).mtimeMs;
        } catch {
          continue;
        }
        if (nowFs - mtimeMs >= entryTtlMs) {
          // 过期 = 对方崩了或睡了：收回它的份额，顺手清掉。
          await unlink(path).catch(() => undefined);
          continue;
        }
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(await readFile(path, "utf-8"));
      } catch {
        // 半截 JSON 只会来自非本实现的写入者（我们自己用 temp + rename）：跳过，别把它算成份额。
        continue;
      }
      if (typeof parsed !== "object" || parsed === null) continue;
      const entry = parsed as { providerId?: unknown; count?: unknown };
      if (entry.providerId !== state.providerId) continue;
      if (typeof entry.count !== "number" || !Number.isInteger(entry.count) || entry.count < 0) {
        continue;
      }
      sum += entry.count;
    }
    return sum;
  };

  const refresh = async (providerId: string): Promise<number> => {
    const state = stateFor(providerId);
    if (state.refreshing !== undefined) return await state.refreshing;
    const atMs = now();
    if (state.cacheAtMs !== undefined && atMs - state.cacheAtMs < refreshMinIntervalMs) {
      return state.cache;
    }
    state.refreshing = readOthers(state)
      .then((sum) => {
        state.cache = sum;
        state.cacheAtMs = now();
        return sum;
      })
      .catch((error: unknown) => {
        // 读不到 = 别人的份额按 0 算（退回各限各的），但**不**写入 cacheAtMs 之外的任何状态。
        logDegraded(error, "refresh");
        state.cache = 0;
        state.cacheAtMs = now();
        return 0;
      })
      .finally(() => {
        state.refreshing = undefined;
      });
    return await state.refreshing;
  };

  const report = (providerId: string, count: number): void => {
    const state = stateFor(providerId);
    const next = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    if (next === state.desired) return;
    state.desired = next;
    if (next === 0) stopKeepalive(state);
    else ensureKeepalive(state);
    void flush(state);
  };

  const unlinkOwnFilesSync = (): void => {
    for (const state of states.values()) {
      try {
        unlinkSync(state.filePath);
      } catch {
        // 已经不在（report(0) 删过）或删不掉：对方的存活期兜住。
      }
    }
  };

  const exitHook = (): void => unlinkOwnFilesSync();

  const dispose = async (): Promise<void> => {
    for (const state of states.values()) {
      stopKeepalive(state);
      state.desired = 0;
      await unlink(state.filePath).catch(() => undefined);
    }
    states.clear();
    process.removeListener("exit", exitHook);
  };

  if (options.registerExitHook !== false) process.once("exit", exitHook);

  return { othersInFlight: (providerId) => stateFor(providerId).cache, refresh, report, dispose };
}

let processView: ProviderConcurrencySharedView | undefined;

/**
 * 进程级单例。**必须是单例**：它报告的是「本进程此刻有几个在飞」，而进程里的 app（会话）可以有
 * 多个——每个 app 各造一份视图，对方就会看到本进程的多个条目、把同一批请求数重复加一遍。
 * 治理器本来就是进程单例，两者口径才对得上。
 *
 * `directory` 缺席 = 不共享（非 Windows/WSL，或用户显式关掉）：返回 undefined，调用方按「没有共享」
 * 处理，行为与从前逐字相同。
 */
export function getProviderConcurrencySharedView(input: {
  readonly directory?: string;
  readonly logger?: Logger;
}): ProviderConcurrencySharedView | undefined {
  if (processView !== undefined) return processView;
  if (input.directory === undefined) return undefined;
  processView = createProviderConcurrencySharedView({
    directory: input.directory,
    ...(input.logger === undefined ? {} : { logger: input.logger }),
  });
  return processView;
}
