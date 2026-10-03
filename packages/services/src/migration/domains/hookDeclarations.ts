import { atomicWriteText } from "../../fs/atomicFileUtils.js";
import type { MigrationDomainResult, MigrationDomainSummary } from "../migration.js";
import {
  capDetails,
  errorMessage,
  fileSizeOrZero,
  isRecord,
  readJsonObjectFile,
  resolveDomainPath,
  type MigrationDomainContext,
  type MigrationDomainOps,
} from "../domainSupport.js";

/**
 * hooks 声明。
 *
 * 不引入 CLI workspace（`apps/zcode-cli/packages/contracts`）依赖：那是独立 pnpm workspace，
 * services 不能跨 workspace 引它的源码。这里按结构校验最小子集——事件名固定枚举，每个事件下是
 * `{ matcher?, hooks: [...] }` 的数组；未知/损坏条目跳过并计入 details，不因单条坏数据整域失败。
 *
 * 合并键 = 事件名 + matcher。只搬声明（events），不搬 `enabled` / `timeoutMs` 这类本地运行时旋钮，
 * 也不搬信任记录：目标身份首次触发这些 hook 时仍按 fail-closed 流程重新授权。
 */
const CONFIG_JSON_REL = ["cli", "config.json"] as const;
const HOOK_EVENT_NAMES = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
  "Stop",
] as const;
type HookEventName = (typeof HOOK_EVENT_NAMES)[number];

const HOOK_EVENT_NAME_SET = new Set<string>(HOOK_EVENT_NAMES);

interface SourceMatcher {
  event: HookEventName;
  matcher: string | undefined;
  /** 原始 matcher 条目（含 hooks 数组与任何未来字段），合并时原样保留。 */
  raw: Record<string, unknown>;
}

