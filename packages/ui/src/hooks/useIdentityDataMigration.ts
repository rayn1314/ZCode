import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MigrationDomainId,
  MigrationDomainResult,
  MigrationDomainSummary,
  MigrationScanResult,
  MigrationSourceRoot,
} from "@zcode/services";
import { logger } from "@/logger.js";
import { useServices } from "@/hooks/useServices.js";

/**
 * 身份数据迁移（另一个 ZCode 数据根 → 当前身份）的界面状态机。
 *
 * 服务端在每个域上都是独立事务，且 RPC 不序列化函数参数（没有进度回调），
 * 所以「第 k/n 步」由 UI 逐域串行 await 得到：每完成一域立刻把该域标记为已完成/失败，
 * 单域失败只记状态，不中断后续域。
 */
export type IdentityMigrationPhase = "idle" | "scanning" | "ready" | "running" | "done" | "error";

/** 单域在本次运行中的展示状态；"skipped" 是服务端的整域跳过结果，视觉上等同已完成。 */
export type IdentityMigrationDomainStatus = "pending" | "running" | "done" | "failed";

export interface IdentityDataMigrationState {
  /** 当前环境是否注册了迁移服务；false 时面板只显示降级说明，不报错。 */
  supported: boolean;
  phase: IdentityMigrationPhase;
  sources: MigrationSourceRoot[];
  selectedSourceRootPath: string | null;
  scanResult: MigrationScanResult | null;
  /** 扫描或来源探测失败的原因；来源为空不是错误。 */
  error: string | null;
  selectedDomainIds: MigrationDomainId[];
  domainStatuses: Partial<Record<MigrationDomainId, IdentityMigrationDomainStatus>>;
  results: MigrationDomainResult[];
  selectSource: (sourceRootPath: string) => void;
  toggleDomain: (domainId: MigrationDomainId) => void;
  selectAllDomains: () => void;
  clearDomains: () => void;
  startMigration: () => Promise<void>;
  /** 重新扫描当前来源（域清单可能已变，如用户手工删了目标文件）。 */
  rescan: () => void;
  /** 重新探测来源根（如用户刚在另一个身份里装了数据）。 */
  rediscover: () => void;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name || String(error);
  }
  return String(error);
}

function createInitialDomainStatuses(
  domains: ReadonlyArray<Pick<MigrationDomainSummary, "id">>,
): Partial<Record<MigrationDomainId, IdentityMigrationDomainStatus>> {
  const statuses: Partial<Record<MigrationDomainId, IdentityMigrationDomainStatus>> = {};
  for (const domain of domains) {
    statuses[domain.id] = "pending";
  }
  return statuses;
}

