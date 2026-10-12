import assert from "node:assert/strict";
import { test } from "vitest";
import type { SubagentStateSnapshot } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import {
  replicateSubagentState,
  replicateSubagentStateOnRemoteConnect,
} from "@/lib/subagentStateReplication.js";

/**
 * 跨环境复制契约（spec: core/spec/subagent-settings-sync.md D1/D2）：
 * - 先把整份快照写进目标环境（一次 replace 就表达「改回继承 / 重新启用」的删除语义），
 *   再让目标环境已活动的会话重读——文件先落地，未来会话才与运行态一致；
 * - 权威快照由调用方传入/本机读出，本函数不从别的来源凑值。
 */
const STATE: SubagentStateSnapshot = {
  builtInModelSelectionOverrides: {
    "general-purpose": { providerId: "prov-1", modelId: "u2-flash" },
  },
  disabledAgentIds: ["helper"],
  pluginAgentModelSelectionOverrides: {
    "plugin:demo:reviewer": { providerId: "prov-1", modelId: "u2-override" },
  },
};

test("先整份替换目标环境配置，再触发重载", async () => {
  const calls: Array<{ method: string; payload: unknown }> = [];
  const services = {
    subagentsService: {
      async replaceSubagentState(state: unknown) {
        calls.push({ method: "replace", payload: state });
        return state;
      },
    },
    zcodeAgentService: {
      async reloadSubagents() {
        calls.push({ method: "reload", payload: undefined });
      },
    },
  } as unknown as IServiceAccessor;

  await replicateSubagentState({ services, state: STATE });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["replace", "reload"],
  );
  // 快照原样传递：删除语义（缺键 / 不在集合里）靠整份替换表达，不能逐项凑。
  assert.deepEqual(calls[0].payload, STATE);
});

test("连接就绪时从本机权威读快照并复制；失败只记日志不抛", async () => {
  const written: unknown[] = [];
  const baseServices = {
    subagentsService: {
      async getSubagentState() {
        return STATE;
      },
    },
  } as unknown as IServiceAccessor;
  const remoteServices = {
    subagentsService: {
      async replaceSubagentState(state: unknown) {
        written.push(state);
        return state;
      },
    },
    zcodeAgentService: { async reloadSubagents() {} },
  } as unknown as IServiceAccessor;

  await replicateSubagentStateOnRemoteConnect({
    baseServices,
    remoteServices,
    sessionId: "sess-remote",
  });
  assert.deepEqual(written, [STATE]);

  // 本机读失败不得阻塞连接注册：下次重连再补。
  const failingBase = {
    subagentsService: {
      async getSubagentState() {
        throw new Error("local data root unavailable");
      },
    },
  } as unknown as IServiceAccessor;
  await replicateSubagentStateOnRemoteConnect({
    baseServices: failingBase,
    remoteServices,
    sessionId: "sess-remote",
  });
  assert.equal(written.length, 1);
});
