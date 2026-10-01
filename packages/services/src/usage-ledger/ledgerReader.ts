import type { LedgerSnapshot, LedgerSnapshotRequest, LedgerSource } from "@zcode/shared";
import { ledgerSnapshotSchema } from "@zcode/shared";
import { writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { LEDGER_DUMP_SCRIPT_PY, LEDGER_DUMP_SCRIPT_VERSION } from "./ledgerDumpScript.js";
import {
  mergeLedgerPayloads,
  type LabelledLedgerPayload,
  type LedgerSourcePayload,
} from "./ledgerMerge.js";
import { aggregateFromDb } from "./ledgerAggregate.js";
import type { AggregateContext } from "./ledgerAggregateSql.js";
import { loadProviderNames, providerLabel } from "./ledgerProviderNames.js";
import {
  DB_REL_PATH,
  SELF_ROOTS_TTL_MS,
  classifyLedgerRoot,
  detectOfficialRoot as detectOfficialLedgerRoot,
  scanSelfRootCandidates,
  sourceKeyLabel,
  type LedgerReaderOptions,
  type LedgerRootEnv,
  type LedgerRootRef,
} from "./ledgerRoots.js";
import {
  dayStartMsInZone,
  localTzOffsetMinutes,
  resolveLedgerRange,
  todayInZone,
} from "./ledgerRange.js";
import type { LedgerPriceTable } from "./ledgerPrices.js";
import { listRunningWslDistros, probeWslDbRoots, runWslDump } from "./ledgerWsl.js";

// node:sqlite 的引入方式与 tasksDatabase/startup.ts 一致：createRequire 规避构建器
// 把 node:sqlite 改写成不存在的 npm sqlite 包（main 进程 ESM bundle 已踩过）。
const { DatabaseSync } = createRequire(import.meta.url)(
  "node:sqlite",
) as typeof import("node:sqlite");

// 只读不变式：每次请求独立短连接（readOnly + busy_timeout 3s），用完即关，
// 绝不持有长连接——长读事务会阻碍主程序的 WAL checkpoint。详见 spec/usage-ledger.md。
// 本机聚合与 WSL dump 共用同一套 SQL 口径；分桶全部是参数化的整数算术，
// 没有任何动态字符串进入 SQL 文本，所有值走 ? 占位符。
// WSL 进程执行全部隔离在 ledgerWsl.ts（参数列表直通），本文件不直接创建进程。

const WSL_PROBE_TTL_MS = 300_000;
const WSL_BACKOFF_MS = 60_000;
const WSL_DUMP_TIMEOUT_MS = 30_000;
const MAX_TEXT_LEN = 200;

export class LedgerReader {
  private selfRootsCache: { at: number; paths: string[] } | null = null;
  private wslCache: { at: number; refs: LedgerRootRef[] } | null = null;
  private wslFailedAt = new Map<string, number>();
  private providerNamesCache = new Map<string, Map<string, string>>();

  constructor(private readonly options: LedgerReaderOptions) {}

  private get platform(): NodeJS.Platform {
    return this.options.platform ?? process.platform;
  }

  private get homeDir(): string {
    return this.options.homeDir ?? os.homedir();
  }

  private get env(): Record<string, string | undefined> {
    return this.options.env ?? process.env;
  }

  private get now(): () => number {
    return this.options.now ?? Date.now;
  }

  private get rootEnv(): LedgerRootEnv {
    return {
      homeDir: this.homeDir,
      appDataDir: this.options.appDataDir,
      env: this.env,
      now: this.now,
      existsImpl: this.options.existsImpl,
    };
  }

  /** 官方版根目录候选链：ZCODE_HOME → 常见安装位置。全部落空返回 null。 */
  private detectOfficialRoot(): string | null {
    return detectOfficialLedgerRoot(this.rootEnv);
  }

  /** 扫 home 下 .zcode-<身份> 形态、装着库的自建版数据根（TTL 缓存）。 */
  private async detectSelfRoots(): Promise<string[]> {
    const now = this.now();
    if (this.selfRootsCache && now - this.selfRootsCache.at < SELF_ROOTS_TTL_MS) {
      return this.selfRootsCache.paths;
    }
    const paths = await scanSelfRootCandidates(this.rootEnv);
    this.selfRootsCache = { at: now, paths };
    return paths;
  }

  private wslBackoffKey(distro: string, rootPath: string): string {
    return `${distro}\u0000${rootPath}`;
  }

  private async detectWslRoots(): Promise<LedgerRootRef[]> {
    if (this.platform !== "win32") {
      return [];
    }
    const now = this.now();
    const notBackingOff = (refs: LedgerRootRef[]): LedgerRootRef[] =>
      refs.filter(
        (ref) =>
          now - (this.wslFailedAt.get(this.wslBackoffKey(ref.distro ?? "", ref.rootPath)) ?? 0) >
          WSL_BACKOFF_MS,
      );
    if (this.wslCache && now - this.wslCache.at < WSL_PROBE_TTL_MS) {
      return notBackingOff(this.wslCache.refs);
    }
    const refs: LedgerRootRef[] = [];
    for (const distro of await listRunningWslDistros(this.options.spawnImpl)) {
      for (const rootPath of await probeWslDbRoots(distro, this.options.spawnImpl)) {
        const { variant, identity } = classifyLedgerRoot(rootPath);
        const { key, label } = sourceKeyLabel("wsl", distro, variant, identity);
        refs.push({
          rootPath,
          dbPath: `${rootPath}/cli/db/db.sqlite`,
          providerConfigPath: `${rootPath}/v2/provider_config.json`,
          kind: "wsl",
          distro,
          variant,
          identity,
          isPrimary: false,
          key,
          label,
        });
      }
    }
    this.wslCache = { at: now, refs };
    return notBackingOff(refs);
  }

  private markWslFailed(distro: string, rootPath: string): void {
    this.wslFailedAt.set(this.wslBackoffKey(distro, rootPath), this.now());
  }

  /** 全部账本数据根，主源（host 自己的数据根）排在最前。 */
  async detectRoots(): Promise<LedgerRootRef[]> {
    const primaryPath = path.resolve(this.options.dataRootDir);
    const { variant: primaryVariant, identity: primaryIdentity } = classifyLedgerRoot(primaryPath);
    const primaryBase = sourceKeyLabel("windows", null, primaryVariant, primaryIdentity);
    const roots: LedgerRootRef[] = [
      {
        rootPath: primaryPath,
        dbPath: path.join(primaryPath, DB_REL_PATH),
        providerConfigPath: path.join(primaryPath, "v2", "provider_config.json"),
        kind: "windows",
        distro: null,
        variant: primaryVariant,
        identity: primaryIdentity,
        isPrimary: true,
        key: primaryBase.key,
        label: primaryBase.label,
      },
    ];

    const seen = new Set<string>([primaryPath]);
    const official = this.detectOfficialRoot();
    if (official && !seen.has(official)) {
      seen.add(official);
      const { variant, identity } = classifyLedgerRoot(official);
      const { key, label } = sourceKeyLabel("windows", null, variant, identity);
      roots.push({
        rootPath: official,
        dbPath: path.join(official, DB_REL_PATH),
        providerConfigPath: path.join(official, "v2", "provider_config.json"),
        kind: "windows",
        distro: null,
        variant,
        identity,
        isPrimary: false,
        key,
        label,
      });
    }
    for (const selfRoot of await this.detectSelfRoots()) {
      if (seen.has(selfRoot)) {
        continue;
      }
      seen.add(selfRoot);
      const { variant, identity } = classifyLedgerRoot(selfRoot);
      const { key, label } = sourceKeyLabel("windows", null, variant, identity);
      roots.push({
        rootPath: selfRoot,
        dbPath: path.join(selfRoot, DB_REL_PATH),
        providerConfigPath: path.join(selfRoot, "v2", "provider_config.json"),
        kind: "windows",
        distro: null,
        variant,
        identity,
        isPrimary: false,
        key,
        label,
      });
    }
    roots.push(...(await this.detectWslRoots()));

    // dev/test 环境的主源可能也归类为 official，与官方根撞 key：给后来者加序号后缀
    const keyCounts = new Map<string, number>();
    for (const root of roots) {
      const count = keyCounts.get(root.key) ?? 0;
      keyCounts.set(root.key, count + 1);
      if (count > 0) {
        root.key = `${root.key}#${count + 1}`;
      }
    }
    return roots;
  }

  /** 单数据源聚合（本机 SQLite）。结构与 WSL dump 回传完全一致，可多份合并。 */
  aggregateLocal(
    root: LedgerRootRef,
    ctx: AggregateContext,
    names: Map<string, string>,
  ): LedgerSourcePayload {
    const db = new DatabaseSync(root.dbPath, { readOnly: true, timeout: 3000 });
    try {
      return aggregateFromDb(
        {
          queryAll: (sql, args) => db.prepare(sql).all(...args) as Record<string, unknown>[],
          queryOne: (sql, args) =>
            db.prepare(sql).get(...args) as Record<string, unknown> | undefined,
        },
        ctx,
        (pid) => providerLabel(pid, names),
      );
    } finally {
      db.close();
    }
  }

  /** 在 WSL 里跑内嵌 dump 脚本，拿回该数据源的聚合 JSON。 */
  private async aggregateWsl(
    root: LedgerRootRef,
    ctx: AggregateContext,
  ): Promise<LedgerSourcePayload> {
    const { scriptPath, pricesPath } = await this.ensureDumpAssets(ctx.priceTable);
    const payload = (await runWslDump({
      distro: root.distro ?? "",
      scriptWinPath: scriptPath,
      pricesWinPath: pricesPath,
      dbPath: root.dbPath,
      providerConfigPath: root.providerConfigPath,
      fromMs: ctx.fromMs,
      toMs: ctx.toMs,
      tzOffsetMinutes: Math.round(ctx.tzOffsetMs / 60_000),
      providerLabelFilter: ctx.providerLabelFilter,
      modelId: ctx.modelId,
      spawnImpl: this.options.spawnImpl,
      timeoutMs: WSL_DUMP_TIMEOUT_MS,
    })) as LedgerSourcePayload;
    return payload;
  }

  private async ensureDumpAssets(priceTable: LedgerPriceTable): Promise<{
    scriptPath: string;
    pricesPath: string;
  }> {
    const writeFileFn = this.options.writeFileImpl ?? writeFile;
    const dir = os.tmpdir();
    const scriptPath = path.join(dir, `zcode-ledger-dump-v${LEDGER_DUMP_SCRIPT_VERSION}.py`);
    const pricesPath = path.join(dir, "zcode-ledger-prices.json");
    await writeFileFn(scriptPath, LEDGER_DUMP_SCRIPT_PY, "utf8");
    await writeFileFn(
      pricesPath,
      JSON.stringify({
        _meta: priceTable.meta ?? {},
        ...Object.fromEntries(priceTable.prices),
      }),
      "utf8",
    );
    return { scriptPath, pricesPath };
  }

  /** 聚合全部数据源并合并成一份快照。 */
  async getSnapshot(request: LedgerSnapshotRequest): Promise<LedgerSnapshot> {
    const nowMs = this.now();
    const offsetMinutes = localTzOffsetMinutes(nowMs);
    const range = resolveLedgerRange(request, nowMs, offsetMinutes);
    const priceTable = await this.options.priceLoader.load();
    const today = todayInZone(offsetMinutes, nowMs);
    const ctx: AggregateContext = {
      fromMs: range.fromMs,
      toMs: range.toMs ?? nowMs,
      scoped: range.fromMs !== null,
      tzOffsetMs: offsetMinutes * 60_000,
      today0: dayStartMsInZone(offsetMinutes, today),
      month0: dayStartMsInZone(offsetMinutes, { ...today, day: 1 }),
      nowMs,
      providerLabelFilter: request.providerLabel || null,
      modelId: request.modelId || null,
      priceTable,
    };

    const selected = request.sourceKeys?.length ? new Set(request.sourceKeys) : null;
    const roots = await this.detectRoots();
    const parts: LabelledLedgerPayload[] = [];
    const sources: LedgerSource[] = [];

    for (const root of roots) {
      const included = !selected || selected.has(root.key);
      let payload: LedgerSourcePayload | null = null;
      try {
        if (root.kind === "wsl") {
          payload = await this.aggregateWsl(root, ctx);
        } else {
          const names =
            this.providerNamesCache.get(root.providerConfigPath) ??
            (await loadProviderNames(root.providerConfigPath));
          this.providerNamesCache.set(root.providerConfigPath, names);
          payload = this.aggregateLocal(root, ctx, names);
        }
      } catch (error) {
        if (root.kind === "wsl" && root.distro) {
          this.markWslFailed(root.distro, root.rootPath);
        }
        const message = error instanceof Error ? error.message : String(error);
        if (root.isPrimary && included) {
          // 主源是 host 自己的数据根：它读不到就没有可信页面，交给 UI 错误态
          throw new Error(`${message}（${root.dbPath}）`);
        }
        // 其余源属于「额外收益」，失败只标记不可用，不挡整个页面
        sources.push({
          key: root.key,
          label: root.label,
          kind: root.kind,
          variant: root.variant,
          identity: root.identity,
          calls: 0,
          ok: false,
          error: message.slice(0, MAX_TEXT_LEN),
          included: false,
          rootPath: root.rootPath,
        });
        continue;
      }
      if (payload) {
        parts.push({ ...payload, sourceLabel: root.label, sourceKey: root.key });
        sources.push({
          key: root.key,
          label: root.label,
          kind: root.kind,
          variant: root.variant,
          identity: root.identity,
          calls: payload.overview.calls,
          ok: true,
          error: null,
          included,
          rootPath: root.rootPath,
        });
      }
    }

    const merged = mergeLedgerPayloads(
      selected ? parts.filter((p) => selected.has(p.sourceKey)) : parts,
      sources,
      range,
    );
    return ledgerSnapshotSchema.parse({ ...merged, generatedAt: nowMs });
  }
}
