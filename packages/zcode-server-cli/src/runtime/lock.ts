import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { uptime } from "node:os";
import { dirname } from "node:path";

export type DataRootLockInspection =
  | { state: "missing" }
  | { state: "active"; pid: number }
  | { state: "stale"; pid: number }
  | { state: "invalid" }
  | { state: "unreadable"; error: unknown };

/**
 * 锁记录里除 ownerToken 外的持有者身份证据。缺失表示写入方是旧版本，或当前平台没有对应信息。
 * 这些字段是「pid 已被复用」判定的唯一依据，因此 acquire 必须尽力写全。
 */
interface LockOwnerRecord {
  ownerToken?: string;
  pid?: number;
  acquiredAt?: number;
  /** Linux /proc/sys/kernel/random/boot_id：每次开机唯一，重启后必变。 */
  bootId?: string;
  /** Linux /proc/<pid>/stat 字段 22（starttime）：区分同一 pid 的不同进程代次。 */
  pidStartTime?: string;
}

// 「锁的获取时间早于本次开机」是跨平台可用的充分陈旧判据，但 uptime 只有毫秒级精度
// （Linux /proc/uptime 两位小数、Windows GetTickCount64），留 1 秒余量吸收取整差异；
// 真正跨重启残留的锁至少比开机早数秒以上，余量不会让它漏判。
const BOOT_SKEW_MARGIN_MS = 1_000;

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

let cachedBootId: Promise<string | undefined> | undefined;

/** 进程存活期间 boot_id 不会变，而 acquire/inspect 会反复读取，缓存一次即可。 */
function currentBootId(): Promise<string | undefined> {
  cachedBootId ??= readLinuxBootId();
  return cachedBootId;
}

async function readLinuxBootId(): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const raw = await readFile("/proc/sys/kernel/random/boot_id", "utf8").catch(() => undefined);
  const bootId = raw?.trim();
  return bootId ? bootId : undefined;
}

/**
 * 进程启动时刻（/proc/<pid>/stat 的 starttime）。读不到（非 Linux、进程已退出、权限不足）
 * 返回 undefined，调用方必须降级到其它判据，不能据此下结论。
 */
async function readLinuxPidStartTime(pid: number): Promise<string | undefined> {
  if (process.platform !== "linux") return undefined;
  const stat = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => undefined);
  if (stat === undefined) return undefined;
  // comm（第 2 列）允许包含空格和括号，只能从最后一个 ')' 之后切分；该子串首列是 state（第 3 列），
  // 所以 starttime（第 22 列）落在下标 19。
  const closing = stat.lastIndexOf(")");
  if (closing < 0) return undefined;
  const fields = stat
    .slice(closing + 1)
    .trim()
    .split(/\s+/);
  const startTime = fields[19];
  return startTime && /^\d+$/.test(startTime) ? startTime : undefined;
}

async function createOwnerRecord(ownerToken: string): Promise<string> {
  const bootId = await currentBootId();
  const pidStartTime = await readLinuxPidStartTime(process.pid);
  const record: LockOwnerRecord = { pid: process.pid, acquiredAt: Date.now(), ownerToken };
  if (bootId !== undefined) record.bootId = bootId;
  if (pidStartTime !== undefined) record.pidStartTime = pidStartTime;
  return `${JSON.stringify(record)}\n`;
}

function parseOwnerRecord(parsed: unknown): LockOwnerRecord {
  if (typeof parsed !== "object" || parsed === null) return {};
  const source = parsed as Record<string, unknown>;
  const record: LockOwnerRecord = {};
  if (typeof source.ownerToken === "string") record.ownerToken = source.ownerToken;
  if (typeof source.pid === "number" && Number.isInteger(source.pid) && source.pid > 0)
    record.pid = source.pid;
  if (typeof source.acquiredAt === "number") record.acquiredAt = source.acquiredAt;
  if (typeof source.bootId === "string" && source.bootId.length > 0) record.bootId = source.bootId;
  if (typeof source.pidStartTime === "string" && source.pidStartTime.length > 0)
    record.pidStartTime = source.pidStartTime;
  return record;
}

export class DataRootLock {
  private handle: FileHandle | undefined;
  private ownerToken: string | undefined;
  public constructor(private readonly path: string) {}

