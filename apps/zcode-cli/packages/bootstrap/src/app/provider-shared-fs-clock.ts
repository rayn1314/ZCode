// ============================================================
// 共享文件的「现在」：问文件系统，不问本端时钟
// ============================================================
// 「另一端的记录还新鲜吗」「这把锁还是活的吗」都要做一次减法：阈值 − 目标文件 mtime 的年龄。被减数
// 取本端 `Date.now()` 时，WSL2 内核时钟与 NTFS 时钟的漂移会整段搬进结果：偏到阈值以上，一把**活锁**
// 会被判成僵尸（两端同时进临界区），一个**活进程**的报告会被判过期（份额被抢）。所以「现在」也必须
// 取自同一次挂载：写一个探针文件再读它的 mtime，探针与目标文件出自同一个文件系统时钟，减法与两端
// 时钟差无关。
//
// 探针名带进程内序号：同一毫秒内连判两次不能撞名（撞名会互相 unlink，读到 ENOENT）。

import { stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

let probeSeq = 0;

/**
 * 造一个「文件系统时钟」，返回值读一次就写一次探针文件。探针放在 `directory` 里、固定以 `.probe`
 * 结尾，调用方按扩展名过滤业务文件即可（`.probe` 不会与 `.json` 之类的业务文件混淆）。
 *
 * 探针写不进去（目录只读等）会把错误抛给调用方：判活/判龄这类判断在拿不到同一个时钟时，正确的
 * 做法是**放弃判断**（保守地当作「还活着」），而不是拿本端时钟凑一个答案。
 */
export function createSharedFsClock(options: {
  readonly directory: string;
  /** 探针文件名前缀，用于排障时区分来源。 */
  readonly prefix: string;
}): () => Promise<number> {
  return async () => {
    const probePath = join(
      options.directory,
      `${options.prefix}.${process.pid}.${probeSeq++}.probe`,
    );
    try {
      await writeFile(probePath, "", "utf-8");
      return (await stat(probePath)).mtimeMs;
    } finally {
      await unlink(probePath).catch(() => undefined);
    }
  };
}
