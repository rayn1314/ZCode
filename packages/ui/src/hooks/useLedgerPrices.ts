import { useCallback, useEffect, useRef, useState } from "react";
import type {
  LedgerPriceAlias,
  LedgerPriceEntry,
  LedgerPriceMeta,
  LedgerPriceMutationResult,
} from "@zcode/shared";
import type { IUsageLedgerService } from "@zcode/services";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";

export interface LedgerPricesState {
  entries: LedgerPriceEntry[];
  /** 过滤后的总条数（entries 被服务端 limit 截断）。 */
  total: number;
  aliases: LedgerPriceAlias[];
  meta: LedgerPriceMeta | null;
  loading: boolean;
  error: string | null;
  /** 当前环境没有账本服务（远端 workspace / web），面板显示不可用而不是报错。 */
  unavailable: boolean;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message || error.name || String(error) : String(error);
}

/**
 * 价格管理数据：合并表（带来源层）+ 别名映射，按 query 服务端过滤。
 * 写操作成功后自动重拉列表；快照刷新由调用方负责（费用口径跟着变）。
 */
export function useLedgerPrices(
  query: string,
  enabled: boolean,
): LedgerPricesState & {
  refresh: () => Promise<void>;
  setPrice: (
    modelId: string,
    price: { input: number; output: number; cacheRead: number },
  ) => Promise<LedgerPriceMutationResult>;
  deletePrice: (modelId: string) => Promise<LedgerPriceMutationResult>;
  setAlias: (alias: string, target: string | null) => Promise<LedgerPriceMutationResult>;
} {
  const { usageLedgerService } = useServices();
  const [state, setState] = useState<LedgerPricesState>({
    entries: [],
    total: 0,
    aliases: [],
    meta: null,
    loading: false,
    error: null,
    unavailable: false,
  });
  const versionRef = useRef(0);
  const queryRef = useRef(query);
  queryRef.current = query;

  const fetchInternal = useCallback(async () => {
    if (!usageLedgerService) {
      setState((current) => ({ ...current, loading: false, unavailable: true }));
      return;
    }
    const version = versionRef.current + 1;
    versionRef.current = version;
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const result = await usageLedgerService.listLedgerPrices({
        query: queryRef.current.trim() || null,
      });
      if (versionRef.current !== version) {
        return;
      }
      setState({
        entries: result.entries,
        total: result.total,
        aliases: result.aliases,
        meta: result.meta,
        loading: false,
        error: null,
        unavailable: false,
      });
    } catch (error) {
      if (versionRef.current !== version) {
        return;
      }
      logger.warn("[ledger] price list failed:", getErrorMessage(error));
      setState((current) => ({
        ...current,
        loading: false,
        error: getErrorMessage(error),
        unavailable: false,
      }));
    }
  }, [usageLedgerService]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    void fetchInternal();
  }, [enabled, fetchInternal, query]);

  const runMutation = useCallback(
    async (
      mutate: (service: IUsageLedgerService) => Promise<LedgerPriceMutationResult>,
    ): Promise<LedgerPriceMutationResult> => {
      if (!usageLedgerService) {
        return { ok: false, error: null };
      }
      try {
        const result = await mutate(usageLedgerService);
        if (result.ok) {
          await fetchInternal();
        }
        return result;
      } catch (error) {
        logger.warn("[ledger] price mutation failed:", getErrorMessage(error));
        return { ok: false, error: getErrorMessage(error) };
      }
    },
    [usageLedgerService, fetchInternal],
  );

  const setPrice = useCallback(
    (modelId: string, price: { input: number; output: number; cacheRead: number }) =>
      runMutation((service) => service.setLedgerPrice({ modelId, ...price })),
    [runMutation],
  );

  const deletePrice = useCallback(
    (modelId: string) => runMutation((service) => service.deleteLedgerPrice({ modelId })),
    [runMutation],
  );

  const setAlias = useCallback(
    (alias: string, target: string | null) =>
      runMutation((service) => service.setLedgerPriceAlias({ alias, target })),
    [runMutation],
  );

  return { ...state, refresh: fetchInternal, setPrice, deletePrice, setAlias };
}
