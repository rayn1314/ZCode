// 任务纳入自动化体系（Phase A）：
// 模板形态（空 cronExpr=无调度仅手动）、objective/deadlineMs 持久化与校验、0004 迁移补列。
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AutomationRepo } from "../src/session/automationRepo.js";
import {
  AutomationService,
  InvalidAutomationDeadlineError,
} from "../src/session/automationService.js";
import type { ZCodeAutomationCreateParams } from "@zcode/shared";

function makeParams(
  overrides: Partial<ZCodeAutomationCreateParams> = {},
): ZCodeAutomationCreateParams {
  return {
    title: "目标任务",
    cronExpr: "0 9 * * *",
    prompt: "检查昨天的错误日志",
    workspacePath: "/tmp/ws",
    recurring: true,
    ...overrides,
  };
}

function buildTempDbPath(tempDir: string): string {
  return join(tempDir, "tasks-index.sqlite");
}

describe("任务纳入自动化体系：模板与截止字段", () => {
  let tempDir: string | null = null;
  let dbPath: string;
  let repo: AutomationRepo;
  let service: AutomationService;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "zcode-automation-goal-merge-"));
    dbPath = buildTempDbPath(tempDir);
    repo = new AutomationRepo(dbPath);
    service = new AutomationService(repo);
  });

  afterEach(() => {
    repo.close();
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  });

  it("模板形态：空 cronExpr 可创建，不入调度（nextRunAt=null）且仅手动", async () => {
    const created = await service.create(
      makeParams({ cronExpr: "", recurring: false, title: "纯模板" }),
    );
    expect(created.cronExpr).toBe("");
    expect(created.nextRunAt).toBeUndefined();
    expect(created.recurring).toBe(false);
    expect(created.lifecycleStatus).toBe("active");
    // 手动运行仍可用（runNow 创建 manual run）。
    const manual = await service.runNow(created.automationId, {
      workspacePath: "/tmp/ws",
    });
    expect(manual?.run.trigger).toBe("manual");
  });

  it("模板形态：空 cron 与相对延迟 / 周期 carrier 互斥，服务端拒绝", async () => {
    await expect(
      service.create(makeParams({ cronExpr: "", relativeDelayMinutes: 10, recurring: false })),
    ).rejects.toThrow(/模板任务/);
    await expect(
      service.create(makeParams({ cronExpr: "", intervalUnit: "hourly", interval: 3 })),
    ).rejects.toThrow(/模板任务/);
  });

  it("目标任务：objective 与 deadlineMs 持久化并可读回", async () => {
    const deadlineMs = Date.now() + 60 * 60_000;
    const created = await service.create(
      makeParams({
        objective: "修复登录页 bug",
        deadlineMs,
        cronExpr: "",
        recurring: false,
        title: "仅截止任务",
      }),
    );
    expect(created.objective).toBe("修复登录页 bug");
    expect(created.deadlineMs).toBe(deadlineMs);

    const listed = await service.list({ workspacePath: "/tmp/ws" });
    expect(listed[0]?.objective).toBe("修复登录页 bug");
    expect(listed[0]?.deadlineMs).toBe(deadlineMs);
  });

  it("deadlineMs 必须在未来：过去或当前时间在写库前被拒绝", async () => {
    await expect(
      service.create(makeParams({ deadlineMs: Date.now() - 1, cronExpr: "" })),
    ).rejects.toThrow(InvalidAutomationDeadlineError);
    await expect(
      service.create(makeParams({ deadlineMs: Date.now(), cronExpr: "" })),
    ).rejects.toThrow(InvalidAutomationDeadlineError);
  });

  it("update：可清空/修改 objective 与 deadlineMs；清除后读回为空", async () => {
    const deadlineMs = Date.now() + 60 * 60_000;
    const created = await service.create(
      makeParams({ objective: "目标 A", deadlineMs, cronExpr: "", recurring: false }),
    );
    const cleared = await service.update(
      created.automationId,
      { objective: null, deadlineMs: null },
      { workspacePath: "/tmp/ws" },
    );
    expect(cleared?.objective).toBeUndefined();
    expect(cleared?.deadlineMs).toBeUndefined();
  });

  it("update：deadlineMs 改成过去时间被拒绝", async () => {
    const created = await service.create(
      makeParams({
        objective: "目标 A",
        deadlineMs: Date.now() + 60 * 60_000,
        cronExpr: "",
        recurring: false,
      }),
    );
    await expect(
      service.update(
        created.automationId,
        { deadlineMs: Date.now() - 1 },
        { workspacePath: "/tmp/ws" },
      ),
    ).rejects.toThrow(InvalidAutomationDeadlineError);
  });

  it("update：cron 清空转模板，nextRunAt 清空且生命周期回 active", async () => {
    const created = await service.create(makeParams({}));
    expect(created.nextRunAt).not.toBeUndefined();
    const templated = await service.update(
      created.automationId,
      { cronExpr: "", recurring: false },
      { workspacePath: "/tmp/ws" },
    );
    expect(templated?.cronExpr).toBe("");
    expect(templated?.nextRunAt).toBeUndefined();
    expect(templated?.lifecycleStatus).toBe("active");
  });

  it("0004 迁移：初始化后 automations 已含 objective / deadline_ms 列", async () => {
    // 0001 冻结的 AUTOMATION_SCHEMA 不含新列；新库初始化 = 0001 建表后 0004 补列，
    // 与旧库升级路径等价（旧库已有 0001-0003 时只执行 0004）。直接断言初始化后列存在。
    await repo.ensureReady();
    const checkDb = new DatabaseSync(dbPath);
    const cols = checkDb.prepare("PRAGMA table_info(automations)").all() as Array<{
      name: string;
    }>;
    checkDb.close();
    expect(cols.some((c) => c.name === "objective")).toBe(true);
    expect(cols.some((c) => c.name === "deadline_ms")).toBe(true);
  });
});
