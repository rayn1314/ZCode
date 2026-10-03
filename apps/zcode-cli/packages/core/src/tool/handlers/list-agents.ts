// ============================================================
// ListAgents Tool Handler
// ============================================================
// 列出**本会话**派出的子代理及其状态。数据源是 handler 上下文里的 runtimeTaskRegistry——
// 与 TaskOutput 同一条只读路径，不额外落盘、不跨会话。
//
// 阶段 6（spec D8）在其上叠加 `SubagentRosterPort`：注册表只活在本进程，重启/冷恢复后为空；
// roster 从父会话的持久化事件补出历史行。合并规则是「注册表优先」——实时状态与
// isBackgrounded 更准，roster 只补注册表没有的 agentId。每行带 `source` 标注，
// 模型据此知道哪些能 `agent_*` 寻址、哪些只能走 `childSessionId`。

import {
  LIST_AGENTS_TOOL_NAME,
  ListAgentsInputJsonSchema,
  ListAgentsInputSchema,
  ListAgentsOutputJsonSchema,
  ListAgentsOutputSchema,
  type ListAgentsAgent,
  type ListAgentsInput,
  type ListAgentsOutput,
  type ModelMessageContent,
  type SubagentRosterEntry,
} from "@zcode/contracts";
import type { RuntimeTaskSnapshot } from "../../runtime-task/registry.js";
import { escapeXml } from "../../runtime-task/notification.js";
import type { ToolEntry, ToolHandler, ToolHandlerFailure } from "../types.js";
import { formatWorkflowRunTimestamp } from "./workflow-run-introspection.js";

const LIST_AGENTS_TIMEOUT_MS = 10_000;
/** 照 ListWorkflowRuns：单行投影、低基数实体，24k 足够且留余量。 */
const LIST_AGENTS_MODEL_BYTES = 24_000;
/** 与 workflow 内省工具同款：判别键在 message 前缀，码本身不进模型。 */
const LIST_AGENTS_UNAVAILABLE_ERROR_CODE = 1;

const LIST_AGENTS_DESCRIPTION = [
  "Lists the subagents this session has spawned and their current status, so you can track them, audit them, or address one by its agent_id.",
  "",
  "Scope and sources:",
  '- Two sources are merged. `source: "live"` rows come from this process\'s in-memory task registry and carry the real-time status; `source: "history"` rows are projected from the session\'s persisted subagent events and cover subagents this process no longer knows about (for example from before a restart).',
  "- Address by `source`: a `live` row can be addressed with its `agent_id` (the `agent_*` handle accepted by SendMessage), because the in-memory registry still knows it. A `history` row can NOT — the runtime behind it is gone, so address it only by its `child_session_id` (sess_subagent_*) through the cross-session path.",
  "- Direct children of this session only. Subagents cannot spawn subagents, and other sessions' subagents are not visible.",
  '- Without a filter, running and settled subagents are both listed. Pass `status: "running"` to see only what is still in flight (only `live` rows can be running).',
  "",
  "Each row gives the agent_id, the child_session_id, the agent type, the description, the status, whether it was backgrounded, started_at (plus ended_at once settled), and the source.",
  "",
  "- Never conclude a subagent never ran just because it is missing here: history rows only exist when this host keeps durable session events, and the in-process registry is empty after a restart. If the persisted history could not be read, the result is flagged (`history_unavailable`) instead of pretending there is no history.",
  "- Honest status semantics: a history row with no terminal event is reported as `lost`, never `running` — the process that owned it is gone.",
].join("\n");

