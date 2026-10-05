// 事件名副本一致性（shared 侧）：每一份 shared 包内可达的 schema 都必须
// 接受全部 7 个合法事件名、拒绝非法事件名。CLI 侧 contracts/adapters 的副本
// 由其它代理覆盖，本文件只覆盖 shared 包内副本。
import assert from "node:assert/strict";
import test from "node:test";
import { HOOK_EVENT_NAMES } from "../src/hooks.js";
import { workspaceHookTrustRecordSchema } from "../src/workspace-hook-trust-store-file.js";
import { workspaceHooksConfigSchema } from "../src/workspace-hook-config.js";
import { hookInvocationRowSchema } from "../src/zcode-protocol-v4/rows.js";
import { workspaceHookReviewRequestPayloadSchema } from "../src/zcode-protocol-v4/workspace-hook-review.js";

const SHA256 = "a".repeat(64);
const INVALID_EVENT = "NoSuchEvent";

function configFixture(event: string) {
  return { events: { [event]: [{ hooks: [{ type: "process", command: "node hook.mjs" }] }] } };
}

function trustRecordFixture(event: string) {
  return {
    workspaceIdentity: "ws-1",
    hookDeclarationDigest: SHA256,
    digestAlgorithm: "sha256",
    decision: "trusted",
    grantedAt: "2026-01-01T00:00:00Z",
    eventAtGrant: event,
    displayCommandAtGrant: "node hook.mjs",
    sourcePathAtGrant: "/workspace/.zcode/config.json",
  };
}

function hookInvocationRowFixture(event: string) {
  return {
    rowId: 1,
    turnId: "turn-1",
    createdAt: 1,
    createdAtSeq: 1,
    kind: "hookInvocation",
    hookInvocationId: "hook-1",
    hookEventName: event,
    hookCount: 1,
    state: "completed",
    startedAt: 1,
    lane: "assistantWork",
    executions: [],
  };
}

function reviewRequestFixture(event: string) {
  return {
    kind: "workspaceHookReview",
    reviewFlowId: "flow-1",
    generation: 1,
    interactionId: "interaction-1",
    sessionId: "session-1",
    taskId: "task-1",
    runId: "run-1",
    workspaceIdentity: "ws-1",
    workspaceLabel: "Workspace",
    bundleDigest: SHA256,
    createdAt: 1,
    deadlineAt: 2,
    sourceFiles: [
      { path: "/workspace/.zcode/config.json", displayPath: "config.json", editable: false },
    ],
    summary: { eventCount: 1, hookCount: 1, pendingCount: 1 },
    items: [
      {
        reviewItemId: "item-1",
        event,
        type: "process",
        displayName: "My Hook",
        displayCommand: "node hook.mjs",
        sourcePath: "/workspace/.zcode/config.json",
        resolvedTimeoutMs: 1000,
        resolvedMaxOutputBytes: 32768,
        executionMode: "foreground",
        configuredEnabled: true,
        editable: true,
        trustState: "pending_trust",
      },
    ],
    warningCode: "workspace_hooks_execute_code",
  };
}

const SCHEMA_CASES = [
  {
    name: "workspaceHooksConfigSchema",
    schema: workspaceHooksConfigSchema,
    build: configFixture,
  },
  {
    name: "workspaceHookTrustRecordSchema",
    schema: workspaceHookTrustRecordSchema,
    build: trustRecordFixture,
  },
  {
    name: "hookInvocationRowSchema",
    schema: hookInvocationRowSchema,
    build: hookInvocationRowFixture,
  },
  {
    name: "workspaceHookReviewRequestPayloadSchema",
    schema: workspaceHookReviewRequestPayloadSchema,
    build: reviewRequestFixture,
  },
] as const;

for (const { name, schema, build } of SCHEMA_CASES) {
  test(`${name} 接受全部 7 个合法事件名`, () => {
    for (const event of HOOK_EVENT_NAMES) {
      const parsed = schema.safeParse(build(event));
      assert.equal(
        parsed.success,
        true,
        `${name} 拒绝合法事件 ${event}: ${JSON.stringify(parsed.error?.issues)}`,
      );
    }
  });

  test(`${name} 拒绝非法事件名 ${INVALID_EVENT}`, () => {
    const parsed = schema.safeParse(build(INVALID_EVENT));
    assert.equal(parsed.success, false, `${name} 应拒绝非法事件 ${INVALID_EVENT}`);
  });
}
