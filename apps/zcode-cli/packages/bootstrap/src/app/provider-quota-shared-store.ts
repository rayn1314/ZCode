// ============================================================
// provider 配额的跨进程共享账本（同机场景：Windows 桌面 + WSL 远端）
// ============================================================
// 令牌桶原本只在进程内，于是「Windows 限 20/min、WSL 限 20/min」跑起来合计能到 40/min——用户限了
// 速却还在撞服务商 429。同机两端虽然数据根隔离，但摸得到**同一块磁盘**（Windows 侧 %ProgramData%，
// WSL 侧 /mnt/c/...），所以把桶的余额落到一个共享文件，每次请求在文件锁下「读 → 补 → 扣 → 写」，
// 两端就共用一个账本。
//
// 三条不变式：
// 1. **绝不 fail-open**。锁超时、目录不可写、内容损坏都退回进程内限速（= 没有共享账本时的行为），
//    代价只是合计可能超配额；反过来「读不到就不限速」会让一次挂载失败变成完全不限速。
// 2. **跨环境不认 pid**。Windows 的进程号在 WSL 里毫无意义，用 pid 判活会把**活锁**当成僵尸偷走，
//    于是两个进程同时进临界区。判僵尸只看锁文件的 mtime 年龄。
// 3. 写是「同目录临时文件 + rename」，读者不会看到半截 JSON。
//
// 键是**账号指纹**而不是 providerId：配额长在账号上，同一台机器上两个不同的 Key（比如同一个中转
// 站的两个账号）共用一个 providerId 时不该互相限流。

import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "@zcode/contracts";
import {
  MINUTE_MS,
  msUntilNextQuotaToken,
  normalizeRequestsPerMinute,
  refillQuotaState,
  type QuotaState,
} from "./provider-quota-math.js";

/** 覆盖共享账本位置。绝对路径；值写成 `off` / `0` / `false` 则显式关闭共享。 */
export const PROVIDER_QUOTA_SHARED_FILE_ENV = "ZCODE_PROVIDER_QUOTA_SHARED_FILE";

const SHARED_FILE_NAME = "provider-quota.json";
const SHARED_DIR_NAME = "zcode";

/** 锁被持有多久算僵尸。临界区只有几次文件 IO，10 秒足够宽松，也吸得住两端之间的时钟偏差。 */
const LOCK_STALE_MS = 10_000;
/** 抢锁的重试间隔与总时限：**必须短**，抢不到就降级，不能把模型请求挂在文件锁上。 */
const LOCK_RETRY_DELAY_MS = 8;
const LOCK_TIMEOUT_MS = 2_000;

const DISABLED_VALUES = new Set(["off", "0", "false", "none"]);

export type ProviderQuotaConsumeOutcome =
  | { readonly kind: "granted" }
  | { readonly kind: "exhausted"; readonly retryInMs: number };

/**
 * 跨进程的配额账本。实现里任何「拿不到账本」的情况都 **throw**，由调用方降级为进程内限速；
 * 绝不允许用「拿不到就当没限制」的方式返回成功。
 */
export interface ProviderQuotaSharedStore {
  tryConsume(input: {
    readonly key: string;
    readonly requestsPerMinute: number;
    readonly atMs: number;
  }): Promise<ProviderQuotaConsumeOutcome>;
}

export interface FileProviderQuotaStoreOptions {
  filePath: string;
  now?: () => number;
  /** 抢锁失败后的退避（可注入：测试不必真等）。 */
  sleep?: (delayMs: number) => Promise<void>;
  logger?: Logger;
}

interface StoreFile {
  version: 1;
  buckets: Record<string, QuotaState>;
}

/**
 * 共享账本落在哪。两端必须算到**同一个文件**，所以锚点是「这台机器的系统盘」而不是各自的数据根：
 * Windows 用 `%ProgramData%`，WSL 用 `/mnt/c/ProgramData`（默认挂载下指向同一个目录）。
 *
 * 锚点从环境里读**不到**就返回 undefined（不共享），不回落到硬编码的 `C:\ProgramData`：注入的
 * 空 env（测试、被清洗过的环境）会因此静默写到真实机器的共享位置。同理，不在这里做 exists /
 * 可写性探测——那是 IO，且探测通过也仍可能在写入时失败；位置算出来就交给账本，用不了自然走
 * fail-safe 降级。
 */
export function resolveProviderQuotaSharedFilePath(
  env: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const configured = env[PROVIDER_QUOTA_SHARED_FILE_ENV]?.trim();
  if (configured !== undefined && configured !== "") {
    return DISABLED_VALUES.has(configured.toLowerCase()) ? undefined : configured;
  }
  if (platform === "win32") {
    const programData = env.ProgramData?.trim();
    return programData === undefined || programData === ""
      ? undefined
      : join(programData, SHARED_DIR_NAME, SHARED_FILE_NAME);
  }
  // 只在 WSL 里共享：那里 /mnt/c 指向本机的 Windows 系统盘，与桌面端落在同一文件。
  // 纯 Linux / macOS 不猜位置——多用户机器上猜错会让两个用户互相限流，宁可不共享。
  const distroName = env.WSL_DISTRO_NAME?.trim();
  if (platform === "linux" && distroName !== undefined && distroName !== "") {
    return `/mnt/c/ProgramData/${SHARED_DIR_NAME}/${SHARED_FILE_NAME}`;
  }
  return undefined;
}

/**
 * 账号指纹：providerId + 协议 + 端点 + 凭据摘要。凭据只进哈希，文件里看不到 Key 本身。
 * 同一个 providerId 配了不同 Key（中转站的两个账号）会被分到两个桶，不会互相限流。
 */