const listAgentsHandler: ToolHandler = async (input, context) => {
  const parsed = ListAgentsInputSchema.parse(input) as ListAgentsInput;

  const registry = context.runtimeTaskRegistry;
  // 注册门已保证父会话才装上本工具，registry 在这一层缺席是不可达的；仍给业务失败而不是抛错，
  // 与 workflow 内省工具「能力缺席」的语义一致。
  if (!registry) return listAgentsUnavailableFailure();

  // 插入序 = 派发顺序：registry 用 Map 保序，update 不改变已有键的位置。
  const live = collectLocalAgents(registry.all()).map(projectListedAgent);

  const roster = context.subagentRosterPort;
  let history: ListAgentsAgent[] = [];
  let historyUnavailable = false;
  if (roster) {
    try {
      // 只读父会话自己的持久化事件，不 hydrate transcript：列个子代理不该触发整段历史。
      const entries = await roster.listByParentSession(context.sessionId, {
        signal: context.abortSignal,
      });
      history = dedupeHistoryEntries(entries.map(projectRosterEntry));
    } catch (error) {
      // 读不到历史不等于没有历史：退回只报注册表，并把这个事实显式写进结果，
      // 不静默吞掉异常。原因先在此留痕——`historyUnavailable` 只是给模型的布尔位。
      historyUnavailable = true;
      context.logger?.warn("ListAgents subagent roster lookup failed", {
        errorMessage: error instanceof Error ? error.message : String(error),
        event: "list_agents.roster_failed",
        module: "core.tool.list_agents",
        sessionId: context.sessionId,
        status: "failed",
      });
    }
  }

  const agents = [...live, ...missingHistory(live, history)]
    .filter((agent) => parsed.status === undefined || agent.status === parsed.status)
    .filter((agent) => parsed.agent_type === undefined || agent.agentType === parsed.agent_type);

  return {
    agents,
    ...(historyUnavailable ? { historyUnavailable: true as const } : {}),
  } satisfies ListAgentsOutput;
};

/**
 * 只收 `local_agent`，且必须带 childSessionId：后者是输出契约的必填项，也是 SendMessage 的寻址键。
 * 缺它的条目既不可读也不可寻址，直接略过而不是让整次列表因一条畸形快照失败。
 */
function collectLocalAgents(
  tasks: Record<string, RuntimeTaskSnapshot>,
): (RuntimeTaskSnapshot & { childSessionId: string })[] {
  return Object.values(tasks).filter(
    (task): task is RuntimeTaskSnapshot & { childSessionId: string } =>
      task.type === "local_agent" &&
      typeof task.childSessionId === "string" &&
      task.childSessionId.length > 0,
  );
}

function projectListedAgent(
  task: RuntimeTaskSnapshot & { childSessionId: string },
): ListAgentsAgent {
  const endedAt = task.completedAt;
  return {
    agentId: task.agentId,
    childSessionId: task.childSessionId,
    agentType: task.agentType,
    description: task.description,
    status: task.status,
    isBackgrounded: task.isBackgrounded === true,
    startedAt: task.startedAt.getTime(),
    ...(endedAt === undefined ? {} : { endedAt: endedAt.getTime() }),
    // 本进程注册表断言的状态可寻址、可实时：只有它能给 `live`。
    source: "live",
  };
}

/** roster 行：状态由事件投影给出（只可能是终态或 `lost`），字段与 live 行同形。 */
function projectRosterEntry(entry: SubagentRosterEntry): ListAgentsAgent {
  return {
    agentId: entry.agentId,
    childSessionId: entry.childSessionId,
    agentType: entry.agentType,
    description: entry.description,
    status: entry.status,
    isBackgrounded: entry.isBackgrounded,
    startedAt: entry.startedAt,
    ...(entry.endedAt === undefined ? {} : { endedAt: entry.endedAt }),
    // 历史行：其 runtime 不在本进程，`agent_*` 寻址已失效，只能用 childSessionId。
    source: "history",
  };
}

/** roster 的契约是「每 agentId 一条」，这里仍按 agentId 去重，扛住将来实现的分叉。 */
function dedupeHistoryEntries(agents: ListAgentsAgent[]): ListAgentsAgent[] {
  const deduped = new Map<string, ListAgentsAgent>();
  for (const agent of agents) {
    if (!deduped.has(agent.agentId)) deduped.set(agent.agentId, agent);
  }
  return [...deduped.values()];
}

/**
 * 合并：注册表行在前（保持派发顺序，它们是实时事实），roster 只补注册表没有的 agentId，
 * 历史部分按 startedAt 倒序（最近派发的先看到）。同 agentId 一律以 live 为准——
 * 注册表的 status / isBackgrounded 是眼前的事实，历史是投影。
 */
function missingHistory(live: ListAgentsAgent[], history: ListAgentsAgent[]): ListAgentsAgent[] {
  const liveIds = new Set(live.map((agent) => agent.agentId));
  return history
    .filter((agent) => !liveIds.has(agent.agentId))
    .sort((left, right) => right.startedAt - left.startedAt);
}