function matcherKey(event: string, matcher: string | undefined): string {
  return `${event}\u0000${matcher ?? ""}`;
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** 从 config.json 顶层对象里取 hooks.events；结构不合法按「没有声明」处理。 */
function readHooksEvents(config: Record<string, unknown>): Record<string, unknown> | null {
  const hooks = config.hooks;
  if (!isRecord(hooks)) return null;
  const events = hooks.events;
  return isRecord(events) ? events : null;
}

function collectSourceMatchers(events: Record<string, unknown> | null): {
  matchers: SourceMatcher[];
  invalid: string[];
} {
  const matchers: SourceMatcher[] = [];
  const invalid: string[] = [];
  if (!events) return { matchers, invalid };
  for (const [eventName, value] of Object.entries(events)) {
    if (!HOOK_EVENT_NAME_SET.has(eventName)) {
      invalid.push(`未知 hook 事件 ${eventName}，跳过`);
      continue;
    }
    if (!isRecordArray(value)) {
      invalid.push(`事件 ${eventName} 的声明不是数组，跳过`);
      continue;
    }
    for (const entry of value) {
      if (!isRecord(entry) || !isRecordArray(entry.hooks) || entry.hooks.length === 0) {
        invalid.push(`事件 ${eventName} 存在不完整声明，跳过`);
        continue;
      }
      const matcher = entry.matcher;
      if (matcher !== undefined && typeof matcher !== "string") {
        invalid.push(`事件 ${eventName} 的 matcher 不是字符串，跳过`);
        continue;
      }
      matchers.push({ event: eventName as HookEventName, matcher, raw: entry });
    }
  }
  return { matchers, invalid };
}

async function loadSourceMatchers(ctx: MigrationDomainContext): Promise<{
  matchers: SourceMatcher[];
  invalid: string[];
  configPath: string;
}> {
  const configPath = resolveDomainPath(ctx.sourceRootPath, CONFIG_JSON_REL);
  const config = await readJsonObjectFile(configPath);
  if (!config) return { matchers: [], invalid: [], configPath };
  return { ...collectSourceMatchers(readHooksEvents(config)), configPath };
}

async function loadTargetConfig(ctx: MigrationDomainContext): Promise<{
  config: Record<string, unknown>;
  existingKeys: Set<string>;
  configPath: string;
}> {
  const configPath = resolveDomainPath(ctx.targetRootPath, CONFIG_JSON_REL);
  const config = (await readJsonObjectFile(configPath)) ?? {};
  const events = readHooksEvents(config);
  const existingKeys = new Set<string>();
  if (events) {
    for (const [eventName, value] of Object.entries(events)) {
      if (!HOOK_EVENT_NAME_SET.has(eventName) || !isRecordArray(value)) continue;
      for (const entry of value) {
        if (!isRecord(entry)) continue;
        const matcher = typeof entry.matcher === "string" ? entry.matcher : undefined;
        existingKeys.add(matcherKey(eventName, matcher));
      }
    }
  }
  return { config, existingKeys, configPath };
}

async function scan(ctx: MigrationDomainContext): Promise<MigrationDomainSummary> {
  let loaded;
  try {
    loaded = await loadSourceMatchers(ctx);
  } catch {
    return {
      id: "hookDeclarations",
      available: false,
      itemCount: 0,
      bytes: 0,
      conflictCount: 0,
      defaultSelected: true,
      skipReason: "来源 cli/config.json 损坏，无法读取",
    };
  }
  const target = await loadTargetConfig(ctx);
  const conflictCount = loaded.matchers.filter((matcher) =>
    target.existingKeys.has(matcherKey(matcher.event, matcher.matcher)),
  ).length;
  return {
    id: "hookDeclarations",
    available: loaded.matchers.length > 0,
    itemCount: loaded.matchers.length,
    bytes: await fileSizeOrZero(loaded.configPath),
    conflictCount,
    defaultSelected: true,
    skipReason: loaded.matchers.length > 0 ? undefined : "来源没有这项数据",
    note: "只搬声明，不搬 hook 信任记录；目标身份首次触发时需重新授权",
  };
}

async function migrate(ctx: MigrationDomainContext): Promise<MigrationDomainResult> {
  const { matchers, invalid } = await loadSourceMatchers(ctx);
  if (matchers.length === 0) {
    return {
      id: "hookDeclarations",
      status: "skipped",
      imported: 0,
      skipped: 0,
      failed: 0,
      details: capDetails(invalid.length > 0 ? invalid : ["来源没有这项数据"]),
    };
  }
  const target = await loadTargetConfig(ctx);
  const details = [...invalid];
  const mergedEvents: Record<string, unknown[]> = {};
  // 先保留目标已有事件（含未知事件名与未知字段），再追加来源里缺失的 matcher。
  const targetEvents = readHooksEvents(target.config);
  if (targetEvents) {
    for (const [eventName, value] of Object.entries(targetEvents)) {
      if (isRecordArray(value)) mergedEvents[eventName] = [...value];
    }
  }

  let imported = 0;
  let skipped = 0;
  for (const matcher of matchers) {
    if (target.existingKeys.has(matcherKey(matcher.event, matcher.matcher))) {
      skipped += 1;
      continue;
    }
    (mergedEvents[matcher.event] ??= []).push(matcher.raw);
    imported += 1;
  }

  if (imported === 0) {
    details.push(`${skipped} 项已存在，全部跳过`);
    return {
      id: "hookDeclarations",
      status: "done",
      imported: 0,
      skipped,
      failed: 0,
      details: capDetails(details),
    };
  }

  // 写回必须保留目标文件的其它字段（plugins / skills 开关等）：先读目标 → 改 hooks → 原子写回。
  const nextConfig: Record<string, unknown> = {
    ...target.config,
    hooks: { ...(isRecord(target.config.hooks) ? target.config.hooks : {}), events: mergedEvents },
  };
  try {
    await atomicWriteText(target.configPath, `${JSON.stringify(nextConfig, null, 2)}\n`);
  } catch (error) {
    return {
      id: "hookDeclarations",
      status: "failed",
      imported: 0,
      skipped,
      failed: 1,
      details: capDetails(details),
      error: errorMessage(error),
    };
  }
  return {
    id: "hookDeclarations",
    status: "done",
    imported,
    skipped,
    failed: 0,
    details: capDetails(details),
  };
}

export const hookDeclarationsDomain: MigrationDomainOps = { scan, migrate };
