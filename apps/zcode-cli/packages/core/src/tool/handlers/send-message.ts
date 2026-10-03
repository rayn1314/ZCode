import {
  SEND_MESSAGE_TOOL_NAME,
  SendMessageInputJsonSchema,
  SendMessageInputSchema,
  SendMessageOutputSchema,
  SessionMessageChainExceededError,
  type SendMessageInput,
  type SendMessageOutput,
  type SessionMessageChain,
  type SessionMessageDeliveryRequest,
  type SessionMessageDeliveryResult,
  type SessionMessageSenderKind,
  type TraceContext,
} from "@zcode/contracts";
import type {
  ToolEntry,
  ToolExecutionContext,
  ToolHandler,
  ToolHandlerFailure,
} from "../types.js";
import { assertNotOffPeakTurn } from "./off-peak.js";

const MAX_SEND_MESSAGE_MODEL_BYTES = 4096;
/** 两类收件人前缀：与 D2 的寻址约定一致，不解析 title/alias。 */
const AGENT_RECIPIENT_PREFIX = "agent_";
const SESSION_RECIPIENT_PREFIX = "sess_";
/** 与 workflow 内省工具同款：判别键在 message 前缀，码本身不进模型。 */
const SEND_MESSAGE_FAILURE_CODE = {
  RECIPIENT_INVALID: 1,
  SUBAGENT_REGISTRY_UNAVAILABLE: 2,
  SESSION_MESSAGE_UNAVAILABLE: 3,
  CHAIN_EXCEEDED: 4,
} as const;
/**
 * SendMessage 续跑已完成子 Agent 走
 * resumeTerminalAgentInBackground，不携带闲时轮的 subagentModelOverride，子 Agent 按父会话
 * 常驻选择重建模型，请求全部计入用户 Coding Plan。闲时轮内子 Agent 均为前台同步完成，
 * SendMessage 唯一有意义的用途就是这条泄漏路径，因此直接拒绝。
 */
const OFF_PEAK_SEND_MESSAGE_HINT =
  "Spawn a new foreground Agent with the full context instead of resuming a completed one.";

const SEND_MESSAGE_PROVIDER_DESCRIPTION = [
  "# SendMessage",
  "",
  "Send a message to another agent or to any session.",
  "",
  "```json",
  '{"to": "agent_<uuid>", "summary": "assign task 1", "message": "start on task #1"}',
  "```",
  "",
  "Recipients, by `to` prefix:",
  "- `agent_<uuid>`: a subagent this session spawned; use the `agentId` from the Agent result. The message is steered into its active turn, queued for its next tool round, or resumes a settled agent in the background.",
  "- `sess_*`: any session by its ID (for a subagent, `sess_subagent_<uuid>`). Cross-session delivery reports how it landed: `steered` (injected into the target's running turn), `woken` (opened a new turn for an idle or cold session), or `stored` (target unreachable; kept in its mailbox for the next drain). You cannot send to your own session ID.",
  "- Any other value is rejected. Address sessions by their `sess_*` ID, not by title.",
  "",
  "Replies between two sessions are chain-limited: a message that would exceed 6 hops in one back-and-forth chain is rejected instead of delivered. If that happens, stop replying, summarize what you learned, and report to the user; a new human message resets the chain.",
  "",
  "Your plain text output is NOT visible to other agents — to communicate, you MUST call this tool. Messages from agents are delivered automatically; you don't check an inbox.",
].join("\n");

const SEND_MESSAGE_TOOL_OUTPUT_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  properties: {
    success: { type: "boolean" },
    message: { type: "string" },
  },
  required: ["success", "message"],
  additionalProperties: false,
};

const sendMessageHandler: ToolHandler = async (input, context) => {
  const parsed = SendMessageInputSchema.parse(input) as SendMessageInput;
  assertNotOffPeakTurn(context, SEND_MESSAGE_TOOL_NAME, {
    hint: OFF_PEAK_SEND_MESSAGE_HINT,
    recoverable: true,
  });

  // 统一寻址按前缀分流：`agent_*` 是本会话子代理注册表的便捷别名，`sess_*` 交给跨会话端口。
  // 不解析 title/alias——会话一律用主键寻址（spec D2）。
  if (parsed.to.startsWith(AGENT_RECIPIENT_PREFIX)) {
    return sendToLocalSubagent(parsed, context);
  }
  if (parsed.to.startsWith(SESSION_RECIPIENT_PREFIX)) {
    return sendToSession(parsed, context);
  }
  return invalidRecipientFailure(parsed.to);
};