export function computeSharedQuotaKey(input: {
  providerId: string;
  apiType?: string | undefined;
  baseUrl?: string | undefined;
  apiKey?: string | undefined;
}): string {
  const secretDigest =
    input.apiKey === undefined || input.apiKey === ""
      ? "no-secret"
      : createHash("sha256").update(input.apiKey).digest("hex");
  const accountDigest = createHash("sha256")
    .update([input.apiType ?? "", input.baseUrl ?? "", secretDigest].join("\n"))
    .digest("hex")
    .slice(0, 16);
  // providerId 明文留在键里：不是秘密，且出问题时能直接看出是哪条供应商。
  return `${input.providerId}--${accountDigest}`;
}

function emptyStoreFile(): StoreFile {
  return { version: 1, buckets: {} };
}

function parseStoreFile(raw: string): StoreFile {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null) return emptyStoreFile();
  const buckets = (parsed as { buckets?: unknown }).buckets;
  if (typeof buckets !== "object" || buckets === null) return emptyStoreFile();
  const result: Record<string, QuotaState> = {};
  for (const [key, value] of Object.entries(buckets as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) continue;
    const state = value as Partial<QuotaState>;
    if (typeof state.tokens !== "number" || !Number.isFinite(state.tokens)) continue;
    if (typeof state.updatedAtMs !== "number" || !Number.isFinite(state.updatedAtMs)) continue;
    if (typeof state.requestsPerMinute !== "number" || !Number.isFinite(state.requestsPerMinute)) {
      continue;
    }
    result[key] = {
      requestsPerMinute: state.requestsPerMinute,
      tokens: state.tokens,
      updatedAtMs: state.updatedAtMs,
    };
  }
  return { version: 1, buckets: result };
}

export function createFileProviderQuotaStore(
  options: FileProviderQuotaStoreOptions,
): ProviderQuotaSharedStore {
  const now = options.now ?? Date.now;
  const sleep =
    options.sleep ?? ((delayMs: number) => new Promise<void>((r) => setTimeout(r, delayMs)));
  const lockPath = `${options.filePath}.lock`;
  let directoryReady = false;

  const ensureDirectory = async (): Promise<void> => {
    if (directoryReady) return;
    await mkdir(dirname(options.filePath), { recursive: true });
    directoryReady = true;
  };

  const readState = async (): Promise<StoreFile> => {
    try {
      return parseStoreFile(await readFile(options.filePath, "utf-8"));
    } catch (error) {
      // ENOENT 是首次运行；内容损坏则按空账本继续（下一次写就修好），但要说一声。
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        options.logger?.warn?.("Provider quota shared store unreadable", {
          event: "provider.quota.shared.read_failed",
          module: "bootstrap.app",
          filePath: options.filePath,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
      return emptyStoreFile();
    }
  };

  const writeState = async (state: StoreFile): Promise<void> => {
    const tempPath = `${options.filePath}.${process.pid}.${now()}.${Math.random()
      .toString(16)
      .slice(2)}.tmp`;
    try {
      await writeFile(tempPath, JSON.stringify(state), "utf-8");
      await rename(tempPath, options.filePath);
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  };

  /** 锁是「独占创建」的文件，内容只是给排障看的线索；判僵尸只看 mtime 年龄，不看 pid（见文件头）。 */
  const isLockStale = async (): Promise<boolean> => {
    try {
      const metadata = await stat(lockPath);
      return now() - metadata.mtimeMs >= LOCK_STALE_MS;
    } catch {
      return false;
    }
  };

  const acquireLock = async (): Promise<() => Promise<void>> => {
    await ensureDirectory();
    const deadlineMs = now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        const handle = await open(lockPath, "wx");
        await handle
          .writeFile(JSON.stringify({ acquiredAtMs: now(), pid: process.pid }), "utf-8")
          .catch(() => undefined);
        return async () => {
          await handle.close().catch(() => undefined);
          await unlink(lockPath).catch(() => undefined);
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await isLockStale()) {
          // 上一个持锁者崩了（或另一个环境的时钟快了）：接管。并发接管由 wx 独占创建兜住，
          // 只有一个能成功，其余的继续重试。
          await unlink(lockPath).catch(() => undefined);
          continue;
        }
        if (now() + LOCK_RETRY_DELAY_MS > deadlineMs) {
          throw new Error("Provider quota shared store lock timeout");
        }
        await sleep(LOCK_RETRY_DELAY_MS);
      }
    }
  };

  return {
    tryConsume: async (input) => {
      const requestsPerMinute = normalizeRequestsPerMinute(input.requestsPerMinute);
      if (requestsPerMinute === undefined) return { kind: "granted" };
      const release = await acquireLock();
      try {
        const state = await readState();
        const bucket: QuotaState = state.buckets[input.key] ?? {
          requestsPerMinute,
          tokens: requestsPerMinute,
          updatedAtMs: input.atMs,
        };
        // 上限每次重读（与进程内桶一致）：改配置立刻生效，但**不重置余额**。
        bucket.requestsPerMinute = requestsPerMinute;
        refillQuotaState(bucket, input.atMs);
        if (bucket.tokens >= 1) {
          bucket.tokens -= 1;
          state.buckets[input.key] = bucket;
          await writeState(state);
          return { kind: "granted" };
        }
        const retryInMs = msUntilNextQuotaToken(bucket);
        // 余额不足也要写回：refill 推进了 updatedAtMs，不写回会让下一次重新按旧时刻补算。
        state.buckets[input.key] = bucket;
        await writeState(state);
        return { kind: "exhausted", retryInMs: Math.min(retryInMs, MINUTE_MS) };
      } finally {
        await release();
      }
    },
  };
}
