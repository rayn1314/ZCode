import path from "node:path";
import { discoverMigrationSourceRoots } from "../data-roots/machineDataRoots.js";
import {
  capDetails,
  errorMessage,
  type MigrationDomainContext,
  type MigrationDomainOps,
  type MigrationServiceDeps,
} from "./domainSupport.js";
import type {
  IMigrationService,
  MigrationDomainId,
  MigrationDomainSummary,
  MigrationScanResult,
  MigrationSourceRoot,
} from "./migration.js";
import { appSettingsDomain } from "./domains/appSettings.js";
import { providerConfigDomain } from "./domains/providerConfig.js";
import { credentialsDomain } from "./domains/credentials.js";
import { sessionsDomain } from "./domains/sessions.js";
import { workflowsDomain } from "./domains/workflows.js";
import { hookDeclarationsDomain } from "./domains/hookDeclarations.js";

// 域顺序 = UI 展示与串行迁移顺序（在 UI 消费的 scanSource.domains 数组里保持稳定）。
const DOMAIN_OPS: Record<MigrationDomainId, MigrationDomainOps> = {
  appSettings: appSettingsDomain,
  providerConfig: providerConfigDomain,
  credentials: credentialsDomain,
  sessions: sessionsDomain,
  workflows: workflowsDomain,
  hookDeclarations: hookDeclarationsDomain,
};

const DOMAIN_IDS = Object.keys(DOMAIN_OPS) as MigrationDomainId[];

const DEFAULT_SELECTED: Record<MigrationDomainId, boolean> = {
  appSettings: true,
  providerConfig: true,
  credentials: false,
  sessions: false,
  workflows: true,
  hookDeclarations: true,
};

/**
 * 本产品不提供迁移的内容。界面用「不迁移的内容」折叠说明，而不是灰掉的勾选项——
 * 灰选项会暗示「以后会有」，这里多数是刻意不提供。
 */
const NOT_MIGRATABLE = [
  {
    id: "hookTrust",
    label: "hook 信任记录",
    reason: "权限边界，必须由用户在目标身份重新审核授权（fail-closed）",
  },
  {
    id: "sharedAssets",
    label: "skills / commands / plugins / AGENTS.md",
    reason: "两个身份共享同一份 home 资产目录，无需也无法迁移",
  },
  {
    id: "artifacts",
    label: "computer-use / server / agents 制品",
    reason: "可重新安装或下载；跨身份搬会覆盖目标安装的版本",
  },
  {
    id: "diagnostics",
    label: "日志 / 轨迹 / 崩溃 dump / mailbox",
    reason: "诊断与临时数据，搬过去只放大噪声",
  },
];

function normalizeComparablePath(input: string): string {
  const normalized = path.resolve(input).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

/**
 * 来源身份不可见性：`sourceRootPath` 必须落在探测结果集合内。
 * 只接受字符串不足以防「调用方自己拼一个路径」，因此这里重新探测并做集合成员校验。
 */
async function resolveDiscoveredSource(
  deps: MigrationServiceDeps,
  sourceRootPath: string,
): Promise<MigrationSourceRoot> {
  const sources = await discoverSources(deps);
  const wanted = normalizeComparablePath(sourceRootPath);
  const match = sources.find((source) => normalizeComparablePath(source.rootPath) === wanted);
  if (!match) {
    throw new Error(`来源数据根不在本机探测结果内：${sourceRootPath}`);
  }
  return match;
}

async function discoverSources(deps: MigrationServiceDeps): Promise<MigrationSourceRoot[]> {
  return discoverMigrationSourceRoots({
    homeDir: deps.homeDir,
    env: deps.env,
    appDataDir: deps.appDataDir,
    currentDataRootPath: deps.dataRootDir,
    existsImpl: deps.existsImpl,
  });
}

function buildContext(deps: MigrationServiceDeps, sourceRootPath: string): MigrationDomainContext {
  return { sourceRootPath, targetRootPath: deps.dataRootDir, deps };
}

export function createMigrationService(deps: MigrationServiceDeps): IMigrationService {
  return {
    discoverSources: () => discoverSources(deps),

    async scanSource(request): Promise<MigrationScanResult> {
      const source = await resolveDiscoveredSource(deps, request.sourceRootPath);
      const ctx = buildContext(deps, source.rootPath);
      const domains: MigrationDomainSummary[] = [];
      for (const id of DOMAIN_IDS) {
        try {
          domains.push(await DOMAIN_OPS[id].scan(ctx));
        } catch (error) {
          // 单个域的扫描失败不拖垮整份结果：标记不可用并给出原因，UI 仍能展示其它域。
          domains.push({
            id,
            available: false,
            itemCount: 0,
            bytes: 0,
            conflictCount: 0,
            defaultSelected: DEFAULT_SELECTED[id],
            skipReason: `扫描失败：${errorMessage(error)}`,
          });
        }
      }
      return { source, domains, notMigratable: NOT_MIGRATABLE };
    },

    async migrateDomain(request) {
      const source = await resolveDiscoveredSource(deps, request.sourceRootPath);
      const ops = DOMAIN_OPS[request.domain];
      if (!ops) {
        throw new Error(`未知迁移域：${String(request.domain)}`);
      }
      try {
        const result = await ops.migrate(buildContext(deps, source.rootPath));
        return { ...result, details: capDetails(result.details) };
      } catch (error) {
        // 单域失败不影响其它域：返回 failed + 错误摘要，调用方继续下一个域。
        return {
          id: request.domain,
          status: "failed",
          imported: 0,
          skipped: 0,
          failed: 1,
          details: [],
          error: errorMessage(error),
        };
      }
    },
  };
}