/**
 * `agent_*`：沿用既有子代理投递（三态 queued/steered/resumed_background）。
 * 子代理 runtime 没有本会话子代理注册表，此处必须明确失败，而不是静默当作成功。
 */
async function sendToLocalSubagent(
  parsed: SendMessageInput,
  context: ToolExecutionContext,
): Promise<SendMessageOutput | ToolHandlerFailure> {
  if (!context.subagentPort?.sendMessage) {
    return {
      result: false,
      errorCode: SEND_MESSAGE_FAILURE_CODE.SUBAGENT_REGISTRY_UNAVAILABLE,
      message:
        `subagent_registry_unavailable: this runtime has no in-memory subagent registry, ` +
        `so it cannot address the local subagent "${parsed.to}". ` +
        "Address a session by its `sess_*` ID instead, or call this tool from the session that spawned the agent.",
    };
  }

  return context.subagentPort.sendMessage(
    {
      sessionId: context.sessionId,
      turnId: context.turnId,
      parentToolCallId: context.toolCallId,
      to: parsed.to,
      summary: parsed.summary,
      message: parsed.message,
      workingDirectory: context.workingDirectory,
      workspaceRoot: context.workspaceRoot,
      trace: resolveToolTraceContext(context),
    },
    { signal: context.abortSignal },
  ) satisfies Promise<SendMessageOutput>;
}

/**
 * `sess_*`：走跨会话投递端口，把实际落地方式（steered/woken/stored）如实映射到输出，
 * 不因调用未抛错就报成功。端口缺席或自投递都明确失败。
 */
async function sendToSession(
  parsed: SendMessageInput,
  context: ToolExecutionContext,
): Promise<SendMessageOutput | ToolHandlerFailure> {
  if (parsed.to === context.sessionId) {
    return {
      result: false,
      errorCode: SEND_MESSAGE_FAILURE_CODE.RECIPIENT_INVALID,
      message:
        `invalid_recipient: "${parsed.to}" is the sending session itself; ` +
        "SendMessage cannot deliver a message to its own session. Target a different session or a local subagent.",
    };
  }

  const port = context.sessionMessagePort;
  if (!port) {
    return {
      result: false,
      errorCode: SEND_MESSAGE_FAILURE_CODE.SESSION_MESSAGE_UNAVAILABLE,
      message:
        `session_message_unavailable: this runtime has no cross-session delivery port, ` +
        `so it cannot deliver to "${parsed.to}". This is a capability gap, not a delivered message.`,
    };
  }

  const messageId = `msg_${crypto.randomUUID()}`;
  const request: SessionMessageDeliveryRequest = {
    toSessionId: parsed.to,
    content: parsed.message,
    messageId,
    // 身份由发送方 runtime 填充，接收方只读（spec D4）：子代理 runtime 标附属身份。
    fromSessionId: context.sessionId,
    senderKind: resolveSenderKind(context),
    createdAt: new Date().toISOString(),
    // 发送侧算链（spec D7）：读本会话**实时**入站链（guide 可能在本回合中途注入新链）。
    // reader 缺席按无链处理，不因能力缺席而报错——链上限只是护栏，不是寻址前提。
    sessionMessageChain: resolveOutboundChain(context, messageId),
  };
  let result: SessionMessageDeliveryResult;
  try {
    result = await port.deliver(request, { signal: context.abortSignal });
  } catch (error) {
    // cap 的唯一裁决点在发送侧端口；超限是明确业务失败，必须交回模型，不能悄悄降级成 stored。
    if (error instanceof SessionMessageChainExceededError) {
      return {
        result: false,
        errorCode: SEND_MESSAGE_FAILURE_CODE.CHAIN_EXCEEDED,
        message: error.message,
      };
    }
    throw error;
  }

  return {
    status: "success",
    messageId: result.messageId,
    delivery: result.status,
    message: formatSessionDeliveryMessage(result),
  } satisfies SendMessageOutput;
}

