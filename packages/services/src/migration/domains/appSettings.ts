import { isDeepStrictEqual } from "node:util";
import { appSettingsPatchSchema, type AppSettings } from "@zcode/shared";
import type { MigrationDomainResult, MigrationDomainSummary } from "../migration.js";
import {
  capDetails,
  fileSizeOrZero,
  readJsonObjectFile,
  resolveDomainPath,
  type MigrationDomainContext,
  type MigrationDomainOps,
} from "../domainSupport.js";

/**
 * 界面与通用设置。
 *
 * 写入面是显式白名单，不是「除 dataBaseDir 外的全部字段」。三类必须剔除（见 spec）：
 * 1. 引导指针 `dataBaseDir`：它是数据根本身，带过来会把目标身份重定向到源数据根；
 * 2. 迁移哨兵位（`*MigrationInitialized` / `*Migrated` / `settingsSyncFirstRunPromptHandled`）：
 *    含义是「本安装的 schema 迁移已跑过」，跨身份搬会让目标跳过自己的迁移步骤；
 * 3. 机器/工作区状态与账号绑定（recentProjects / lastWorkspaceSession / providerFamily* 等）。
 */
const MIGRATABLE_SETTING_KEYS = [
  "locale",
  "localePreference",
  "shortcutBindings",
  "terminalInheritSystemProfile",
  "terminalFontFamily",
  "integratedTerminalShell",
  "httpProxy",
  "httpProxyNoProxy",
  "httpProxyCaCertPath",
  "embeddedBrowserAllowInsecureCertificates",
  "embeddedBrowserViewportPreference",
  "computerUseComposerEntryHidden",
  "taskAutoArchiveEnabled",
  "taskAutoArchiveOlderThanDays",
  "closeToTrayOnWindows",
  "keepAwakeWhileRunning",
  "desktopZoomLevel",
  "desktopWindowSize",
  "desktopChromiumHardwareAccelerationEnabled",
  "messageStreamShowReasoning",
  "messageStreamShowTodos",
  "toolGroupingExploreEnabled",
  "toolGroupingTerminalEnabled",
  "toolGroupingChangesEnabled",
  "zcodeInteractionBehavior",
  "askUserQuestionAutoResolutionEnabled",
  "modelIoFullRetentionEnabled",
  "nativeSearchEnhancementsEnabled",
  "proactiveSuggestionsEnabled",
  "memoryEnabled",
  // 压缩偏好只表达用户意图，不含机器/工作区状态，跨身份迁移应带上。
  "compactionBufferTokens",
  "compactionMicrocompactEnabled",
  "compactionMicrocompactKeepRecentToolResults",
  "compactionMicrocompactClearErrorResults",
  "compactionPostTurnEnabled",
  "compactionPostTurnThresholdOffsetTokens",
  "compactionModelDownshiftEnabled",
  "receivePreviewUpdates",
  "autoDownloadAndInstallUpdates",
  "zcodeEndpointOrigin",
  "startPlanRecommendationDismissed",
  "onboardingOccupation",
] as const satisfies readonly (keyof AppSettings)[];

const SETTING_JSON_REL = ["v2", "setting.json"] as const;

function sourceSettingPath(ctx: MigrationDomainContext): string {
  return resolveDomainPath(ctx.sourceRootPath, SETTING_JSON_REL);
}

/**
 * 逐键过 `appSettingsPatchSchema`。
 *
 * 不整份 parse：单键非法不能拖垮其它键（spec 要求坏键丢弃并计入 details）。
 * 注意 zcodeEndpointOrigin 这类字段带 preprocess，非法值会被归一化成「键消失」；
 * 因此解析成功但结果里没有该键，同样按坏键处理。
 */
function selectExplicitSettings(source: Record<string, unknown>): {
  patch: Partial<AppSettings>;
  rejected: string[];
} {
  const patch: Partial<AppSettings> = {};
  const rejected: string[] = [];
  // 逐键动态赋值：key 是白名单联合类型，直接索引赋值会被 TS 收敛成 never，统一从 unknown 出口写。
  const writablePatch = patch as Record<string, unknown>;
  for (const key of MIGRATABLE_SETTING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(source, key)) {
      continue;
    }
    const parsed = appSettingsPatchSchema.safeParse({ [key]: source[key] });
    if (!parsed.success || !Object.prototype.hasOwnProperty.call(parsed.data, key)) {
      rejected.push(key);
      continue;
    }
    writablePatch[key] = parsed.data[key];
  }
  return { patch, rejected };
}

async function scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary> {
  const sourcePath = sourceSettingPath(ctx);
  let source: Record<string, unknown> | null;
  try {
    source = await readJsonObjectFile(sourcePath);
  } catch {
    return unavailable("来源 setting.json 损坏，无法读取");
  }
  if (!source) {
    return unavailable();
  }
  const presentKeys = MIGRATABLE_SETTING_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(source, key),
  );
  if (presentKeys.length === 0) {
    return unavailable("来源没有可迁移的偏好设置");
  }
  const { patch } = selectExplicitSettings(source);
  const target = await ctx.deps.settingService.get();
  const conflictCount = Object.entries(patch).filter(
    ([key, value]) => !isDeepStrictEqual(target[key as keyof AppSettings], value),
  ).length;
  return {
    id: "appSettings",
    available: true,
    itemCount: presentKeys.length,
    bytes: await fileSizeOrZero(sourcePath),
    conflictCount,
    defaultSelected: true,
    note: "只搬来源里显式设置过的偏好；账号与工作区状态不迁移",
  };
}

function unavailable(skipReason = "来源没有这项数据"): MigrationDomainSummary {
  return {
    id: "appSettings",
    available: false,
    itemCount: 0,
    bytes: 0,
    conflictCount: 0,
    defaultSelected: true,
    skipReason,
  };
}

async function migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult> {
  const sourcePath = sourceSettingPath(ctx);
  const source = await readJsonObjectFile(sourcePath);
  if (!source) {
    return {
      id: "appSettings",
      status: "skipped",
      imported: 0,
      skipped: 0,
      failed: 0,
      details: ["来源没有这项数据"],
    };
  }
  const { patch, rejected } = selectExplicitSettings(source);
  const target = await ctx.deps.settingService.get();
  const details = rejected.map((key) => `丢弃非法设置项 ${key}`);
  let imported = 0;
  let skipped = 0;
  for (const [key, value] of Object.entries(patch)) {
    if (isDeepStrictEqual(target[key as keyof AppSettings], value)) {
      skipped += 1;
    } else {
      imported += 1;
    }
  }
  // 迁移不涉及账号连接切换，不传 expectedAccountSettings（拒绝语义与普通设置更新一致）。
  if (Object.keys(patch).length > 0) {
    await ctx.deps.settingService.update(patch);
  }
  if (imported === 0 && skipped === 0) {
    details.push("没有可迁移的偏好设置");
  }
  return {
    id: "appSettings",
    status: "done",
    imported,
    skipped,
    failed: 0,
    details: capDetails(details),
  };
}

export const appSettingsDomain: MigrationDomainOps = { scan, migrate };
