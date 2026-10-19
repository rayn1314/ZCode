import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { acquireFileLock } from "./atomicFileLock.js";

const DEFAULT_LOCK_RETRY_DELAYS_MS = [25, 50, 100, 200, 400] as const;
const DEFAULT_LOCK_OWNERLESS_GRACE_MS = 100;
const DEFAULT_LOCK_MAX_WAIT_MS = 8_000;
// Windows 无法把文件 rename 覆盖到任何被打开（未带 FILE_SHARE_DELETE）的目标上：并发 reader、
// 索引器或杀毒扫描都会让 rename 返回 EPERM/EACCES。这不是瞬时抖动，而是必须等对方释放句柄，
// 所以用「时间预算 + 指数退避 + 抖动」代替固定几次重试：早期密集抢短窗口，后期拉开间隔等慢扫描。
// 预算刻意小于跨进程文件锁的 8s 上限，避免单次写入把对端顶到锁超时。
const DEFAULT_RENAME_RETRY_BUDGET_MS = 3_000;
const RENAME_RETRY_BASE_DELAY_MS = 25;
const RENAME_RETRY_MAX_DELAY_MS = 500;
const RENAME_RETRY_JITTER_RATIO = 0.25;
const processFileLockTails = new Map<string, Promise<void>>();

export interface SharedFileLockOptions {
  lockRetryDelaysMs?: readonly number[];
  lockOwnerlessGraceMs?: number;
  lockMaxWaitMs?: number;
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isRetryableRenameError(error: unknown): boolean {
  const code = getErrorCode(error);
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

async function renameWithRetry(
  tempFile: string,
  filePath: string,
  retryBudgetMs: number,
): Promise<void> {
  const deadlineMs = Date.now() + Math.max(retryBudgetMs, 0);
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(tempFile, filePath);
      return;
    } catch (error) {
      // 早期密集重试抢短窗口，触顶后按 500ms 间隔等慢扫描；抖动按 pid + 次数派生，
      // 让同机多个进程的重试错开节拍、不会同时撞同一个句柄（这里只是调度抖动，不引入随机源）。
      const backoffMs = Math.min(
        RENAME_RETRY_BASE_DELAY_MS * 2 ** Math.min(attempt, 10),
        RENAME_RETRY_MAX_DELAY_MS,
      );
      const jitterMs =
        backoffMs * (((process.pid + attempt * 17) % 100) / 100) * RENAME_RETRY_JITTER_RATIO;
      const delayMs = backoffMs + jitterMs;
      if (!isRetryableRenameError(error) || Date.now() + delayMs > deadlineMs) {
        throw error;
      }
      await sleep(delayMs);
    }
  }
}

export async function withFileLock<T>(
  filePath: string,
  operation: () => Promise<T>,
  options: SharedFileLockOptions = {},
): Promise<T> {
  // 同一进程几十个 caller 同时轮询目录锁会形成惊群，后排请求可能在
  // 很短的实际写入之后仍撞上 8 秒超时。先做进程内 FIFO，每个进程只让队首竞争 OS 锁。
  const previousTail = processFileLockTails.get(filePath) ?? Promise.resolve();
  let releaseProcessQueue!: () => void;
  const currentTail = new Promise<void>((resolve) => {
    releaseProcessQueue = resolve;
  });
  processFileLockTails.set(filePath, currentTail);
  await previousTail;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(filePath), { recursive: true });
    releaseLock = await acquireFileLock(
      filePath,
      options.lockRetryDelaysMs ?? DEFAULT_LOCK_RETRY_DELAYS_MS,
      options.lockOwnerlessGraceMs ?? DEFAULT_LOCK_OWNERLESS_GRACE_MS,
      options.lockMaxWaitMs ?? DEFAULT_LOCK_MAX_WAIT_MS,
    );
    return await operation();
  } finally {
    try {
      await releaseLock?.();
    } finally {
      releaseProcessQueue();
      if (processFileLockTails.get(filePath) === currentTail) {
        processFileLockTails.delete(filePath);
      }
    }
  }
}

export async function atomicWritePrivateTextFile(
  filePath: string,
  content: string,
  renameRetryBudgetMs: number = DEFAULT_RENAME_RETRY_BUDGET_MS,
): Promise<void> {
  const directory = dirname(filePath);
  const tempPath = join(
    directory,
    `.${basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(tempPath, content, { encoding: "utf-8", mode: 0o600 });
    await renameWithRetry(tempPath, filePath, renameRetryBudgetMs);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function backupCorruptFile(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const contentId = createHash("sha256").update(content).digest("hex").slice(0, 24);
  const backupPath = `${filePath}.corrupt-${contentId}.bak`;
  try {
    // 同一损坏凭据会被 Desktop、CLI 和重试循环反复读取。按内容确定备份名并
    // 排他创建，让失败路径稳定收敛到一份证据，同时避免 copyFile 继承历史宽松权限。
    await writeFile(backupPath, content, { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (getErrorCode(error) !== "EEXIST") throw error;
  }
  await chmod(backupPath, 0o600);
  return backupPath;
}