/**
 * `sess_*` 出站链：入站链存在则接续（hop+1、origin 保持），否则本次消息就是链首（hop=1）。
 * 工具侧不得自行推导链深，只能经 reader 读 runtime 的唯一事实源。
 */
function resolveOutboundChain(
  context: ToolExecutionContext,
  outboundMessageId: string,
): SessionMessageChain {
  const inbound = context.sessionMessageChainReader?.current();
  return inbound
    ? { hop: inbound.hop + 1, originMessageId: inbound.originMessageId }
    : { hop: 1, originMessageId: outboundMessageId };
}

function invalidRecipientFailure(to: string): ToolHandlerFailure {
  return {
    result: false,
    errorCode: SEND_MESSAGE_FAILURE_CODE.RECIPIENT_INVALID,
    message:
      `invalid_recipient: "${to}" is not a valid recipient. ` +
      "Use `agent_<uuid>` for a subagent this session spawned, or `sess_*` for any session.",
  };
}

/**
 * `taskType === "subagent_child"` 在工具上下文里投影为 `runtimeScope === "subagent"`
 * （与 runtime-tools.ts 的判据同源）。据此标注附属身份；其余会话是独立身份。
 */
function resolveSenderKind(context: ToolExecutionContext): SessionMessageSenderKind {
  return context.runtimeScope === "subagent" ? "subagent" : "session";
}

function formatSessionDeliveryMessage(result: SessionMessageDeliveryResult): string {
  switch (result.status) {
    case "steered":
      return `Message ${result.messageId} was steered into the active turn of session ${result.toSessionId}.`;
    case "woken":
      return `Message ${result.messageId} woke idle session ${result.toSessionId} into a new turn.`;
    case "stored":
      return `Session ${result.toSessionId} is unreachable right now; message ${result.messageId} was stored in its mailbox for the next drain.`;
  }
}

export const sendMessageToolEntry: ToolEntry = {
  capability: "Send a short message to a local agent or another session",
  metadata: {
    name: SEND_MESSAGE_TOOL_NAME,
    description: SEND_MESSAGE_PROVIDER_DESCRIPTION,
    readOnly: false,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: 10000,
    maxOutputBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: sendMessageHandler,
  formatModelContent: formatSendMessageModelContent,
  inputSchema: SendMessageInputJsonSchema,
  outputSchema: SEND_MESSAGE_TOOL_OUTPUT_SCHEMA,
  runtimeInputSchema: SendMessageInputSchema,
  runtimeOutputSchema: SendMessageOutputSchema,
  permission: {
    permission: "agent.message.send",
    reason: "SendMessage writes a message to a local agent queue or delivers it to another session",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName", "input"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    maxModelBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
    strategy: "truncate",
    preview: {
      maxBytes: MAX_SEND_MESSAGE_MODEL_BYTES,
      direction: "head",
    },
  },
  timeout: {
    defaultMs: 10000,
    maxMs: 10000,
    allowCallOverride: false,
  },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SendMessage was cancelled before delivery status returned",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatSendMessageModelContent(output: unknown): string {
  const result = SendMessageOutputSchema.parse(output);
  if (result.message) return result.message;
  if (result.status === "success") {
    if (result.delivery) {
      return `Message ${result.messageId} was ${result.delivery} for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
    }
    return `Message ${result.messageId} was queued for local agent ${result.agentId ?? result.taskId ?? "unknown"}.`;
  }
  return `Message ${result.messageId} failed to send to local agent ${result.agentId ?? result.taskId ?? "unknown"}: ${result.error ?? "unknown error"}.`;
}

function resolveToolTraceContext(context: Parameters<ToolHandler>[1]): TraceContext {
  return (
    context.traceContext ?? {
      traceId: context.traceId,
      spanId: context.spanId,
      parentSpanId: context.parentSpanId,
      sessionId: context.sessionId,
      turnId: context.turnId,
    }
  );
}
