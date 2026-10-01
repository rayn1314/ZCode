// startSavedWorkflow 命令的模型选择契约：subagentModel 随信封下发、限长生效、
// model_unavailable 进拒绝词表、未知字段被剥离（fail-open，迁移边界见
// packages/ui/spec/saved-workflow-launch-model-selection.md）。
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseCommandEnvelope,
  savedWorkflowStartRejectionReasonSchema,
  SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX,
} from "../src/zcode-protocol-v4/command.js";
import { WORKFLOW_RUNS_LIMITS } from "../src/zcode-protocol-v4/workflow-runs.js";

function startEnvelope(payload: unknown) {
  return {
    commandId: "01900000-0000-7000-8000-000000000000",
    clientId: "test-client",
    sessionId: "session-1",
    type: "startSavedWorkflow" as const,
    payload,
    // 客户端时钟仅遥测，协议收数字时间戳。
    issuedAt: 1_791_000_000_000,
  };
}

test("subagentModel 规范串随信封通过并保留在 payload 里", () => {
  const parsed = parseCommandEnvelope(
    startEnvelope({ name: "review", scope: "project", subagentModel: "zcode/glm-5.3-flash$high" }),
  );
  assert.ok(parsed.ok);
  assert.equal(parsed.envelope.payload.subagentModel, "zcode/glm-5.3-flash$high");
});

test("超过限长的 subagentModel 被拒", () => {
  const long = "zcode/" + "m".repeat(WORKFLOW_RUNS_LIMITS.maxSubagentModelLength);
  const parsed = parseCommandEnvelope(startEnvelope({ name: "review", subagentModel: long }));
  assert.equal(parsed.ok, false);
});

test("model_unavailable 在拒绝词表里，且能拼出完整 fault code", () => {
  const parsed = savedWorkflowStartRejectionReasonSchema.safeParse("model_unavailable");
  assert.equal(parsed.success, true);
  assert.equal(
    `${SAVED_WORKFLOW_START_REJECTED_FAULT_PREFIX}model_unavailable`,
    "fault.command.savedWorkflowStartRejected.model_unavailable",
  );
});

test("未知字段被剥离（旧 CLI 收到新键 fail-open），缺省字段不带键", () => {
  const parsed = parseCommandEnvelope(
    startEnvelope({ name: "review", futureField: true, subagentModel: "zcode/glm-5.3-flash" }),
  );
  assert.ok(parsed.ok);
  assert.equal("futureField" in parsed.envelope.payload, false);
  assert.equal("args" in parsed.envelope.payload, false);
});