  public async inspect(): Promise<DataRootLockInspection> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return { state: "missing" };
      return { state: "unreadable", error };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { state: "invalid" };
    }
    const record = parseOwnerRecord(parsed);
    const pid = record.pid;
    if (pid === undefined) return { state: "invalid" };
    // 与 acquire 共用同一套持有者判据：stop / uninstall / update handoff 的 fail-closed 分支
    // 都读这个结论，只按 pid 存活判断会让重启后被复用的 pid 永远报 active。
    return (await this.isHolderAlive(record)) ? { state: "active", pid } : { state: "stale", pid };
  }

  public async acquire(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    if (await this.tryAcquireOnce()) return;
    const recoveryPath = `${this.path}.recovery`;
    for (let attempt = 0; attempt < 100; attempt++) {
      const observed = await this.readOwner(this.path);
      if (observed && (await this.isHolderAlive(observed.record))) {
        throw new Error("Another ZCode Server instance is already running");
      }
      const recoveryToken = await this.tryAcquireRecoveryGate(recoveryPath);
      if (!recoveryToken) {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        continue;
      }
      try {
        const current = await this.readOwner(this.path);
        if (current && (await this.isHolderAlive(current.record))) {
          throw new Error("Another ZCode Server instance is already running");
        }
        if (current) {
          await this.claimStalePath(this.path, current.raw);
        }
        if (await this.tryAcquireOnce()) return;
      } finally {
        await this.releaseOwnedPath(recoveryPath, recoveryToken);
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Another ZCode Server instance is already running");
  }

  public async release(): Promise<void> {
    await this.handle?.close().catch(() => undefined);
    this.handle = undefined;
    const token = this.ownerToken;
    this.ownerToken = undefined;
    if (token) await this.releaseOwnedPath(this.path, token);
  }

  private async tryAcquireOnce(): Promise<boolean> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(this.path, "wx", 0o600);
      await handle.writeFile(await createOwnerRecord(ownerToken));
      this.handle = handle;
      this.ownerToken = ownerToken;
      return true;
    } catch (error: unknown) {
      if (errorCode(error) === "EEXIST") return false;
      await handle?.close().catch(() => undefined);
      const observed = await this.readOwner(this.path);
      if (observed?.record.ownerToken === ownerToken) {
        await this.releaseOwnedPath(this.path, ownerToken);
      }
      throw error;
    }
  }

  private async readOwner(path: string): Promise<{ raw: string; record: LockOwnerRecord } | null> {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      return null;
    }
    try {
      return { raw, record: parseOwnerRecord(JSON.parse(raw)) };
    } catch {
      return { raw, record: {} };
    }
  }

  /**
   * 判断锁的持有者是否仍然存活。pid 不是身份：主机/VM 重启后 pid 会被无关进程（甚至本进程）
   * 复用，process.kill(pid, 0) 依旧成功，只按 pid 判断会把陈旧锁永久当成 active，服务再也
   * 起不来且不会自愈（只能人工删锁）。所以先用锁内身份证据排除「持有者进程肯定已不存在」，
   * 证据不足时保守判为存活：宁可让人工排查，也不能抢走真正在跑的持有者的锁。
   */
  private async isHolderAlive(record: LockOwnerRecord): Promise<boolean> {
    if (record.pid === undefined) return false;
    if (await this.isHolderReplacedByReusedPid(record)) return false;
    return this.isProcessAlive(record.pid);
  }

  /**
   * 判断锁的持有者是否已被 pid 复用顶替（即持有者进程肯定已经不存在）。精确判据（boot_id、
   * 进程启动时刻）任一成立即下结论；两条都读不到时才用「锁早于本次开机」这条近似判据，
   * 因为系统时钟被向前大幅调整时它会误判，而精确判据在同一开机内一定给出反例。
   */
  private async isHolderReplacedByReusedPid(record: LockOwnerRecord): Promise<boolean> {
    let sameBootConfirmed = false;
    if (record.bootId !== undefined) {
      const bootId = await currentBootId();
      if (bootId !== undefined) {
        if (bootId !== record.bootId) return true;
        sameBootConfirmed = true;
      }
    }
    if (record.pid !== undefined && record.pidStartTime !== undefined) {
      const startTime = await readLinuxPidStartTime(record.pid);
      // 读不到 stat 时不在这里下结论：进程已退出由 isProcessAlive 负责，这里只处理
      // 「pid 存在但不是同一代进程」。反过来，一旦读到且不一致，pid 复用即可确定。
      if (startTime !== undefined) {
        if (startTime !== record.pidStartTime) return true;
        sameBootConfirmed = true;
      }
    }
    if (sameBootConfirmed) return false;
    const acquiredAt = record.acquiredAt;
    if (acquiredAt !== undefined && Number.isFinite(acquiredAt) && acquiredAt > 0) {
      const bootTime = Date.now() - uptime() * 1000;
      if (acquiredAt < bootTime - BOOT_SKEW_MARGIN_MS) return true;
    }
    return false;
  }

  private isProcessAlive(pid: number): boolean {
    if (pid === process.pid) return true;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error: unknown) {
      // ESRCH 表示进程不存在（stale）；EPERM 表示进程存在但无权限，保守视为存活。
      return errorCode(error) === "EPERM";
    }
  }

  private async tryAcquireRecoveryGate(path: string): Promise<string | null> {
    const ownerToken = randomUUID();
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(await createOwnerRecord(ownerToken));
      await handle.close();
      return ownerToken;
    } catch (error: unknown) {
      if (errorCode(error) !== "EEXIST") {
        await handle?.close().catch(() => undefined);
        const observed = await this.readOwner(path);
        if (observed?.record.ownerToken === ownerToken) {
          await this.releaseOwnedPath(path, ownerToken);
        }
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
    }
    const observed = await this.readOwner(path);
    if (!observed || !(await this.isHolderAlive(observed.record))) {
      if (observed) await this.claimStalePath(path, observed.raw);
      return null;
    }
    return null;
  }

  private async claimStalePath(path: string, expectedRaw: string): Promise<void> {
    const quarantine = `${path}.stale-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch (error: unknown) {
      if (errorCode(error) === "ENOENT") return;
      throw error;
    }
    const claimedRaw = await readFile(quarantine, "utf8").catch(() => null);
    if (claimedRaw === expectedRaw) {
      await rm(quarantine, { force: true });
      return;
    }
    // 陈旧观察误 claim 了后来者时必须恢复，不能删除新 owner 的 lock。
    await rename(quarantine, path).catch(() => undefined);
  }

  private async releaseOwnedPath(path: string, ownerToken: string): Promise<void> {
    const observed = await this.readOwner(path);
    if (observed?.record.ownerToken !== ownerToken) return;
    const quarantine = `${path}.release-${process.pid}-${randomUUID()}`;
    try {
      await rename(path, quarantine);
    } catch {
      return;
    }
    const claimed = await this.readOwner(quarantine);
    if (claimed?.record.ownerToken === ownerToken) {
      await rm(quarantine, { force: true });
      return;
    }
    await rename(quarantine, path).catch(() => undefined);
  }
}
