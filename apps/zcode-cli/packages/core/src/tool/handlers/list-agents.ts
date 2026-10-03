// ============================================================
// ListAgents Tool Handler
// ============================================================
// 列出**本会话**派出的子代理及其状态。数据源是 handler 上下文里的 runtimeTaskRegistry——
// 与 TaskOutput 同一条只读路径，不额外落盘、不跨会话。

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
  "Lists the subagents this session has spawned and their current status, so you can track them, audit them, or address one by its agentId.",
  "",
  "Scope and limits:",
  "- In-process only. The list comes from this process's in-memory task registry. After a process restart (or a cold-resumed session) it is empty even though the child sessions still exist on disk. Never conclude a subagent never ran just because it is missing here.",
  "- Direct children of this session only. Subagents cannot spawn subagents, and other sessions' subagents are not visible.",
  '- Without a filter, running and settled subagents are both listed. Pass `status: "running"` to see only what is still in flight.',
  "",
  "Each row gives the agentId (use it with SendMessage), the childSessionId, the agent type, the description, the status, whether it was backgrounded, and startedAt (plus endedAt once settled).",
].join("\n");

const listAgentsHandler: ToolHandler = async (input, context) => {
  const parsed = ListAgentsInputSchema.parse(input) as ListAgentsInput;

  const registry = context.runtimeTaskRegistry;
  // 注册门已保证父会话才装上本工具，registry 在这一层缺席是不可达的；仍给业务失败而不是抛错，
  // 与 workflow 内省工具「能力缺席」的语义一致。
  if (!registry) return listAgentsUnavailableFailure();

  // 插入序 = 派发顺序：registry 用 Map 保序，update 不改变已有键的位置。
  const agents = collectLocalAgents(registry.all())
    .filter((task) => parsed.status === undefined || task.status === parsed.status)
    .filter((task) => parsed.agent_type === undefined || task.agentType === parsed.agent_type)
    .map(projectListedAgent);

  return { agents } satisfies ListAgentsOutput;
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
  };
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

  const { agents } = parsed.data;
  const header = agentAttribute("count", agents.length);
  if (agents.length === 0) {
    // 空容器容易被读成「工具没答上来」，必须说成一件事。
    return `<agents ${header}>\nNo subagents spawned by this session are in the in-memory registry.\n</agents>`;
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
      "/>",
    ].join(" "),
  );

  return [`<agents ${header}>`, ...rows, "</agents>"].join("\n");
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
    reason: "ListAgents reads this session's in-memory subagent registry",
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
      "ListAgents reads the in-memory task registry synchronously and cannot be cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: false,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