export function useIdentityDataMigration(): IdentityDataMigrationState {
  const { migrationService } = useServices();
  const [phase, setPhase] = useState<IdentityMigrationPhase>("idle");
  const [sources, setSources] = useState<MigrationSourceRoot[]>([]);
  const [selectedSourceRootPath, setSelectedSourceRootPath] = useState<string | null>(null);
  const [scanResult, setScanResult] = useState<MigrationScanResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedDomainIds, setSelectedDomainIds] = useState<MigrationDomainId[]>([]);
  const [domainStatuses, setDomainStatuses] = useState<
    Partial<Record<MigrationDomainId, IdentityMigrationDomainStatus>>
  >({});
  const [results, setResults] = useState<MigrationDomainResult[]>([]);

  const mountedRef = useRef(true);
  // 竞态防护：每次探测/扫描/迁移自增一次，旧请求返回时 token 已过期就直接丢弃。
  const operationTokenRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const beginOperation = useCallback(() => {
    operationTokenRef.current += 1;
    return operationTokenRef.current;
  }, []);

  const isOperationCurrent = useCallback(
    (token: number) => mountedRef.current && operationTokenRef.current === token,
    [],
  );

  const applyScanResult = useCallback((result: MigrationScanResult) => {
    setScanResult(result);
    setSelectedDomainIds(
      result.domains
        .filter((domain) => domain.available && domain.defaultSelected)
        .map((domain) => domain.id),
    );
    setDomainStatuses(createInitialDomainStatuses(result.domains));
    setResults([]);
  }, []);

  /** 扫描失败或无来源时清空域清单，避免「开始迁移」按钮带着过期勾选仍可点击。 */
  const clearScanState = useCallback(() => {
    setScanResult(null);
    setSelectedDomainIds([]);
    setDomainStatuses({});
    setResults([]);
  }, []);

  const performScan = useCallback(
    async (sourceRootPath: string, token: number) => {
      if (!migrationService) {
        return;
      }

      try {
        const result = await migrationService.scanSource({ sourceRootPath });
        if (!isOperationCurrent(token)) {
          return;
        }
        applyScanResult(result);
        setPhase("ready");
      } catch (scanError) {
        if (!isOperationCurrent(token)) {
          return;
        }
        logger.error("[IdentityMigration] 扫描来源数据根失败", scanError);
        clearScanState();
        setError(getErrorMessage(scanError));
        setPhase("error");
      }
    },
    [applyScanResult, clearScanState, isOperationCurrent, migrationService],
  );

  const discoverSources = useCallback(async () => {
    if (!migrationService) {
      setPhase("idle");
      return;
    }

    const token = beginOperation();
    setError(null);
    setPhase("scanning");

    try {
      const nextSources = await migrationService.discoverSources();
      if (!isOperationCurrent(token)) {
        return;
      }
      setSources(nextSources);
      // 探测结果按官方根优先排序，默认取第一个；重新探测时也回到默认来源，
      // 避免保留一个已经消失的来源根。
      const nextSourceRootPath = nextSources[0]?.rootPath ?? null;
      setSelectedSourceRootPath(nextSourceRootPath);

      if (!nextSourceRootPath) {
        clearScanState();
        setPhase("ready");
        return;
      }

      await performScan(nextSourceRootPath, token);
    } catch (discoverError) {
      if (!isOperationCurrent(token)) {
        return;
      }
      logger.error("[IdentityMigration] 探测来源数据根失败", discoverError);
      clearScanState();
      setError(getErrorMessage(discoverError));
      setPhase("error");
    }
  }, [beginOperation, clearScanState, isOperationCurrent, migrationService, performScan]);

  useEffect(() => {
    if (!migrationService) {
      return;
    }
    void discoverSources();
  }, [discoverSources, migrationService]);

  const selectSource = useCallback(
    (sourceRootPath: string) => {
      setSelectedSourceRootPath(sourceRootPath);
      setError(null);
      setScanResult(null);
      setPhase("scanning");
      const token = beginOperation();
      void performScan(sourceRootPath, token);
    },
    [beginOperation, performScan],
  );

  const rescan = useCallback(() => {
    if (!selectedSourceRootPath) {
      return;
    }
    selectSource(selectedSourceRootPath);
  }, [selectSource, selectedSourceRootPath]);

  const rediscover = useCallback(() => {
    void discoverSources();
  }, [discoverSources]);

  const toggleDomain = useCallback((domainId: MigrationDomainId) => {
    setSelectedDomainIds((previous) =>
      previous.includes(domainId)
        ? previous.filter((current) => current !== domainId)
        : [...previous, domainId],
    );
  }, []);

  const selectAllDomains = useCallback(() => {
    setSelectedDomainIds(
      (scanResult?.domains ?? []).filter((domain) => domain.available).map((domain) => domain.id),
    );
  }, [scanResult]);

  const clearDomains = useCallback(() => {
    setSelectedDomainIds([]);
  }, []);

  const startMigration = useCallback(async () => {
    if (!migrationService || !selectedSourceRootPath || !scanResult) {
      return;
    }

    const selectedSet = new Set(selectedDomainIds);
    const domainIds = scanResult.domains
      .filter((domain) => domain.available && selectedSet.has(domain.id))
      .map((domain) => domain.id);
    if (domainIds.length === 0) {
      return;
    }

    const token = beginOperation();
    setError(null);
    setResults([]);
    setDomainStatuses(createInitialDomainStatuses(domainIds.map((id) => ({ id }))));
    setPhase("running");

    const collected: MigrationDomainResult[] = [];
    for (const domainId of domainIds) {
      if (!isOperationCurrent(token)) {
        return;
      }
      setDomainStatuses((previous) => ({ ...previous, [domainId]: "running" }));

      let result: MigrationDomainResult;
      try {
        result = await migrationService.migrateDomain({
          sourceRootPath: selectedSourceRootPath,
          domain: domainId,
        });
      } catch (domainError) {
        // 单域失败不中断后续域：把它折成 failed 结果继续循环，与服务端的失败语义一致。
        logger.error(`[IdentityMigration] 域迁移失败 domain=${domainId}`, domainError);
        result = {
          id: domainId,
          status: "failed",
          imported: 0,
          skipped: 0,
          failed: 0,
          details: [],
          error: getErrorMessage(domainError),
        };
      }

      if (!isOperationCurrent(token)) {
        return;
      }
      collected.push(result);
      setResults([...collected]);
      setDomainStatuses((previous) => ({
        ...previous,
        [domainId]: result.status === "failed" ? "failed" : "done",
      }));
    }

    if (!isOperationCurrent(token)) {
      return;
    }
    logger.info(
      `[IdentityMigration] 迁移结束 domains=${domainIds.length} imported=${collected.reduce((sum, item) => sum + item.imported, 0)} skipped=${collected.reduce((sum, item) => sum + item.skipped, 0)} failed=${collected.reduce((sum, item) => sum + item.failed, 0)}`,
    );
    setPhase("done");
  }, [
    isOperationCurrent,
    migrationService,
    scanResult,
    selectedDomainIds,
    selectedSourceRootPath,
    beginOperation,
  ]);

  return {
    supported: Boolean(migrationService),
    phase,
    sources,
    selectedSourceRootPath,
    scanResult,
    error,
    selectedDomainIds,
    domainStatuses,
    results,
    selectSource,
    toggleDomain,
    selectAllDomains,
    clearDomains,
    startMigration,
    rescan,
    rediscover,
  };
}
