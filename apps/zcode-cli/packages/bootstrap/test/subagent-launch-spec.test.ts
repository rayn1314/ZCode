import assert from "node:assert/strict";
import test from "node:test";
import {
  SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
  type SessionEntryInfo,
  type SessionId,
  type SessionStorePort,
  type SubagentLaunchSpecEntryData,
} from "@zcode/contracts";
import {
  buildSubagentChildRuntimeConfigOverrides,
  readSubagentLaunchSpec,
} from "../src/zcode-protocol/subagent-launch-spec.js";

/**
 * 子代理启动规格的读侧契约（spec D2 / S1a）。两条最关键的断言：
 * - `subagents.enabled === false` **无条件**下发（规格缺失也写）——它是"子代理不得再派生
 *   子代理"的闸门，冷恢复漏写就等于把 `Agent` 工具还给子会话；
 * - 规格不可用时只给闸门、不猜身份（不回填 toolset / 白名单）。
 */

const CHILD = "sess_subagent_agent_1" as SessionId;

const VALID_SPEC: SubagentLaunchSpecEntryData = {
  agentType: "general-purpose",
  agentName: "zcode-general-purpose",
  profileName: "general-purpose",
  profileSource: "built-in",
  toolset: "main",
  toolAllowlist: ["Read", "respond_to_coordinator"],
  toolDisallowlist: ["Write"],
  maxTurns: 7,
  background: true,
};

function specEntry(data: unknown): SessionEntryInfo {
  return {
    id: `subagent-launch-spec:${CHILD}`,
    sessionID: CHILD,
    type: SESSION_ENTRY_SUBAGENT_LAUNCH_SPEC,
    time: { created: 0, updated: 0 },
    data,
  };
}

function storeWith(entries: readonly SessionEntryInfo[]): SessionStorePort {
  return {
    async sessionEntries() {
      return [...entries];
    },
  } as unknown as SessionStorePort;
}

test("缺规格只下发 fail-closed 套娃闸，不回填任何身份事实", () => {
  assert.deepEqual(buildSubagentChildRuntimeConfigOverrides(undefined), {
    subagents: { enabled: false },
  });
});

test("有规格时：闸门恒在 + 冻结工具面与身份回填", () => {
  const overrides = buildSubagentChildRuntimeConfigOverrides(VALID_SPEC);

  assert.equal(overrides.subagents.enabled, false);
  assert.equal(overrides.subagents.maxTurns, 7);
  assert.equal(overrides.toolset, "main");
  assert.equal(overrides.agentName, "zcode-general-purpose");
  assert.deepEqual(overrides.toolAllowlist, ["Read", "respond_to_coordinator"]);
  assert.deepEqual(overrides.toolDisallowlist, ["Write"]);
});

test("规格里没表达的可选字段不产生空键", () => {
  const overrides = buildSubagentChildRuntimeConfigOverrides({
    ...VALID_SPEC,
    maxTurns: undefined,
    toolDisallowlist: undefined,
  });

  assert.equal("maxTurns" in overrides.subagents, false);
  assert.equal("toolDisallowlist" in overrides, false);
});

test("读到规格：按类型过滤，取子会话自己那一行", async () => {
  const spec = await readSubagentLaunchSpec({
    sessionStore: storeWith([specEntry(VALID_SPEC)]),
    sessionId: CHILD,
  });

  assert.deepEqual(spec, VALID_SPEC);
});

test("无 entry / 无存储 / 结构不可用 → undefined（受限模式），三种路径都不抛", async () => {
  const none = await readSubagentLaunchSpec({
    sessionStore: storeWith([]),
    sessionId: CHILD,
  });
  assert.equal(none, undefined);

  const noStore = await readSubagentLaunchSpec({ sessionId: CHILD });
  assert.equal(noStore, undefined);

  const malformed = await readSubagentLaunchSpec({
    sessionStore: storeWith([specEntry({ agentType: "general-purpose" })]),
    sessionId: CHILD,
  });
  assert.equal(malformed, undefined);
});

test("结构校验：不认识 toolset 或白名单含非字符串 → 不猜，退受限模式", async () => {
  const badToolset = await readSubagentLaunchSpec({
    sessionStore: storeWith([specEntry({ ...VALID_SPEC, toolset: "everything" })]),
    sessionId: CHILD,
  });
  assert.equal(badToolset, undefined);

  const badList = await readSubagentLaunchSpec({
    sessionStore: storeWith([specEntry({ ...VALID_SPEC, toolAllowlist: ["Read", 7] })]),
    sessionId: CHILD,
  });
  assert.equal(badList, undefined);
});

test("读取抛错不吞：冷恢复必须明确失败，而不是悄悄退化成受限会话", async () => {
  const failing = {
    async sessionEntries() {
      throw new Error("database is locked");
    },
  } as unknown as SessionStorePort;

  await assert.rejects(
    readSubagentLaunchSpec({ sessionStore: failing, sessionId: CHILD }),
    /database is locked/,
  );
});