function listAgentsUnavailableFailure(): ToolHandlerFailure {
  return {
    result: false,
    errorCode: LIST_AGENTS_UNAVAILABLE_ERROR_CODE,
    message:
      "list_agents_unavailable: this session has no in-memory subagent registry, so it cannot list the subagents it spawned. This is a capability gap, not an empty list.",
  };
}

/**
 * 模型面：一个 XML-ish 容器 + 一代理一行。照 ListWorkflowRuns 的单行属性式投影——多行详情
 * 会把一次列表读成几十行而信息密度不变。
 */
function formatListAgentsModelContent(output: unknown): ModelMessageContent {
  const parsed = ListAgentsOutputSchema.safeParse(output);
  if (!parsed.success) return "ListAgents returned an invalid result.";

  const { agents, historyUnavailable } = parsed.data;
  const header = [
    agentAttribute("count", agents.length),
    ...(historyUnavailable ? [agentAttribute("history_unavailable", true)] : []),
  ].join(" ");
  // 历史不可读必须说成一句话：只给属性位会被读成「历史就是这个规模」。
  const notice = historyUnavailable
    ? [
        "Persisted subagent history could not be read for this call, so only rows from the in-process registry are listed. Do not conclude the other subagents never ran.",
      ]
    : [];
  if (agents.length === 0) {
    // 空容器容易被读成「工具没答上来」，必须说成一件事。
    return [
      `<agents ${header}>`,
      historyUnavailable
        ? "No subagents are in this process's in-memory registry, and the persisted history could not be read."
        : "No subagents from this session are in the in-memory registry or its persisted history.",
      "</agents>",
      ...notice,
    ].join("\n");
  }

  const rows = agents.map((agent) =>
    [
      "<agent",
      agentAttribute("id", agent.agentId),
      agentAttribute("child_session", agent.childSessionId),
      agentAttribute("type", agent.agentType),
      agentAttribute("status", agent.status),
      agentAttribute("background", agent.isBackgrounded),
      agentAttribute("description", agent.description),
      agentAttribute("started_at", formatWorkflowRunTimestamp(agent.startedAt)),
      ...(agent.endedAt === undefined
        ? []
        : [agentAttribute("ended_at", formatWorkflowRunTimestamp(agent.endedAt))]),
      // 行的来源决定寻址方式，必须逐行可见。
      agentAttribute("source", agent.source),
      "/>",
    ].join(" "),
  );

  return [`<agents ${header}>`, ...rows, "</agents>", ...notice].join("\n");
}

/** 属性式投影：空白折成单空格再转义，保证「一代理一行」的排版不被自由文本里的换行破坏。 */
function agentAttribute(name: string, value: string | number | boolean): string {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : String(value);
  return `${name}="${escapeXml(text)}"`;
}

export const listAgentsToolEntry: ToolEntry = {
  capability: "List the subagents this session spawned, with their status",
  metadata: {
    name: LIST_AGENTS_TOOL_NAME,
    description: LIST_AGENTS_DESCRIPTION,
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: LIST_AGENTS_TIMEOUT_MS,
    maxOutputBytes: LIST_AGENTS_MODEL_BYTES,
    sideEffectScope: "none",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: listAgentsHandler,
  inputSchema: ListAgentsInputJsonSchema,
  outputSchema: ListAgentsOutputJsonSchema,
  runtimeInputSchema: ListAgentsInputSchema,
  runtimeOutputSchema: ListAgentsOutputSchema,
  formatModelContent: formatListAgentsModelContent,
  permission: {
    permission: "listAgents",
    reason:
      "ListAgents reads this session's in-memory subagent registry and its persisted subagent history",
    riskLevel: "low",
    sideEffectScope: "none",
    needsApproval: false,
    // 输入只是过滤器、没有路径主体，所以模式只按工具名匹配（照 ListWorkflowRuns）。
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: LIST_AGENTS_MODEL_BYTES,
    maxModelBytes: LIST_AGENTS_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: LIST_AGENTS_MODEL_BYTES,
      // head：派发顺序在前，截尾丢的是最近派发的那些。
      direction: "head",
    },
  },
  timeout: {
    kind: "timed",
    defaultMs: LIST_AGENTS_TIMEOUT_MS,
    maxMs: LIST_AGENTS_TIMEOUT_MS,
    allowCallOverride: false,
  },
  cancellation: {
    supported: false,
    cleanup: "none",
    userVisibleMessage:
      "ListAgents only reads the in-memory registry and the persisted subagent history; it does not support user cancellation",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
