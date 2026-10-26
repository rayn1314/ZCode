import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir, uptime } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DataRootLock } from "../src/runtime/lock.js";

// 超出常见平台 pid 上限的值：process.kill(pid, 0) 必然 ESRCH，模拟已死的持锁进程。
const DEAD_PID = 2 ** 30;

describe("DataRootLock", () => {
  it("recovers a stale lock left behind by a dead process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-stale-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it("recovers a corrupted lock file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-corrupt-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, "not-json", "utf8");

    const lock = new DataRootLock(lockFile);
    await lock.acquire();
    await lock.release();
  });

  it("refuses to steal the lock from a live process", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-live-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(
      lockFile,
      `${JSON.stringify({ pid: process.pid, acquiredAt: Date.now() })}\n`,
      "utf8",
    );

    const lock = new DataRootLock(lockFile);
    await expect(lock.acquire()).rejects.toThrow(/already running/);
  });

  it("reclaims a lock whose pid was reused by an unrelated live process", async () => {
    // 现场故障：主机/VM 重启后 pid 被无关进程占用，而锁文件只在正常退出时清理。只按 pid 探测存活
    // 会把陈旧锁永久判成 active，服务再也起不来且不会自愈。锁早于本次开机即证明持有者进程已不存在。
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-pid-reuse-"));
    const lockFile = join(root, "run", "server.lock");
    await mkdir(join(root, "run"), { recursive: true });
    // 测试运行器的父进程：真实存活、与测试进程无关，也不会是锁记录指向的持有者。
    const reusedPid = process.ppid;
    expect(() => process.kill(reusedPid, 0)).not.toThrow();
    await writeFile(
      lockFile,
      `${JSON.stringify({
        pid: reusedPid,
        acquiredAt: Date.now() - uptime() * 1000 - 60_000,
        ownerToken: "previous-boot",
      })}\n`,
      "utf8",
    );

    const lock = new DataRootLock(lockFile);
    await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: reusedPid });
    await lock.acquire();
    expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ pid: process.pid });
    await lock.release();
  });

  it.skipIf(process.platform !== "linux")(
    "reclaims a lock from an earlier boot while its pid is still alive",
    async () => {
      // boot_id 每次开机唯一：锁内记录值与当前不同，即可确定持锁进程属于上一次开机。
      const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const root = await mkdtemp(join(tmpdir(), "zcode-lock-previous-boot-"));
      const lockFile = join(root, "run", "server.lock");
      await mkdir(join(root, "run"), { recursive: true });
      const reusedPid = process.ppid;
      expect(() => process.kill(reusedPid, 0)).not.toThrow();
      await writeFile(
        lockFile,
        `${JSON.stringify({
          pid: reusedPid,
          acquiredAt: Date.now(),
          bootId: `${bootId}-previous-boot`,
          ownerToken: "previous-boot",
        })}\n`,
        "utf8",
      );

      const lock = new DataRootLock(lockFile);
      await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: reusedPid });
      await lock.acquire();
      // 新记录必须带上当前 boot_id，否则下一次重启后这条判据就失效了。
      expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({ bootId });
      await lock.release();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "reclaims a lock whose pid was recycled inside the same boot and records the holder start time",
    async () => {
      // 同一次开机内 pid 也会被回收：boot_id 相同，但 /proc/<pid>/stat 的 starttime 已属于另一代进程。
      const bootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const root = await mkdtemp(join(tmpdir(), "zcode-lock-recycled-pid-"));
      const lockFile = join(root, "run", "server.lock");
      await mkdir(join(root, "run"), { recursive: true });
      const reusedPid = process.ppid;
      expect(() => process.kill(reusedPid, 0)).not.toThrow();
      await writeFile(
        lockFile,
        `${JSON.stringify({
          pid: reusedPid,
          acquiredAt: Date.now(),
          bootId,
          pidStartTime: "1",
          ownerToken: "recycled-pid",
        })}\n`,
        "utf8",
      );

      const lock = new DataRootLock(lockFile);
      await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: reusedPid });
      await lock.acquire();
      // 记录的是持有进程的启动 tick（/proc/<pid>/stat 第 22 列）。取错列不会报错、只会静默失去
      // 判据，因此用 tick/秒 的比值（即 Linux 的 USER_HZ）反向校验取的是启动时刻。
      const holder = JSON.parse(await readFile(lockFile, "utf8")) as { pidStartTime?: string };
      const ticksPerSecond = Number(holder.pidStartTime) / (uptime() - process.uptime());
      expect(ticksPerSecond).toBeGreaterThan(50);
      expect(ticksPerSecond).toBeLessThan(500);
      await lock.release();
    },
  );

  it.skipIf(process.platform !== "linux")(
    "keeps the lock active when identity evidence proves the same boot despite a skewed acquiredAt",
    async () => {
      // acquiredAt 只是近似判据（时钟被向前大幅调整时会误判）。boot_id / starttime 已证明是同一代
      // 进程时不得据此抢锁，否则活着的持有者会被第二个实例顶掉，两个 Core 同时写同一个 data root。
      const root = await mkdtemp(join(tmpdir(), "zcode-lock-skewed-clock-"));
      const lockFile = join(root, "run", "server.lock");
      await mkdir(join(root, "run"), { recursive: true });
      const holder = new DataRootLock(lockFile);
      await holder.acquire();
      const record = JSON.parse(await readFile(lockFile, "utf8")) as Record<string, unknown>;
      await writeFile(
        lockFile,
        `${JSON.stringify({ ...record, acquiredAt: Date.now() - 10 * 60 * 60 * 1_000 })}\n`,
        "utf8",
      );

      const other = new DataRootLock(lockFile);
      await expect(other.inspect()).resolves.toMatchObject({ state: "active", pid: process.pid });
      await expect(other.acquire()).rejects.toThrow(/already running/);
      await holder.release();
    },
  );

  it("reports missing, stale, active and malformed lock owners without mutating the file", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-inspect-"));
    const lockFile = join(root, "run", "server.lock");
    const lock = new DataRootLock(lockFile);

    await expect(lock.inspect()).resolves.toMatchObject({ state: "missing" });
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID })}\n`, "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "stale", pid: DEAD_PID });
    await writeFile(lockFile, `${JSON.stringify({ pid: process.pid })}\n`, "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "active", pid: process.pid });
    await writeFile(lockFile, "not-json", "utf8");
    await expect(lock.inspect()).resolves.toMatchObject({ state: "invalid" });
    await expect(readFile(lockFile, "utf8")).resolves.toBe("not-json");
  });

  it("keeps locks under different data roots isolated (R2-CLI-13)", async () => {
    const rootA = await mkdtemp(join(tmpdir(), "zcode-r2-lock-a-"));
    const rootB = await mkdtemp(join(tmpdir(), "zcode-r2-lock-b-"));
    const lockA = new DataRootLock(join(rootA, "run", "server.lock"));
    const lockB = new DataRootLock(join(rootB, "run", "server.lock"));
    await lockA.acquire();
    await lockB.acquire();
    await lockA.release();
    await lockB.release();
    // 释放后可重新获取。
    await lockA.acquire();
    await lockA.release();
  });

  it.skipIf(process.platform === "win32")(
    "does not delete a replacement lock owned by another token during release",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zcode-r2-lock-owner-"));
      const lockFile = join(root, "run", "server.lock");
      const replacement = join(root, "run", "replacement.lock");
      const lock = new DataRootLock(lockFile);
      await lock.acquire();
      await writeFile(
        replacement,
        `${JSON.stringify({
          pid: process.pid,
          acquiredAt: Date.now(),
          ownerToken: "replacement-owner",
        })}\n`,
        "utf8",
      );
      await rename(replacement, lockFile);

      await lock.release();

      expect(JSON.parse(await readFile(lockFile, "utf8"))).toMatchObject({
        ownerToken: "replacement-owner",
      });
    },
  );

  it("allows only one real process to claim the same stale lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "zcode-lock-race-"));
    const lockFile = join(root, "server.lock");
    const barrierFile = join(root, "go");
    const resultsFile = join(root, "results");
    const readyDir = join(root, "ready");
    await mkdir(readyDir);
    await writeFile(lockFile, `${JSON.stringify({ pid: DEAD_PID, acquiredAt: 0 })}\n`, "utf8");
    // 根目录 Vitest 与 package 脚本的 cwd 不同，不能用 cwd 推导源码路径，否则子进程会导入不存在的 root/src/runtime/lock.ts。
    const moduleUrl = new URL("../src/runtime/lock.ts", import.meta.url).href;
    const childProgram = `
      import { access, appendFile, readFile, writeFile } from "node:fs/promises";
      import { setTimeout as delay } from "node:timers/promises";
      const { DataRootLock } = await import(process.env.ZCODE_TEST_LOCK_MODULE);
      const results = process.env.ZCODE_TEST_LOCK_RESULTS;
      const losers = Number(process.env.ZCODE_TEST_LOCK_LOSERS);
      const countLocked = async () => {
        const raw = await readFile(results, "utf8").catch(() => "");
        return raw.split("\\n").filter((line) => line.startsWith("locked ")).length;
      };
      await writeFile(process.env.ZCODE_TEST_LOCK_READY, "ready\\n");
      while (true) { try { await access(process.env.ZCODE_TEST_LOCK_BARRIER); break; } catch { await delay(5); } }
      const lock = new DataRootLock(process.env.ZCODE_TEST_LOCK_FILE);
      try {
        await lock.acquire();
        await appendFile(results, "success " + process.env.ZCODE_TEST_LOCK_CHILD + "\\n");
        // owner 必须持锁到所有竞争者都放弃为止：固定时长会在机器负载高时先于对方的重试
        // 窗口结束，让慢的竞争者在释放后再次 acquire 成功，出现多个 success 的假失败。
        const holdDeadline = Date.now() + 20_000;
        while (Date.now() < holdDeadline && (await countLocked()) < losers) await delay(10);
        await lock.release();
      } catch {
        await appendFile(results, "locked " + process.env.ZCODE_TEST_LOCK_CHILD + "\\n");
      }
    `;
    const childCount = 8;
    const children = Array.from(
      { length: childCount },
      (_, index) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ["--import", "tsx", "--input-type=module", "--eval", childProgram],
            {
              env: {
                ...process.env,
                ZCODE_TEST_LOCK_MODULE: moduleUrl,
                ZCODE_TEST_LOCK_BARRIER: barrierFile,
                ZCODE_TEST_LOCK_FILE: lockFile,
                ZCODE_TEST_LOCK_READY: join(readyDir, String(index)),
                ZCODE_TEST_LOCK_RESULTS: resultsFile,
                ZCODE_TEST_LOCK_LOSERS: String(childCount - 1),
                ZCODE_TEST_LOCK_CHILD: String(index),
              },
              stdio: ["ignore", "ignore", "pipe"],
            },
          );
          let childError = "";
          child.stderr.on("data", (chunk) => {
            childError += String(chunk);
          });
          child.once("error", reject);
          child.once("exit", (code) =>
            code === 0 ? resolve() : reject(new Error(childError || `lock child exited ${code}`)),
          );
        }),
    );
    // 先等待所有子进程进入 barrier；只按固定时间放行会让慢启动的子进程在首个 owner
    // 释放后再次成功获取锁，导致“一个 success”断言随机出现多个 success。
    const readyDeadline = Date.now() + 20_000;
    let allChildrenReady = false;
    while (Date.now() < readyDeadline) {
      if ((await readdir(readyDir)).length === children.length) {
        allChildrenReady = true;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    await writeFile(barrierFile, "go", "utf8");
    await Promise.all(children);
    const results = (await readFile(resultsFile, "utf8")).trim().split("\n");
    expect(allChildrenReady).toBe(true);
    expect(results.filter((result) => result.startsWith("success "))).toHaveLength(1);
    expect(results.filter((result) => result.startsWith("locked "))).toHaveLength(childCount - 1);
  }, 30_000);
});
