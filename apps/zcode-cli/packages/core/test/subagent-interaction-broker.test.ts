import assert from "node:assert/strict";
import test from "node:test";
import type {
  PermissionBrokerPort,
  PermissionBrokerRequest,
  PermissionBrokerResult,
  SessionId,
  ToolCallId,
  TraceId,
  TurnId,
} from "@zcode/contracts";
import {
  createSubagentInteractionBroker,
  createSubagentInteractionRoutingBroker,
} from "../src/runtime/helpers/subagent-interaction-broker.js";

/**
 * 子会话阻塞交互的改写规则（spec: `core/spec/subagent-permission-parity.md` D2/D3）。
 *
 * 两条构造路径（派发当轮 / 重启后冷恢复）必须产出**同一条**对外路由：sessionId 改写为父会话，
 * origin 保留真正的发起者。冷恢复那条没有 `agentId` / `description`（存量 launch spec 没存），
 * 于是退化成"只改写路由、不带 origin"——宁可少一个来源徽标，也不编造 agentId（它是
 * SendMessage 的寻址键）。
 */
const PARENT = "sess_parent" as SessionId;
const CHILD = "sess_child" as SessionId;
const OTHER_PARENT = "sess_other_parent" as SessionId;

function createParentBroker(): {
  broker: PermissionBrokerPort;
  seen: PermissionBrokerRequest[];
} {
  const seen: PermissionBrokerRequest[] = [];
  const result: PermissionBrokerResult = { decision: "allow", reason: "stub" };
  return {
    broker: {
      requestPermission: (request) => {
        seen.push(request);
        return Promise.resolve(result);
      },
    },
    seen,
  };
}

function createRequest(overrides: Partial<PermissionBrokerRequest> = {}): PermissionBrokerRequest {
  return {
    input: { command: "echo hi" },
    mode: "build",
    reason: "Tool Bash requires permission",
    requestId: "perm-1",
    requestedAt: new Date(0),
    riskLevel: "high",
    ruleId: "mode.build.highRisk",
    sessionId: CHILD,
    toolCallId: "call-1" as ToolCallId,
    toolName: "Bash",
    traceId: "trace-1" as TraceId,
    turnId: "turn-1" as TurnId,
    ...overrides,
  };
}

test("派发路径：询问改写为父会话，并带上子代理来源", async () => {
  const { broker, seen } = createParentBroker();
  const wrapped = createSubagentInteractionBroker(broker, {
    agentId: "agent_child_1",
    agentType: "general-purpose",
    childSessionId: CHILD,
    description: "调研权限链路",
    parentToolCallId: "call-parent",
    parentSessionId: PARENT,
  });

  await wrapped.requestPermission(createRequest());

  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.sessionId, PARENT);
  assert.deepEqual(seen[0]?.origin, {
    agentId: "agent_child_1",
    agentType: "general-purpose",
    childSessionId: CHILD,
    childTurnId: "turn-1",
    description: "调研权限链路",
    kind: "subagent",
    parentSessionId: PARENT,
    parentToolCallId: "call-parent",
  });
});

test("派发路径：已有的 origin 不被外层覆盖（嵌套派发时归属仍是真正的发起者）", async () => {
  const { broker, seen } = createParentBroker();
  const wrapped = createSubagentInteractionBroker(broker, {
    agentId: "agent_outer",
    agentType: "general-purpose",
    childSessionId: CHILD,
    description: "外层",
    parentSessionId: PARENT,
  });

  await wrapped.requestPermission(
    createRequest({
      origin: {
        agentId: "agent_inner",
        agentType: "explore",
        childSessionId: "sess_inner" as SessionId,
        description: "内层",
        kind: "subagent",
        parentSessionId: PARENT,
      },
      sessionId: "sess_inner" as SessionId,
    }),
  );

  assert.equal(seen[0]?.sessionId, PARENT);
  assert.equal(seen[0]?.origin?.agentId, "agent_inner");
});

test("冷恢复路径（无 agentId/description）：只改写路由，不编造来源", async () => {
  const { broker, seen } = createParentBroker();
  const wrapped = createSubagentInteractionRoutingBroker(broker, PARENT);

  await wrapped.requestPermission(createRequest({ sessionId: CHILD }));

  // 路由必须落父会话——这是本轮修复的目的：落子会话自己的 id 时 UI 几乎没有出口。
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.sessionId, PARENT);
  // 但不得凭空造 origin。
  assert.equal(seen[0]?.origin, undefined);
  // 请求的其它字段原样透传（改写只碰 sessionId）。
  assert.equal(seen[0]?.toolName, "Bash");
  assert.equal(seen[0]?.ruleId, "mode.build.highRisk");
});

test("包装可叠加，但两个方向的裁决点不同（既有语义，本轮只登记不改）", async () => {
  const { broker, seen } = createParentBroker();
  const inner = createSubagentInteractionRoutingBroker(broker, OTHER_PARENT);
  const outer = createSubagentInteractionRoutingBroker(inner, PARENT);

  await outer.requestPermission(createRequest());
  // sessionId：离真实 broker **最近**的那层最后改写 → 内层胜。
  assert.equal(seen[0]?.sessionId, OTHER_PARENT);
});

test("origin 保留最先设置它的那层（否则嵌套派发会把归属改成中间层）", async () => {
  const { broker, seen } = createParentBroker();
  const inner = createSubagentInteractionBroker(broker, {
    agentId: "agent_inner",
    agentType: "explore",
    childSessionId: "sess_inner" as SessionId,
    description: "内层",
    parentSessionId: OTHER_PARENT,
  });
  const outer = createSubagentInteractionBroker(inner, {
    agentId: "agent_outer",
    agentType: "general-purpose",
    childSessionId: CHILD,
    description: "外层",
    parentSessionId: PARENT,
  });

  await outer.requestPermission(createRequest({ sessionId: "sess_inner" as SessionId }));
  // 外层先把 origin 设好，内层因此走 `request.origin ?? ...` 的短路分支。
  assert.equal(seen[0]?.origin?.agentId, "agent_outer");
});
