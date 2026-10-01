import { useCallback, useEffect, useRef, useState } from "react";
import type { LedgerPriceSyncResult, LedgerSnapshot, LedgerSnapshotRequest } from "@zcode/shared";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";

export interface LedgerStatsState {
  snapshot: LedgerSnapshot | null;
  loading: boolean;
  error: string | null;
  /** 当前环境没有账本服务（远端 workspace / web 未注册），显示降级说明而不是报错。 */
  unavailable: boolean;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error);
}

/**
 * 用量账本快照：请求状态 + 竞态防护。请求参数变化（筛选/范围/来源）时自动重拉。
 * 轮询与可见性判断由面板层负责，这里只负责单次拉取语义。
 */
export function useLedgerStats(request: LedgerSnapshotRequest): {
  snapshot: LedgerSnapshot | null;
  loading: boolean;
  error: string | null;
  unavailable: boolean;
  refresh: () => Promise<void>;
  /** 手动同步价格基准；环境不支持时返回 null，由调用方降级提示。 */
  syncPrices: () => Promise<LedgerPriceSyncResult | null>;
} {
  const { usageLedgerService } = useServices();
  const [state, setState] = useState<LedgerStatsState>({
    snapshot: null,
    loading: true,
    error: null,
    unavailable: false,
  });
  const versionRef = useRef(0);
  const requestRef = useRef(request);
  requestRef.current = request;

  const fetchInternal = useCallback(async () => {
    if (!usageLedgerService) {
      setState({ snapshot: null, loading: false, error: null, unavailable: true });
      return;
    }
    const version = versionRef.current + 1;
    versionRef.current = version;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const snapshot = await usageLedgerService.getLedgerSnapshot(requestRef.current);
      if (versionRef.current === version) {
        setState({ snapshot, loading: false, error: null, unavailable: false });
      }
    } catch (error) {
      if (versionRef.current !== version) {
        return;
      }
      logger.warn("[ledger] snapshot failed:", getErrorMessage(error));
      setState((current) => ({
        snapshot: current.snapshot,
        loading: false,
        error: getErrorMessage(error),
        unavailable: false,
      }));
    }
  }, [usageLedgerService]);

  const requestKey = JSON.stringify(request);
  useEffect(() => {
    void fetchInternal();
  }, [fetchInternal, requestKey]);

  const syncPrices = useCallback(async (): Promise<LedgerPriceSyncResult | null> => {
    if (!usageLedgerService) {
      return null;
    }
    try {
      return await usageLedgerService.syncLedgerPrices();
    } catch (error) {
      logger.warn("[ledger] price sync failed:", getErrorMessage(error));
      return { ok: false, error: getErrorMessage(error) };
    }
  }, [usageLedgerService]);

  return {
    snapshot: state.snapshot,
    loading: state.loading,
    error: state.error,
    unavailable: state.unavailable,
    refresh: fetchInternal,
    syncPrices,
  };
}
