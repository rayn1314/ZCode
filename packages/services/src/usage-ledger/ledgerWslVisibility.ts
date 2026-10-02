import type { LedgerRootRef } from "./ledgerRoots.js";

// WSL 源「暂时不可聚合」的可见性规则：dump 失败退避、发行版停止、探测瞬态失败，
// 三种情况下源都必须保留在 snapshot.sources 里灰显（ok=false + 原因），绝不允许
// 从来源列表里凭空消失——否则用户看到的是 WSL 统计无声丢失，且完全无从排查。

/** dump 失败后的暂停重试窗口。 */
export const WSL_BACKOFF_MS = 60_000;

/** 发行版停止/探测未确认后，已知源保留灰显的时长，超期才从来源列表移除。 */
export const WSL_STALE_KEEP_MS = 30 * 60_000;

export interface WslFailure {
  at: number;
  error: string;
}

export type WslAggregationGate = { aggregate: true } | { aggregate: false; error: string };

const MAX_ERROR_LEN = 200;

function wslRefKey(distro: string | null, rootPath: string): string {
  return `${distro ?? ""}\u0000${rootPath}`;
}

/** 聚合闸门：决定一个 WSL 源本次参与聚合（含失败 catch 路径），还是仅作灰显展示。 */
export function gateWslAggregation(
  root: LedgerRootRef,
  failure: WslFailure | undefined,
  nowMs: number,
): WslAggregationGate {
  if (root.kind !== "wsl") {
    return { aggregate: true };
  }
  if (failure && nowMs - failure.at <= WSL_BACKOFF_MS) {
    return {
      aggregate: false,
      error: `上次聚合失败，暂时跳过重试：${failure.error.slice(0, MAX_ERROR_LEN)}`,
    };
  }
  if (root.staleAt !== undefined && nowMs - root.staleAt < WSL_STALE_KEEP_MS) {
    return {
      aggregate: false,
      error: `WSL 发行版 ${root.distro ?? ""} 未在运行（或最近一次探测未确认）`,
    };
  }
  return { aggregate: true };
}

/**
 * 合并本次探测结果与上次已知源：fresh 优先；本次未再确认到的旧源（发行版停止、
 * probe 瞬态失败）打上 staleAt（最后一次确认时刻）保留，超过保留期才移除。
 */
export function mergeStaleWslRefs(
  previous: LedgerRootRef[],
  fresh: LedgerRootRef[],
  nowMs: number,
): LedgerRootRef[] {
  const freshKeys = new Set(fresh.map((r) => wslRefKey(r.distro, r.rootPath)));
  const kept = previous
    .filter((r) => !freshKeys.has(wslRefKey(r.distro, r.rootPath)))
    .filter((r) => nowMs - (r.staleAt ?? nowMs) < WSL_STALE_KEEP_MS)
    .map((r) => ({ ...r, staleAt: r.staleAt ?? nowMs }));
  return [...fresh, ...kept];
}
