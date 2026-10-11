import assert from "node:assert/strict";
import test from "node:test";
import { reloadSubagents } from "../src/zcode-protocol/reload-subagents.js";
import type { ZCodeProtocolAgentServerContext } from "../src/zcode-protocol/server-types.js";

/**
 * 热重载下发契约（spec: core/spec/subagent-settings-sync.md D2/D3）：
 * - 载荷只有 workspace ref；值一律由被通知的会话自己按当前磁盘重读（无载荷 = 无过期窗口）；
 * - 不实现能力的 session（旧 app / mock）跳过，计数只算真正重载的；
 * - 逐个 await（重载是异步读盘），不能只发不收。
 */

const workspace = {
  workspacePath: "/ws/demo",
  workspaceIdentity: "ws-demo",
  workspaceKey: "ws-demo",
};

function contextWith(sessions: Map<string, unknown>): ZCodeProtocolAgentServerContext {
  return { sessions } as unknown as ZCodeProtocolAgentServerContext;
}

test("有能力的 session 逐个重载，无能力的跳过，计数只算重载数", async () => {
  const reloaded: string[] = [];
  const sessions = new Map<string, unknown>([
    ["sess-a", { app: { reloadSubagents: async () => reloaded.push("sess-a") } }],
    ["sess-b", { app: {} }],
    ["sess-c", { app: { reloadSubagents: async () => reloaded.push("sess-c") } }],
  ]);

  const result = await reloadSubagents(contextWith(sessions), { workspace });

  assert.equal(result.reloadedSessionCount, 2);
  assert.deepEqual(reloaded, ["sess-a", "sess-c"]);
});

test("重载失败要上抛：不能把半应用的配置当成成功", async () => {
  const sessions = new Map<string, unknown>([
    [
      "sess-a",
      {
        app: {
          reloadSubagents: async () => {
            throw new Error("disk read failed");
          },
        },
      },
    ],
  ]);

  await assert.rejects(
    () => reloadSubagents(contextWith(sessions), { workspace }),
    /disk read failed/,
  );
});

test("非法载荷（缺 workspace ref）按 Invalid params 拒绝", async () => {
  const sessions = new Map<string, unknown>([
    ["sess-a", { app: { reloadSubagents: async () => {} } }],
  ]);

  await assert.rejects(() => reloadSubagents(contextWith(sessions), {}), /Invalid params/);
});
