import { describe, expect, it } from "vitest";
import {
  SESSION_ENTRY_SUBAGENT_LIFECYCLE,
  SessionEventType,
  STREAM_RECOVERY_DISCARDED_ERROR_NAME,
  STREAM_RECOVERY_DISCARDED_FINISH,
  type MessageWithParts,
  type SessionEntryInfo,
  type SessionEvent,
  type SessionInfo,
  type SessionProjection,
  type ToolPart,
} from "@zcode/contracts";
import {
  buildSubagentLifecycleIndex,
  paginateEndedSubagents,
  projectSessionSubagents,
} from "../src/zcode-protocol/subagent-session-query.js";

function session(id: string, taskType: SessionInfo["taskType"] = "subagent_child"): SessionInfo {
  return {
    id: id as SessionInfo["id"],
    projectID: "project" as SessionInfo["projectID"],
    taskType,
    slug: id,
    directory: "/workspace",
    title: id,
    version: "test",
    time: { created: 1, updated: 100 },
  };
}

function toolMessage(input: {
  childSessionId?: string;
  id: string;
  output?: Record<string, unknown> | string;
  runInBackground?: boolean;
  state?: "completed" | "error" | "running";
  tool?: string;
}): MessageWithParts {
  const state = input.state ?? "completed";
  const common = {
    input: {
      description: `Description ${input.id}`,
      subagent_type: "Explore",
      ...(input.runInBackground ? { run_in_background: true } : {}),
    },
    metadata: input.childSessionId ? { childSessionId: input.childSessionId } : {},
    time: state === "running" ? { start: 10 } : { start: 10, end: 20 },
  };
  const part: ToolPart = {
    id: `part-${input.id}` as ToolPart["id"],
    sessionID: "parent" as ToolPart["sessionID"],
    messageID: input.id as ToolPart["messageID"],
    type: "tool",
    callID: `call-${input.id}`,
    tool: input.tool ?? "Agent",
    state:
      state === "running"
        ? { ...common, status: "running" }
        : state === "error"
          ? { ...common, status: "error", error: "Provider failed" }
          : {
              ...common,
              status: "completed",
              output:
                typeof input.output === "string"
                  ? input.output
                  : JSON.stringify(input.output ?? { result: `Summary ${input.id}` }),
              title: `Description ${input.id}`,
            },
  };
  return {
    info: {
      id: input.id as never,
      sessionID: "parent" as never,
      role: "assistant",
      time: { created: 10, completed: 20 },
      parentID: "user" as never,
      modelID: "model" as never,
      providerID: "provider" as never,
      mode: "build",
      agent: "zcode",
      path: { cwd: "/workspace", root: "/workspace" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [part],
  };
}

function projection(status: SessionProjection["status"]): SessionProjection {
  return {
    id: "child" as never,
    createdAt: new Date(1),
    updatedAt: new Date(2),
    mode: "build",
    status,
    turnCount: 1,
    totalTokenCount: 0,
    contextUsed: 0,
    contextWindow: 1,
    pendingPermissions: [],
    pendingSteerInputs: [],
    activeToolCalls: [],
    streamingToolLedger: [],
    backgroundTasks: [],
    targetCompletionVerifications: [],
    targetCompletionVerificationTimeline: [],
  };
}

function subagentEvent(
  type: typeof SessionEventType.SubagentSpawned | typeof SessionEventType.SubagentStopped,
  payload: Record<string, unknown>,
  timestampMs = 15,
): SessionEvent {
  return {
    id: "event" as never,
    sessionId: "parent" as never,
    type,
    timestamp: new Date(timestampMs),
    traceId: "trace" as never,
    sequenceNumber: 1,
    payload,
  };
}

function lifecycleEntry(agentId: string, status: string, endedAt?: number): SessionEntryInfo {
  return {
    id: `entry-${agentId}` as never,
    sessionID: "parent" as never,
    type: SESSION_ENTRY_SUBAGENT_LIFECYCLE,
    time: { created: 5, updated: 6 },
    data: {
      agentId,
      childSessionId: `sess_subagent_${agentId}`,
      status,
      ...(endedAt === undefined ? {} : { endedAt }),
    },
  };
}

describe("subagent session query", () => {
  it("projects Agent and legacy Task refs but omits non-persisted children", () => {
    const result = projectSessionSubagents({
      revision: 3,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({ childSessionId: "child-agent", id: "m1" }),
        toolMessage({ childSessionId: "child-task", id: "m2", tool: "Task" }),
        toolMessage({ childSessionId: "missing", id: "m3" }),
      ],
      childSessionsById: new Map([
        ["child-agent", session("child-agent")],
        ["child-task", session("child-task")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.running).toEqual([]);
    expect(result.ended.map((item) => item.childSessionId)).toEqual(["child-task", "child-agent"]);
    expect(result.ended[0]).toMatchObject({
      status: "success",
      subagentType: "Explore",
      summary: "Summary m2",
    });
  });

  it("uses live child and background state without duplicating the persisted ref", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-1",
        taskKind: "subagent",
        childSessionId: "child-1",
        blocked: true,
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 4,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ childSessionId: "child-1", id: "m1", state: "running" })],
      childSessionsById: new Map([["child-1", session("child-1")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map([["child-1", projection("waiting")]]),
      parentProjection,
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-1", status: "blocked" }),
    ]);
  });

  it("uses live spawn events for foreground children before the Agent result is persisted", () => {
    const parentProjection = projection("running");
    parentProjection.backgroundTasks = [
      {
        taskId: "agent-live",
        taskKind: "subagent",
        childSessionId: "child-live",
        status: "running",
        startedAt: new Date(10),
      },
    ];
    const result = projectSessionSubagents({
      revision: 5,
      parentSession: session("parent", "interactive"),
      messages: [toolMessage({ id: "m1", state: "running" })],
      childSessionsById: new Map([["child-live", session("child-live")]]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-live",
          agentType: "Explore",
          childSessionId: "child-live",
          parentToolCallId: "call-m1",
          description: "Live foreground Agent",
        }),
      ],
      parentProjection,
    });

    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId: "child-live", status: "running" }),
    ]);
  });

  it("keeps a launched background child running when a partial projection omits its task", () => {
    const childSessionId = "sess_subagent_agent-keepalive";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-keepalive\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("folds a reconciled interrupted lifecycle entry into ended instead of recoverable running", () => {
    // 进程重启后注册表/投影全部清零，只剩 launch ACK part（结构上停在 completed）。
    // 没有终态 lifecycle 时上游 fallback 会把死代理永远显示成 running；
    // 有 `interrupted` 登记时必须落到 ended，且不能被 ACK part 的 completed 误标成 success。
    const childSessionId = "sess_subagent_agent-dead";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-dead\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
      lifecycleByAgentId: buildSubagentLifecycleIndex([lifecycleEntry("agent-dead", "interrupted", 999)]),
    });

    expect(result.running).toEqual([]);
    expect(result.ended).toEqual([
      expect.objectContaining({ childSessionId, status: "lost", endedAt: 999 }),
    ]);
  });

  it("keeps the recoverable-running fallback when the lifecycle entry is spawn-only", () => {
    // spawn-only entry 不是终态证据：活体进程里父投影暂时缺 background task 时，
    // fallback 仍是「可恢复 running」的正确判定，不能被 lifecycle 压掉。
    const childSessionId = "sess_subagent_agent-keepalive";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-keepalive\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map(),
      lifecycleByAgentId: buildSubagentLifecycleIndex([lifecycleEntry("agent-keepalive", "running")]),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("lets a live child projection outrank a terminal lifecycle entry", () => {
    // 复活续跑的窗口期：子会话已在本进程真实运行，lifecycle 可能还停在旧终态——
    // 活体证据必须赢，lifecycle 只压 fallback、不压真实运行态。
    const childSessionId = "sess_subagent_agent-revived";
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-revived\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, []]]),
      childProjectionsById: new Map([[childSessionId, projection("running")]]),
      lifecycleByAgentId: buildSubagentLifecycleIndex([lifecycleEntry("agent-revived", "interrupted", 999)]),
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("indexes lifecycle entries by agentId, keeping spawn-only as running and skipping malformed rows", () => {
    const malformed = { ...lifecycleEntry("ignored", "completed") } as SessionEntryInfo;
    (malformed.data as Record<string, unknown>).agentId = "";
    const index = buildSubagentLifecycleIndex([
      lifecycleEntry("agent-a", "running"),
      lifecycleEntry("agent-b", "interrupted", 123),
      lifecycleEntry("agent-c", "completed"),
      malformed,
      { ...lifecycleEntry("agent-d", "completed"), type: "unrelated" as never },
    ]);

    expect(index.get("agent-a")).toEqual({ status: "running" });
    expect(index.get("agent-b")).toEqual({ status: "interrupted", endedAt: 123 });
    expect(index.get("agent-c")).toEqual({ status: "completed" });
    expect(index.has("ignored")).toBe(false);
    expect(index.has("agent-d")).toBe(false);
  });

  it("does not treat a completed child tool-call model step as a terminal child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-tool";
    const childToolStep = toolMessage({
      id: "child-tool-step",
      state: "running",
      tool: "Bash",
    });
    childToolStep.info.time.completed = 30;
    childToolStep.info.finish = "tool-calls";

    const result = projectSessionSubagents({
      revision: 7,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-tool\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childToolStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-tool",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child tool Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("does not treat a stream recovery discarded child step as a failed child outcome", () => {
    const childSessionId = "sess_subagent_agent-child-discarded";
    const discardedStep = toolMessage({ id: "child-discarded", state: "running", tool: "Bash" });
    discardedStep.parts = [];
    discardedStep.info.time.completed = 30;
    discardedStep.info.finish = STREAM_RECOVERY_DISCARDED_FINISH;
    discardedStep.info.error = {
      name: STREAM_RECOVERY_DISCARDED_ERROR_NAME,
      data: { message: "Partial assistant output was discarded before a streaming retry." },
    };

    const result = projectSessionSubagents({
      revision: 8,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-discarded\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [discardedStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-discarded",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Child discarded Agent",
        }),
      ],
    });

    expect(result.ended).toEqual([]);
    expect(result.running).toEqual([
      expect.objectContaining({ childSessionId, status: "running" }),
    ]);
  });

  it("derives the persisted foreground child id from the completed Agent output agentId", () => {
    const result = projectSessionSubagents({
      revision: 6,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          id: "m1",
          output: { agentId: "agent-foreground", result: "Finished foreground work" },
        }),
      ],
      childSessionsById: new Map([
        ["sess_subagent_agent-foreground", session("sess_subagent_agent-foreground")],
      ]),
      childMessagesById: new Map(),
      childProjectionsById: new Map(),
    });

    expect(result.ended).toEqual([
      expect.objectContaining({
        childSessionId: "sess_subagent_agent-foreground",
        summary: "Finished foreground work",
        status: "success",
      }),
    ]);
  });

  it("takes the latest terminal evidence as the ended time, not the parent launch ACK", () => {
    // 后台 Agent 的父 tool part 在 launch ACK 后立刻 completed（state.time.end = 20），
    // 子会话事后被续跑跑完（最后一条 assistant 完成于 500）。取最晚值，不能取 ACK 时刻。
    const childSessionId = "sess_subagent_agent-child-late-finish";
    const childFinal = toolMessage({ id: "child-final", runInBackground: true });
    childFinal.parts = [];
    childFinal.info.time.completed = 500;

    const result = projectSessionSubagents({
      revision: 9,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-late-finish\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childFinal]]]),
      childProjectionsById: new Map([[childSessionId, projection("completed")]]),
    });

    expect(result.ended).toEqual([
      expect.objectContaining({ childSessionId, status: "success", endedAt: 500 }),
    ]);
  });

  it("keeps a later stop relation as the ended time when it outranks the child's last message", () => {
    // 反向：子会话最后一条消息停在 300（工具轮中途被杀），父侧 900 才看见它停——
    // 结束时间要取 900，而不是子会话更早的那条消息。
    const childSessionId = "sess_subagent_agent-child-cancelled-late";
    const childStep = toolMessage({ id: "child-step", state: "running", tool: "Bash" });
    childStep.info.time.completed = 300;

    const result = projectSessionSubagents({
      revision: 10,
      parentSession: session("parent", "interactive"),
      messages: [
        toolMessage({
          childSessionId,
          id: "m1",
          output:
            "Async agent launched successfully.\nagentId: agent-child-cancelled-late\nThe agent is working in the background.",
          runInBackground: true,
        }),
      ],
      childSessionsById: new Map([[childSessionId, session(childSessionId)]]),
      childMessagesById: new Map([[childSessionId, [childStep]]]),
      childProjectionsById: new Map(),
      parentEvents: [
        subagentEvent(SessionEventType.SubagentSpawned, {
          agentId: "agent-child-cancelled-late",
          childSessionId,
          parentToolCallId: "call-m1",
          description: "Cancelled late Agent",
        }),
        subagentEvent(
          SessionEventType.SubagentStopped,
          {
            agentId: "agent-child-cancelled-late",
            childSessionId,
            parentToolCallId: "call-m1",
            status: "cancelled",
          },
          900,
        ),
      ],
    });

    expect(result.ended).toEqual([
      expect.objectContaining({ childSessionId, status: "cancelled", endedAt: 900 }),
    ]);
  });

  it("paginates ended children newest-first with an opaque cursor", () => {
    const ended = Array.from({ length: 25 }, (_, index) => ({
      childSessionId: `child-${index}`,
      subagentType: "Explore",
      title: `Child ${index}`,
      status: "success" as const,
      endedAt: 100 - index,
    }));
    const first = paginateEndedSubagents(ended, { limit: 20 });
    const second = paginateEndedSubagents(ended, { cursor: first.nextCursor, limit: 20 });

    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    expect(second.items.map((item) => item.childSessionId)).toEqual([
      "child-20",
      "child-21",
      "child-22",
      "child-23",
      "child-24",
    ]);
    expect(second.nextCursor).toBeUndefined();
  });
});
