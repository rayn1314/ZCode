import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
  createRootTraceContext,
  type SessionEntryInfo,
  type SessionId,
} from "@zcode/contracts";
import {
  buildSubagentLaunchSpecEntry,
  persistSubagentLaunchSpec,
  subagentLaunchSpecEntryId,
} from "../src/subagent/launch-spec.js";
import { createDefaultSubagentPort } from "../src/runtime/methods/subagent.js";
import type { AgentRuntimeInternal } from "../src/internal.js";

/**
 * 子代理启动规格的写侧契约（spec D2）：稳定 id、只落推导不出来的身份事实、写入失败不打断 spawn。
 * 读侧契约在 `bootstrap/test/subagent-launch-spec.test.ts`。
 */

const CHILD = "sess_subagent_agent_1" as SessionId;
const CREATED_AT = Date.parse("2026-10-07T08:00:00.000Z");

function specData(): Parameters<typeof buildSubagentLaunchSpecEntry>[0]["data"] {
  return {
    agentType: "general-purpose",
    agentName: "zcode-general-purpose",
    profileName: "general-purpose",
    profileSource: "built-in",
    toolset: "main",
    toolAllowlist: ["Read", "Grep", "respond_to_coordinator"],
    maxTurns: 7,
    background: true,
  };
}

test("entry id 稳定，sessionID 指向子会话自己", () => {
  const entry = buildSubagentLaunchSpecEntry({
    childSessionId: CHILD,
    data: specData(),
    createdAt: CREATED_AT,
  });

  assert.equal(entry.id, `subagent-launch-spec:${CHILD}`);
  assert.equal(entry.id, subagentLaunchSpecEntryId(CHILD));
  // 规格写在子会话自己身上：读取侧就是按子会话 id 查的。
  assert.equal(entry.sessionID, CHILD);
  assert.equal(entry.type, SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC);
  assert.deepEqual(entry.time, { created: CREATED_AT, updated: CREATED_AT });
});

test("payload 原样落库：不做补全、不落 persona 正文与另有 owner 的事实", () => {
  const entry = buildSubagentLaunchSpecEntry({ childSessionId: CHILD, data: specData() });
  const data = entry.data as Record<string, unknown>;

  // persona 的 owner 是 profile（按 profileName/profileSource 重解析），permissionMode /
  // modelSelection 各有专用 entry —— 这三样出现在这里就是第二真相源。
  assert.deepEqual(Object.keys(data).sort(), [
    "agentName",
    "agentType",
    "background",
    "maxTurns",
    "profileName",
    "profileSource",
    "toolAllowlist",
    "toolset",
  ]);
  assert.equal(data.permissionMode, undefined);
  assert.equal(data.modelSelection, undefined);
});

test("宿主没有 saveSessionEntry 时跳过，不抛错", async () => {
  await persistSubagentLaunchSpec({
    sessionStore: {},
    entry: buildSubagentLaunchSpecEntry({ childSessionId: CHILD, data: specData() }),
    traceContext: createRootTraceContext({ sessionId: CHILD }),
  });
});

test("落盘失败只 warn，不让 spawn 失败", async () => {
  const warnings: string[] = [];
  await persistSubagentLaunchSpec({
    sessionStore: {
      async saveSessionEntry() {
        throw new Error("disk full");
      },
    },
    logger: {
      warn(message: string) {
        warnings.push(message);
      },
    } as unknown as Parameters<typeof persistSubagentLaunchSpec>[0]["logger"],
    entry: buildSubagentLaunchSpecEntry({ childSessionId: CHILD, data: specData() }),
    traceContext: createRootTraceContext({ sessionId: CHILD }),
  });

  assert.equal(warnings.length, 1);
});

test("经宿主对象调用 saveSessionEntry（this 绑定），不先取函数引用", async () => {
  const written: SessionEntryInfo[] = [];
  class Store {
    private readonly rows = written;
    async saveSessionEntry(entry: SessionEntryInfo): Promise<void> {
      this.rows.push(entry);
    }
  }

  await persistSubagentLaunchSpec({
    sessionStore: new Store(),
    entry: buildSubagentLaunchSpecEntry({ childSessionId: CHILD, data: specData() }),
    traceContext: createRootTraceContext({ sessionId: CHILD }),
  });

  assert.equal(written.length, 1);
  assert.equal(written[0]?.sessionID, CHILD);
});

/**
 * S1a 的安全链：`subagents.enabled === false` ⇒ 端口收回 ⇒ `includeAgent` 的两个注册点
 * （`runtime-tools.ts` / `embedded-search-branch.ts` 都读 `Boolean(runtime.subagentPort)`）不再注册
 * `Agent` 工具。bootstrap 只需下发 `enabled: false`，这一环由 core 现有代码保证——把最薄的那一环
 * 钉住，避免以后有人把它改成"只有显式 undefined 才收回"。
 */
test("subagents.enabled === false ⇒ 不构造子代理端口（套娃闸）", () => {
  const port = createDefaultSubagentPort.call(
    { config: { subagents: { enabled: false } } } as unknown as AgentRuntimeInternal,
    {} as never,
  );

  assert.equal(port, undefined);
});
