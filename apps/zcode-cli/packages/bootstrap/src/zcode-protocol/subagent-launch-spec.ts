// ============================================================
// 子代理启动规格读取（spec D2 / S1a）
// ============================================================
//
// 写侧在 core：子会话首次 spawn、session 行落库之后写一行 `runtime/subagent_launch_spec`
// （见 core `subagent/src/launch-spec.ts`）。读侧在这里，由 `createRecord` 在
// `taskType === "subagent_child"` 时调用，把规格折回子会话的 runtimeConfig。
//
// 为什么必须持久化而不是重推：子会话的工具白名单来自**父 runtime 的实时工具注册表**，
// 冷恢复时 bootstrap 手上没有那个注册表，重推不出来。persona 的 owner 是 profile，
// 因此这里只回填寻址键之外的**冻结事实**，persona 正文不入库。

import {
  SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
  traceContextToLogContext,
  type Logger,
  type SessionId,
  type SessionStorePort,
  type SubagentLaunchSpecEntryData,
  type TraceContext,
} from "@zcode/contracts";

/**
 * 子会话 runtimeConfig 的注入面。
 *
 * `subagents.enabled: false` 是**无条件**的（fail-closed）：它同时是"子代理不得再派生
 * 子代理"的闸门——`createDefaultSubagentPort` 只在 `enabled === false` 时收回 `subagentPort`，
 * 而 `Agent` 工具的注册门读的就是 `Boolean(runtime.subagentPort)`。规格缺失也必须写，
 * 否则冷恢复出的子会话会重新拿到 `Agent` 工具。
 */
export interface SubagentChildRuntimeConfigOverrides {
  subagents: { enabled: false; maxTurns?: number };
  toolset?: "main" | "explore";
  agentName?: string;
  toolAllowlist?: readonly string[];
  toolDisallowlist?: readonly string[];
}

/**
 * 规格 → runtimeConfig 覆盖。
 *
 * 规格缺席（存量子会话、或落盘失败）时**只**给 fail-closed 的套娃闸，不回填任何身份事实：
 * 受限模式由调用方叠加（输入面关闭），不在这里猜一个工具面出来。
 */
export function buildSubagentChildRuntimeConfigOverrides(
  spec: SubagentLaunchSpecEntryData | undefined,
): SubagentChildRuntimeConfigOverrides {
  if (!spec) {
    return { subagents: { enabled: false } };
  }
  return {
    subagents: {
      enabled: false,
      ...(spec.maxTurns === undefined ? {} : { maxTurns: spec.maxTurns }),
    },
    toolset: spec.toolset,
    agentName: spec.agentName,
    toolAllowlist: spec.toolAllowlist,
    ...(spec.toolDisallowlist === undefined ? {} : { toolDisallowlist: spec.toolDisallowlist }),
  };
}

/**
 * 读子会话的启动规格。`undefined` = 没有可用规格，调用方走受限模式。
 *
 * 三种 `undefined` 都要分得清（日志里的 `reason` 用来区分，别把它们混成"没有子代理"）：
 * - 宿主没有持久化能力（`sessionEntries` 缺席）——这种宿主也没有冷恢复；
 * - 该会话没有规格行（存在改造前落库的存量子会话）；
 * - 行存在但结构不可用（缺字段 / toolset 不认识）。
 *
 * 读取抛错时**不吞**：向上抛，让冷恢复明确失败而不是悄悄退化成受限会话。
 */
export async function readSubagentLaunchSpec(input: {
  sessionStore?: SessionStorePort;
  sessionId: SessionId;
  logger?: Logger;
  traceContext?: TraceContext;
}): Promise<SubagentLaunchSpecEntryData | undefined> {
  const sessionEntries = input.sessionStore?.sessionEntries;
  if (!sessionEntries) {
    logMissing(input, "no_session_store");
    return undefined;
  }

  const entries = await sessionEntries({
    sessionID: input.sessionId,
    type: SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
  });
  const entry = entries.find((candidate) => candidate.type === SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC);
  if (!entry) {
    logMissing(input, "no_entry");
    return undefined;
  }

  const spec = parseLaunchSpec(entry.data);
  if (!spec) {
    logMissing(input, "malformed_entry");
    return undefined;
  }
  return spec;
}

/**
 * 结构校验。任何必需字段缺失或不认识 → `undefined`（受限模式），**不补默认值**：
 * 补一个工具面等于替子代理编造身份，比"身份未还原"更坏。
 */
function parseLaunchSpec(value: unknown): SubagentLaunchSpecEntryData | undefined {
  const data = asRecord(value);
  const agentType = nonEmptyString(data.agentType);
  const agentName = nonEmptyString(data.agentName);
  const profileName = nonEmptyString(data.profileName);
  const profileSource = nonEmptyString(data.profileSource);
  const toolset = data.toolset === "main" || data.toolset === "explore" ? data.toolset : undefined;
  const toolAllowlist = stringArray(data.toolAllowlist);
  if (!agentType || !agentName || !profileName || !profileSource || !toolset || !toolAllowlist) {
    return undefined;
  }
  const toolDisallowlist = stringArray(data.toolDisallowlist);
  const maxTurns = typeof data.maxTurns === "number" ? data.maxTurns : undefined;
  return {
    agentType,
    agentName,
    profileName,
    profileSource,
    toolset,
    toolAllowlist,
    ...(toolDisallowlist === undefined ? {} : { toolDisallowlist }),
    ...(maxTurns === undefined ? {} : { maxTurns }),
    background: data.background === true,
  };
}

function logMissing(
  input: { sessionId: SessionId; logger?: Logger; traceContext?: TraceContext },
  reason: "no_session_store" | "no_entry" | "malformed_entry",
): void {
  input.logger?.debug("Subagent launch spec unavailable; child session falls back to limited mode", {
    ...(input.traceContext ? traceContextToLogContext(input.traceContext) : {}),
    event: "subagent_launch_spec.missing",
    module: "bootstrap.subagent_launch_spec",
    reason,
    sessionId: input.sessionId,
  });
}

function stringArray(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return undefined;
    strings.push(item);
  }
  return strings;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
