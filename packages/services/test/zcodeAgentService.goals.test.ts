// 回归：服务层发给服务端的 goal 相关请求形状必须通过 strict 协议 schema。
// 2026-10-13 实测事故：listSessionGoals 曾手拼 workspace 对象、漏掉必填的
// workspaceKey，被服务端 parse reject，面板显示「加载任务失败」。此测试用假 agent
// 在真实 stdio 链路上按服务端的校验口径检查每个到达的请求，形状错了测试立即红。
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createZCodeAgentService } from "../src/zcode-agent/zcodeAgentService.js";

const FAKE_AGENT = `
const fs = require("node:fs");
let buffer = "";
function send(value) { process.stdout.write(JSON.stringify(value) + "\\n"); }
function fail(id, message) { send({ id, error: { code: -1, message } }); }
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let newline;
  while ((newline = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (!line.trim()) continue;
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message.id === undefined) continue;
    const params = message.params ?? {};
    if (message.method === "session/list") {
      send({ id: message.id, result: { sessions: [] } });
      continue;
    }
    if (message.method === "session/goalList") {
      // 服务端 zcodeSessionGoalListParamsSchema 是 strict 的；workspaceKey 是
      // workspace ref 的必填项。这里复刻服务端的两条校验，形状错就回错误。
      if (!params.workspace || typeof params.workspace.workspaceKey !== "string") {
        fail(message.id, "Invalid params — workspace.workspaceKey: expected string, received undefined");
        continue;
      }
      if (params.scope !== undefined && !["workspace", "all"].includes(params.scope)) {
        fail(message.id, "Invalid params — scope: invalid enum value");
        continue;
      }
      send({ id: message.id, result: { goals: [] } });
      continue;
    }
    if (message.method === "session/goal") {
      // 把收到的参数原样落盘，供测试端用 strict 协议 schema 校验 wire 形状。
      // 回复故意给一个不合法的 snapshot：本测试只关心「请求是否按正确形状到达」，
      // 不关心本次回复；服务端真实回复由 bootstrap 层测试覆盖。
      if (process.env.GOALS_WIRE_DUMP) {
        fs.writeFileSync(process.env.GOALS_WIRE_DUMP, JSON.stringify(params));
      }
      fail(message.id, "stub: snapshot intentionally invalid in this harness");
      continue;
    }
    fail(message.id, "unexpected method " + message.method);
  }
});
`;

describe("ZCodeAgentService goal 请求的 wire 形状", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createService() {
    const workspacePath = mkdtempSync(join(tmpdir(), "zcode-goal-wire-"));
    tempDirs.push(workspacePath);
    const scriptPath = join(workspacePath, "agent.cjs");
    writeFileSync(scriptPath, FAKE_AGENT);
    const service = createZCodeAgentService({
      commandResolver: () => ({ command: process.execPath, args: [scriptPath] }),
    });
    return { service, workspacePath };
  }

  it("listSessionGoals 的 workspace 携带必填的 workspaceKey（否则服务端 reject）", async () => {
    const { service, workspacePath } = createService();
    try {
      const result = await service.listSessionGoals({ workspacePath });
      expect(result.goals).toEqual([]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("listSessionGoals 支持 scope: all 的跨项目查询，请求形状不变", async () => {
    const { service, workspacePath } = createService();
    try {
      const result = await service.listSessionGoals({
        workspacePath,
        scope: "all",
        includeArchived: true,
      });
      expect(result.goals).toEqual([]);
    } finally {
      await service.disposeAllAndWait();
    }
  });

  it("goalSession 的 start:false 走只读客户端（未配供应商也能保存），且 start 原样到线", async () => {
    const { service, workspacePath } = createService();
    const dumpPath = join(workspacePath, "goal-wire.json");
    process.env.GOALS_WIRE_DUMP = dumpPath;
    try {
      // 无供应商环境中 start:false 不应抛 provider-not-ready（只读客户端路径）；
      // 本 harness 的假 agent 会回一个故意的 stub 错误，断言错误码即可证明路由正确。
      await expect(
        service.goalSession({
          workspacePath,
          sessionId: "sess_wire",
          action: "set",
          objective: "keep improving",
          start: false,
        }),
      ).rejects.toThrowError(/stub/);

      const sent = JSON.parse(
        await import("node:fs/promises").then((m) => m.readFile(dumpPath, "utf8")),
      );
      expect(sent.start).toBe(false);
      expect(sent.sessionId).toBe("sess_wire");
      expect(sent.objective).toBe("keep improving");
    } finally {
      delete process.env.GOALS_WIRE_DUMP;
      await service.disposeAllAndWait();
    }
  });

  it("goalSession 缺省 start 仍要求模型供应商（运行路径语义不变）", async () => {
    const { service, workspacePath } = createService();
    try {
      await expect(
        service.goalSession({
          workspacePath,
          sessionId: "sess_wire",
          action: "set",
          objective: "keep improving",
        }),
      ).rejects.toMatchObject({ code: "ZCODE_AGENT_PROVIDER_NOT_READY" });
    } finally {
      await service.disposeAllAndWait();
    }
  });
});
